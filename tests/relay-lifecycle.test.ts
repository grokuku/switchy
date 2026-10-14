import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { api, makeTestEnv, installMockFetch, seedProvider, seedService, step, jsonResponse, waitFor, type TestEnv } from "./helpers.js";
import { setAdminPassword, verifyAdminPassword } from "../src/session-store.js";
import { settingsFilePath, resetSettingsCache } from "../src/settings-store.js";
import { instrumentStream, relayServiceChat, UpstreamFailure } from "../src/llm/relay.js";
import { llmSlots, ProviderSlotQueue } from "../src/llm/slot-queue.js";
import { updateProvider } from "../src/catalog-store.js";

let env: TestEnv | undefined;
let mock: ReturnType<typeof installMockFetch> | undefined;
afterEach(() => { mock?.restore(); env?.cleanup(); vi.restoreAllMocks(); mock = undefined; env = undefined; });

async function seed(maxConcurrency = 1): Promise<void> {
  await seedProvider(env!.app, { id: "p", label: "P", type: "ollama-native", baseUrl: "http://provider.invalid/v1", maxConcurrency });
  await seedService(env!.app, { name: "s", description: "", principal: step("p", "m"), fallbacks: [], contextWindow: 8000, maxOutputTokens: 1000, vision: false });
}
const request = { service: "s", provider: "p", limit: 1, prioritaire: false };

