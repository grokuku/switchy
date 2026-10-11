/**
 * Compteur global de concurrence (Lot 3) — limite `SWITCHY_CONCURRENCY`, file
 * bornée (429 + Retry-After), réservations par service, priorité des appels
 * légers, watchdog d'expiration, identifiants de slot uniques. Aucun réseau :
 * `fetch` est mocké et « bloqué » par des portes contrôlées par le test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

async function seedChat(target: TestEnv): Promise<void> {
  await seedProvider(target.app, {
    id: "p1",
    label: "Fournisseur 1",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
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

describe("limite globale + file bornée", () => {
  it("429 + Retry-After quand la limite est atteinte (file sans attente) ; slot libéré ensuite", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "0" });
    await seedChat(env);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    const first = api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [] })
      .then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    const second = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("QUEUE_FULL");
    expect(second.headers["retry-after"]).toBe("5");
    expect(second.body.retryAfterMs).toBeGreaterThan(0);

    openGate();
    const firstResult = await first;
    expect(firstResult.status).toBe(200);

    // Slot libéré : l'appel suivant passe.
    const third = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(third.status).toBe(200);
  });

  it("file bornée : un 2e appel attend puis passe quand le slot se libère", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "5", SWITCHY_QUEUE_TIMEOUT_MS: "5000" });
    await seedChat(env);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [] })
      .then((r) => r);
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

    openGate();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(llmSlots.getStats().active).toBe(0);
  });

  it("expiration d'un slot bloqué (watchdog) : libéré de force, release ultérieur sans effet", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_SLOT_WATCHDOG_MS: "1000" });

    const staleKey = await llmSlots.acquire({ service: "s", cls: "heavy" });
    expect(llmSlots.getStats().active).toBe(1);

    const freed = llmSlots.forceReleaseStale(Date.now() + 2000);
    expect(freed).toEqual([staleKey]);
    expect(llmSlots.getStats().active).toBe(0);

    llmSlots.release(staleKey); // no-op idempotent
    expect(llmSlots.getStats().active).toBe(0);

    const freshKey = await llmSlots.acquire({ service: "s", cls: "heavy" });
    expect(freshKey).not.toBe(staleKey);
    llmSlots.release(freshKey);
  });

  it("identifiant de slot unique et interne par appel (jamais une clé métier)", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "2" });
    const a = await llmSlots.acquire({ service: "s", cls: "heavy" });
    const b = await llmSlots.acquire({ service: "s", cls: "heavy" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^llm:[0-9a-f-]{36}$/);
    llmSlots.release(a);
    llmSlots.release(b);
  });
});

describe("réservations et priorité de classe", () => {
  it("réservations : `light: 1` borne la simultanéité des appels légers du service", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "3", SWITCHY_QUEUE_MAX: "10" });
    await seedChat(env);
    // Ajoute les réservations au service créé.
    await api(env.app)
      .put("/api/services/chat")
      .send({ reservations: { light: 1 } });

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app)
      .post("/api/llm/chat")
      .set("X-Switchy-Class", "light")
      .send({ messages: [] })
      .then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    let secondDone = false;
    const second = api(env.app)
      .post("/api/llm/chat")
      .set("X-Switchy-Class", "light")
      .send({ messages: [] })
      .then((r) => {
        secondDone = true;
        return r;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondDone).toBe(false); // quota light atteint : en file

    openGate();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("priorité : un appel light en attente passe avant un heavy (le léger n'attend pas derrière le lourd)", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "10" });
    await seedProvider(env.app, {
      id: "p1",
      label: "Fournisseur 1",
      type: "openai-compatible",
      baseUrl: "https://p1.example/v1",
    });
    await seedService(env.app, {
      name: "lourd",
      description: "",
      principal: step("p1", "model-lourd"),
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
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
      enabled: true,
    });

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let callCount = 0;
    mock = installMockFetch(async () => {
      callCount += 1;
      if (callCount === 1) await gate; // seul le 1er appel (lourd) bloque
      return jsonResponse({ choices: [] });
    });

    const first = api(env.app)
      .post("/api/llm/lourd")
      .set("X-Switchy-Class", "heavy")
      .send({ messages: [] })
      .then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    // Deux demandes en attente : un heavy d'abord, puis un light.
    const heavy = api(env.app)
      .post("/api/llm/lourd")
      .set("X-Switchy-Class", "heavy")
      .send({ messages: [] })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const light = api(env.app)
      .post("/api/llm/leger")
      .set("X-Switchy-Class", "light")
      .send({ messages: [] })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(llmSlots.getStats().queued).toBe(2);

    openGate();
    await Promise.all([first, heavy, light]);
    const models = mock!.calls.map((c) => (JSON.parse(c.init.body ?? "{}") as { model?: string }).model);
    expect(models).toEqual(["model-lourd", "model-leger", "model-lourd"]);
  });

  it("classe par défaut = heavy (sans en-tête X-Switchy-Class)", async () => {
    env = makeTestEnv({ SWITCHY_CONCURRENCY: "1", SWITCHY_QUEUE_MAX: "0" });
    await seedChat(env);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [] });
    });
    const first = api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [] })
      .then((r) => r);
    await waitFor(() => mock!.calls.length === 1);

    const second = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(second.status).toBe(429); // défaut heavy, file pleine

    openGate();
    await first;
  });
});
