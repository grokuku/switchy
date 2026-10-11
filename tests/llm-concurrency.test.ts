/**
 * Concurrence PAR FOURNISSEUR — chaque compte a son propre « seau » de places
 * (`ProviderRecord.maxConcurrency`, sinon le défaut `SWITCHY_CONCURRENCY`).
 * File bornée (429 + Retry-After), priorité INTRINSÈQUE au service
 * (`prioritaire`), watchdog d'expiration, identifiants de slot uniques.
 * AUCUN réseau : `fetch` est mocké et « bloqué » par des portes contrôlées.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  waitFor,
  type TestEnv,
} from "./helpers.js";
import { llmSlots } from "../src/llm/slot-queue.js";

let env: TestEnv | null = null;
let mock: ReturnType<typeof installMockFetch> | null = null;

afterEach(() => {
  mock?.restore();
  env?.cleanup();
  env = null;
  mock = null;
});

/** Fournisseur `p1` + service `chat` (principal p1/model-a, sans repli). */
async function seedChat(target: TestEnv, overrides: Record<string, unknown> = {}): Promise<void> {
  await seedProvider(target.app, {
    id: "p1",
    label: "Fournisseur 1",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
    ...overrides,
  });
  await seedService(target.app, {
    name: "chat",
    description: "",
    principal: step("p1", "model-a"),
    fallbacks: [],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
  });
}

function gated(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

describe("compteurs PAR FOURNISSEUR (le cœur : deux comptes ne se limitent pas)", () => {
  it("un fournisseur saturé n'empêche PAS un autre fournisseur de servir", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "0" });
    await seedProvider(env.app, { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://p1.example/v1" });
    await seedProvider(env.app, { id: "p2", label: "P2", type: "openai-compatible", baseUrl: "https://p2.example/v1" });
    await seedService(env.app, {
      name: "a",
      description: "",
      principal: step("p1", "model-a"),
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    await seedService(env.app, {
      name: "b",
      description: "",
      principal: step("p2", "model-b"),
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });

    const { gate, open } = gated();
    mock = installMockFetch(async (url) => {
      if (url.includes("p1.example")) await gate; // seul p1 bloque
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app).post("/api/llm/a").send({ messages: [] }).then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    // p1 est plein, mais p2 a son propre seau : la requête passe immédiatement.
    const second = await api(env.app).post("/api/llm/b").send({ messages: [] });
    expect(second.status).toBe(200);

    open();
    expect((await first).status).toBe(200);
    expect(llmSlots.getStats().active).toBe(0);
  });

  it("la limite par défaut (SWITCHY_CONCURRENCY) s'applique au seau du fournisseur", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "0" });
    await seedChat(env);

    const { gate, open } = gated();
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app).post("/api/llm/chat").send({ messages: [] }).then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    const second = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("QUEUE_FULL");
    expect(second.headers["retry-after"]).toBe("5");

    open();
    expect((await first).status).toBe(200);
  });

  it("`maxConcurrency` du fournisseur surcharge le défaut (2 appels simultanés admis)", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "0" });
    await seedChat(env, { maxConcurrency: 2 });

    const { gate, open } = gated();
    let count = 0;
    mock = installMockFetch(async () => {
      count += 1;
      if (count <= 2) await gate;
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app).post("/api/llm/chat").send({ messages: [] }).then((r) => r);
    const second = api(env.app).post("/api/llm/chat").send({ messages: [] }).then((r) => r);
    await waitFor(() => mock!.calls.length === 2);

    // Le 3e dépasse le plafond du compte : refusé (file sans attente).
    const third = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(third.status).toBe(429);

    open();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });
});

describe("file bornée et watchdog", () => {
  it("file bornée : un 2e appel attend puis passe quand le slot se libère", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "5", SWITCHY_QUEUE_TIMEOUT_MS: "5000" });
    await seedChat(env);

    const { gate, open } = gated();
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app).post("/api/llm/chat").send({ messages: [] }).then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    let secondDone = false;
    const second = api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [] })
      .then((r) => {
        secondDone = true;
        return r;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondDone).toBe(false); // en file, pas rejeté
    expect(llmSlots.getStats().queued).toBe(1);

    open();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(llmSlots.getStats().active).toBe(0);
  });

  it("expiration d'un slot bloqué (watchdog) : libéré de force, release ultérieur sans effet", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_SLOT_WATCHDOG_MS: "1000" });

    const staleKey = await llmSlots.acquire({ service: "s", provider: "p1", limit: 1, prioritaire: false });
    expect(llmSlots.getStats().active).toBe(1);

    const freed = llmSlots.forceReleaseStale(Date.now() + 2000);
    expect(freed).toEqual([staleKey]);
    expect(llmSlots.getStats().active).toBe(0);

    llmSlots.release(staleKey); // no-op idempotent
    expect(llmSlots.getStats().active).toBe(0);

    const freshKey = await llmSlots.acquire({ service: "s", provider: "p1", limit: 1, prioritaire: false });
    expect(freshKey).not.toBe(staleKey);
    llmSlots.release(freshKey);
  });

  it("identifiant de slot unique et interne par appel (jamais une clé métier)", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "2" });
    const a = await llmSlots.acquire({ service: "s", provider: "p1", limit: 2, prioritaire: false });
    const b = await llmSlots.acquire({ service: "s", provider: "p1", limit: 2, prioritaire: false });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^llm:[0-9a-f-]{36}$/);
    llmSlots.release(a);
    llmSlots.release(b);
  });
});

describe("priorité intrinsèque au service (`prioritaire`) — sans en-tête client", () => {
  it("un appel d'un service prioritaire passe avant un appel ordinaire", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "10" });
    await seedProvider(env.app, { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://p1.example/v1" });
    await seedService(env.app, {
      name: "lourd",
      description: "",
      principal: step("p1", "model-lourd"),
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      prioritaire: false,
      enabled: true,
    });
    await seedService(env.app, {
      name: "leger",
      description: "",
      principal: step("p1", "model-leger"),
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      prioritaire: true,
      enabled: true,
    });

    const { gate, open } = gated();
    let callCount = 0;
    mock = installMockFetch(async () => {
      callCount += 1;
      if (callCount === 1) await gate; // seul le 1er appel bloque
      return jsonResponse({ choices: [] });
    });

    // Aucun en-tête X-Switchy-Class : la priorité vient du service.
    const first = api(env.app).post("/api/llm/lourd").send({ messages: [] }).then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    const heavy = api(env.app).post("/api/llm/lourd").send({ messages: [] }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const light = api(env.app).post("/api/llm/leger").send({ messages: [] }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(llmSlots.getStats().queued).toBe(2);

    open();
    await Promise.all([first, heavy, light]);
    const models = mock!.calls.map((c) => (JSON.parse(c.init.body ?? "{}") as { model?: string }).model);
    expect(models).toEqual(["model-lourd", "model-leger", "model-lourd"]);
  });
});