describe("configuration illisible : connexion refusée", () => {
  it("répond 503 au login et n'émet aucune session", async () => {
    env = makeTestEnv();
    setAdminPassword("custom-password");
    const initial = await api(env.app).get("/api/session");
    const cookies = initial.headers["set-cookie"] as unknown as string[];
    writeFileSync(settingsFilePath(), "{broken");
    resetSettingsCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await api(env.app).post("/api/session/login")
      .set("Cookie", cookies.map(c => c.split(";")[0]).join("; "))
      .set("X-CSRF-Token", initial.body.csrfToken).send({ password: "admin" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CONFIG_UNREADABLE");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
  it.each(["{broken", "null", "[]"])("ne réactive pas admin pour %s", (contents) => {
    env = makeTestEnv();
    setAdminPassword("custom-password");
    expect(verifyAdminPassword("admin")).toBe(false);
    writeFileSync(settingsFilePath(), contents);
    resetSettingsCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => verifyAdminPassword("admin")).toThrow(expect.objectContaining({ code: "CONFIG_UNREADABLE", status: 503 }));
    expect(() => verifyAdminPassword("custom-password")).toThrow();
  });
});

describe("flux : lecture bornée et annulation", () => {
  it("ne consomme pas tout l'amont avant la lecture du client", async () => {
    let produced = 0;
    const finish = vi.fn();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(c) { produced++; c.enqueue(new Uint8Array(1024)); if (produced === 100) c.close(); }, cancel,
    });
    const output = instrumentStream(source, () => false, finish);
    await new Promise(r => setTimeout(r, 10));
    expect(produced).toBeLessThanOrEqual(2);
    expect(finish).not.toHaveBeenCalled();
    const reader = output.getReader();
    expect((await reader.read()).value?.length).toBe(1024);
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(finish.mock.calls[0][0].aborted).toBe(true);
  });

  it("annule un flux sans lecteur et attend la terminaison de l'amont", async () => {
    const signal = new AbortController();
    let complete!: () => void;
    const cancellation = new Promise<void>(r => { complete = r; });
    const cancel = vi.fn(() => cancellation);
    const finish = vi.fn();
    const output = instrumentStream(new ReadableStream({ cancel }), () => signal.signal.aborted, finish, signal.signal);
    signal.abort();
    expect(cancel).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    complete();
    await waitFor(() => finish.mock.calls.length === 1);
    await expect(output.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("file d'attente : annulation et limites à chaud", () => {
  it("nettoie la file à l'expiration de l'attente", async () => {
    env = makeTestEnv({ SWITCHY_QUEUE_TIMEOUT_MS: "10" });
    const queue = new ProviderSlotQueue();
    const held = await queue.acquire(request);
    await expect(queue.acquire(request)).rejects.toMatchObject({ name: "QueueTimeoutError" });
    expect(queue.getStats().queued).toBe(0);
    queue.release(held);
  });

  it("sert tous les prioritaires avant les ordinaires si plusieurs places se libèrent", async () => {
    env = makeTestEnv({ SWITCHY_SLOT_WATCHDOG_MS: "1000" });
    const queue = new ProviderSlotQueue();
    const req = { ...request, limit: 2 };
    await queue.acquire(req);
    await queue.acquire(req);
    const normal = queue.acquire(req);
    const a = queue.acquire({ ...req, prioritaire: true });
    const b = queue.acquire({ ...req, prioritaire: true });
    queue.forceReleaseStale(Date.now() + 2000);
    expect(queue.getStats()).toMatchObject({ activePriority: 2, activeNormal: 0, queuedNormal: 1 });
    queue.release(await a);
    queue.release(await b);
    queue.release(await normal);
  });
  it("retire immédiatement un appel déconnecté, sans attendre de place", async () => {
    env = makeTestEnv({ SWITCHY_QUEUE_TIMEOUT_MS: "0" });
    await seed();
    const held = await llmSlots.acquire(request);
    const controller = new AbortController();
    const call = relayServiceChat({ serviceName: "s", body: { messages: [] }, headers: {}, signal: controller.signal });
    const failed = expect(call).rejects.toBeInstanceOf(UpstreamFailure);
    expect(llmSlots.getStats().queued).toBe(1);
    controller.abort();
    await failed;
    expect(llmSlots.getStats().queued).toBe(0);
    llmSlots.release(held);
  });

  it("refuse une acquisition avec un signal déjà annulé", async () => {
    const queue = new ProviderSlotQueue();
    await expect(queue.acquire({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.getStats().active).toBe(0);
  });

  it("applique une réduction de limite aux appels déjà en attente", async () => {
    env = makeTestEnv();
    await seed(2);
    const req = { ...request, limit: 2 };
    const a = await llmSlots.acquire(req);
    const b = await llmSlots.acquire(req);
    const waiting = llmSlots.acquire(req);
    updateProvider("p", { maxConcurrency: 1 });
    llmSlots.release(a);
    expect(llmSlots.getStats()).toMatchObject({ active: 1, queued: 1 });
    llmSlots.release(b);
    llmSlots.release(await waiting);
  });

  it("le watchdog attend la terminaison avant de servir le suivant", async () => {
    env = makeTestEnv({ SWITCHY_SLOT_WATCHDOG_MS: "1000" });
    await seed();
    let upstreamSignal: AbortSignal | undefined;
    let stop!: () => void;
    let calls = 0;
    mock = installMockFetch(async (_url, init) => {
      if (++calls === 1) {
        upstreamSignal = init.signal;
        await new Promise<void>(r => { stop = r; });
        upstreamSignal!.throwIfAborted();
      }
      return jsonResponse({ choices: [] });
    });
    const first = relayServiceChat({ serviceName: "s", body: {}, headers: {} });
    const failed = expect(first).rejects.toBeInstanceOf(UpstreamFailure);
    await waitFor(() => calls === 1);
    const second = relayServiceChat({ serviceName: "s", body: {}, headers: {} });
    llmSlots.forceReleaseStale(Date.now() + 2000);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(llmSlots.getStats()).toMatchObject({ active: 1, queued: 1 });
    expect(calls).toBe(1);
    stop();
    await failed;
    expect((await second).status).toBe(200);
    expect(llmSlots.getStats().active).toBe(0);
  });
});

describe("relais natif : mêmes places que les services", () => {
  it("libère la place en cas d'échec réseau", async () => {
    env = makeTestEnv();
    await seed();
    mock = installMockFetch(() => { throw new Error("network down"); });
    const res = await api(env.app).post("/api/native/p/api/chat").send({ model: "m" });
    expect(res.status).toBe(500);
    expect(llmSlots.getStats().active).toBe(0);
    const log = await api(env.app).get("/api/calls");
    expect(log.body.entries[0]).toMatchObject({ result: "error", reason: "network_error", provider: "p" });
  });
  it("retourne 429 si le compte est déjà saturé par un service", async () => {
    env = makeTestEnv({ SWITCHY_QUEUE_MAX: "0" });
    await seed();
    const held = await llmSlots.acquire(request);
    mock = installMockFetch(() => jsonResponse({ done: true }));
    const res = await api(env.app).post("/api/native/p/api/chat").send({ model: "m", messages: [] });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("QUEUE_FULL");
    expect(res.headers["retry-after"]).toBe("5");
    expect(mock.calls).toHaveLength(0);
    llmSlots.release(held);
  });

  it("garde la place jusqu'à la fin du flux natif", async () => {
    env = makeTestEnv({ SWITCHY_QUEUE_MAX: "0" });
    await seed();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    mock = installMockFetch(() => new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; } }), { headers: { "content-type": "application/x-ndjson" } }));
    const first = api(env.app).post("/api/native/p/api/generate").send({ model: "m" }).then(r => r);
    await waitFor(() => mock!.calls.length === 1);
    expect(llmSlots.getStats().active).toBe(1);
    const second = await api(env.app).post("/api/llm/s").send({ messages: [] });
    expect(second.status).toBe(429);
    source.enqueue(new TextEncoder().encode('{"done":true}\n'));
    source.close();
    expect((await first).status).toBe(200);
    expect(llmSlots.getStats().active).toBe(0);
  });
});
