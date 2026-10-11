/**
 * Tableau de bord « Activité » (Lot 5) — route `GET /api/dashboard`, agrégation
 * des tokens (par service / par fournisseur / total, gestion de l'inconnu),
 * résumé 24 h (appels / réussite / replis / latence), état de la file par
 * fournisseur, et non-régression de `GET /api/calls`.
 *
 * AUCUN réseau : `fetch` est mocké, le reste est écrit directement dans le
 * journal (`calls.jsonl`) d'un répertoire de données temporaire.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  type TestEnv,
} from "./helpers.js";
import {
  resetCallsLogState,
  summarizeActivity,
  summarizeTokens,
  type CallLogEntry,
} from "../src/llm/calls-log.js";
import { normalizeUsage } from "../src/llm/relay.js";
import { llmSlots } from "../src/llm/slot-queue.js";

let env: TestEnv;
let mock: ReturnType<typeof installMockFetch> | null = null;

beforeEach(() => {
  env = makeTestEnv();
  mock = null;
});

afterEach(() => {
  mock?.restore();
  env.cleanup();
});

const ISO = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

/** Écrit le journal du répertoire de test puis vide les compteurs mémoire. */
function writeLog(entries: Array<Partial<CallLogEntry>>): void {
  writeFileSync(join(env.dir, "calls.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  resetCallsLogState();
}

async function seedOllama(): Promise<void> {
  await seedProvider(env.app, {
    id: "ollama",
    label: "Ollama",
    type: "openai-compatible",
    baseUrl: "https://ollama.example/v1",
  });
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: step("ollama", "llama3"),
    fallbacks: [],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
  });
}

// ── Route ────────────────────────────────────────────────────────────────

describe("GET /api/dashboard — protégée et forme complète", () => {
  it("sans clé ni session → 401 JSON (jamais l'index)", async () => {
    const res = await request(env.app).get("/api/dashboard");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("une SEULE réponse porte tout l'onglet (live, activity, tokens, recent)", async () => {
    await seedOllama();
    mock = installMockFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "salut" } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );

    const call = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(call.status).toBe(200);

    const dash = await api(env.app).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.windowHours).toBe(24);
    expect(typeof dash.body.generatedAt).toBe("string");

    // ① concurrence : fournisseur configuré, plafond par défaut (3), au repos.
    expect(dash.body.live.providers).toHaveLength(1);
    expect(dash.body.live.providers[0]).toMatchObject({
      id: "ollama",
      label: "Ollama",
      limit: 3,
      active: 0,
      queued: 0,
      state: "free",
    });
    expect(dash.body.live).toMatchObject({ active: 0, queued: 0 });

    // ② résumé 24 h.
    expect(dash.body.activity).toMatchObject({
      calls: 1,
      attempts: 1,
      succeeded: 1,
      successRate: 1,
      fallbacks: 0,
      fallbackRate: 0,
    });

    // ③ tokens : réflexion exposée par le fournisseur.
    expect(dash.body.tokens.total).toEqual({ calls: 1, prompt: 12, completion: 8, reasoning: 3 });
    expect(dash.body.tokens.byProvider.ollama).toEqual({ calls: 1, prompt: 12, completion: 8, reasoning: 3 });
    expect(dash.body.tokens.byService.chat).toEqual({ calls: 1, prompt: 12, completion: 8, reasoning: 3 });

    // ④ derniers appels — jamais de clé ni de prompt.
    expect(dash.body.recent).toHaveLength(1);
    expect(dash.body.recent[0]).toMatchObject({
      service: "chat",
      provider: "ollama",
      result: "ok",
      isFallback: false,
    });
    expect(JSON.stringify(dash.body)).not.toContain("sk-");
  });
});

// ── Agrégation des tokens ─────────────────────────────────────────────────

describe("tokens — total, par service, par fournisseur, gestion de l'inconnu", () => {
  it("additionne champ par champ et laisse `null` ce qu'aucune tentative n'expose", () => {
    const entries: CallLogEntry[] = [
      { ts: ISO(3_600_000), service: "chat", attempt: 0, provider: "ollama", model: "m", result: "ok", durationMs: 10,
        tokens: { promptTokens: 100, completionTokens: 50, reasoningTokens: 20 } },
      { ts: ISO(1_800_000), service: "chat", attempt: 0, provider: "ollama", model: "m", result: "ok", durationMs: 10,
        tokens: { promptTokens: 5, completionTokens: 2 } }, // pas de réflexion
      { ts: ISO(900_000), service: "chat", attempt: 1, provider: "deepseek", model: "m", result: "ok", isFallback: true, durationMs: 10,
        tokens: { promptTokens: 10, completionTokens: 5, reasoningTokens: 7 } },
      // Fournisseur qui ne détaille QUE la sortie : l'entrée et la réflexion restent inconnues.
      { ts: ISO(600_000), service: "autre", attempt: 0, provider: "bare", model: "m", result: "ok", durationMs: 10,
        tokens: { completionTokens: 4 } },
      // Aucun usage rapporté : ne crée PAS de ligne de tokens.
      { ts: ISO(300_000), service: "chat", attempt: 1, provider: "deepseek", model: "m", result: "skipped", isFallback: true, durationMs: 0 },
    ];

    const tokens = summarizeTokens(entries, 24, Date.now());
    expect(tokens.total).toEqual({ calls: 4, prompt: 115, completion: 61, reasoning: 27 });
    expect(tokens.byService.chat).toEqual({ calls: 3, prompt: 115, completion: 57, reasoning: 27 });
    expect(tokens.byService.autre).toEqual({ calls: 1, prompt: null, completion: 4, reasoning: null });
    expect(tokens.byProvider.ollama).toEqual({ calls: 2, prompt: 105, completion: 52, reasoning: 20 });
    expect(tokens.byProvider.deepseek).toEqual({ calls: 1, prompt: 10, completion: 5, reasoning: 7 });
    expect(tokens.byProvider.bare).toEqual({ calls: 1, prompt: null, completion: 4, reasoning: null });
  });

  it("la fenêtre borne l'agrégation : les tentatives de plus de 24 h sont exclues", () => {
    const entries: CallLogEntry[] = [
      { ts: ISO(1_000), service: "chat", attempt: 0, provider: "ollama", model: "m", result: "ok", durationMs: 1,
        tokens: { promptTokens: 4, completionTokens: 2, reasoningTokens: 1 } },
      { ts: ISO(30 * 3_600_000), service: "chat", attempt: 0, provider: "ollama", model: "m", result: "ok", durationMs: 1,
        tokens: { promptTokens: 999, completionTokens: 999, reasoningTokens: 999 } },
    ];
    const tokens = summarizeTokens(entries, 24, Date.now());
    expect(tokens.total).toEqual({ calls: 1, prompt: 4, completion: 2, reasoning: 1 });
  });

  it("normalizeUsage : extrait la réflexion, et l'omet quand elle n'est pas exposée", () => {
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } })).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      reasoningTokens: 3,
    });
    // Analyse de raisonnement à zéro = valeur CONNUE (0), pas un inconnu.
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } })).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      reasoningTokens: 0,
    });
    // Fournisseur sans détail de réflexion : le champ est ABSENT (→ « — » à l'écran).
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 })).toEqual({ promptTokens: 1, completionTokens: 2 });
  });
});

// ── Résumé 24 h ───────────────────────────────────────────────────────────

describe("résumé 24 h — appels, réussite, replis, latence", () => {
  it("compte les appels LOGIQUES (un repli n'est pas un appel de plus) et exclut l'ancien", () => {
    const entries: CallLogEntry[] = [
      // Appel « a » : échec du principal puis succès du repli → 1 appel repliés.
      { ts: ISO(3_600_000), callId: "a", service: "chat", attempt: 0, provider: "p1", model: "m", result: "error", durationMs: 100 },
      { ts: ISO(3_600_000), callId: "a", service: "chat", attempt: 1, provider: "p2", model: "m", result: "ok", isFallback: true, durationMs: 200 },
      // Appel « b » : succès direct.
      { ts: ISO(1_800_000), callId: "b", service: "chat", attempt: 0, provider: "p1", model: "m", result: "ok", durationMs: 300 },
      // Appel « c » : échec sans repli.
      { ts: ISO(600_000), callId: "c", service: "chat", attempt: 0, provider: "p1", model: "m", result: "error", durationMs: 50 },
      // Hors fenêtre : ignoré.
      { ts: ISO(25 * 3_600_000), callId: "old", service: "chat", attempt: 0, provider: "p1", model: "m", result: "ok", durationMs: 999 },
    ];

    const summary = summarizeActivity(entries, 24, Date.now());
    expect(summary).toMatchObject({
      calls: 3,
      attempts: 4,
      succeeded: 2,
      failed: 1,
      fallbacks: 1,
      fallbackAttempts: 1,
    });
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.fallbackRate).toBeCloseTo(1 / 3);
    // Latence = tentatives RÉUSSIES de la fenêtre (200 et 300 ms).
    expect(summary.latency).toEqual({ avgMs: 250, maxMs: 300, samples: 2 });
  });

  it("journal vide : taux à null (affichés « — »), jamais une division par zéro", () => {
    const summary = summarizeActivity([], 24, Date.now());
    expect(summary).toMatchObject({ calls: 0, attempts: 0, succeeded: 0, fallbacks: 0 });
    expect(summary.successRate).toBeNull();
    expect(summary.fallbackRate).toBeNull();
    expect(summary.latency).toEqual({ avgMs: null, maxMs: null, samples: 0 });
  });
});

// ── État de la file par fournisseur ───────────────────────────────────────

describe("état de la file (getter providerStates) — occupées / total / en attente", () => {
  it("reflète les places occupées et les appels en attente, par fournisseur", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "P1",
      type: "openai-compatible",
      baseUrl: "https://p1.example/v1",
      maxConcurrency: 1,
    });
    await seedProvider(env.app, { id: "p2", label: "P2", type: "openai-compatible", baseUrl: "https://p2.example/v1" });

    const first = await llmSlots.acquire({ service: "s", provider: "p1", limit: 1, prioritaire: false });
    // P1 est plein : ce 2e appel attend dans SA file.
    const waiting = llmSlots.acquire({ service: "s", provider: "p1", limit: 1, prioritaire: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const dash = await api(env.app).get("/api/dashboard");
    const p1 = (dash.body.live.providers as Array<Record<string, unknown>>).find((p) => p.id === "p1");
    const p2 = (dash.body.live.providers as Array<Record<string, unknown>>).find((p) => p.id === "p2");
    expect(p1).toMatchObject({ limit: 1, active: 1, queued: 1, state: "saturated" });
    // P2 n'a AUCUNE activité : présent à zéro, plafond par défaut (3), libre.
    expect(p2).toMatchObject({ limit: 3, active: 0, queued: 0, state: "free" });
    expect(dash.body.live).toMatchObject({ active: 1, queued: 1 });

    // Libération : le waiter acquiert une place → on la relâche pour rester propre.
    llmSlots.release(first);
    llmSlots.release(await waiting);
  });
});

// ── Non-régression ────────────────────────────────────────────────────────

describe("non-régression de GET /api/calls", () => {
  it("le journal et son résumé de replis sont inchangés", async () => {
    await seedProvider(env.app, { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://p1.example/v1" });
    await seedProvider(env.app, { id: "p2", label: "P2", type: "openai-compatible", baseUrl: "https://p2.example/v1" });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: step("p1", "model-a"),
      fallbacks: [step("p2", "model-b")],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch((url) =>
      url.includes("p1.example") ? jsonResponse({ error: "boom" }, { status: 500 }) : jsonResponse({ choices: [] }),
    );
    await api(env.app).post("/api/llm/chat").send({ messages: [] });

    const page = await api(env.app).get("/api/calls?limit=1");
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(2);
    expect(page.body.summary.byFallbackProvider).toEqual({ p2: 1 });
    expect(page.body.entries[0]).toMatchObject({ attempt: 1, isFallback: true, provider: "p2" });
  });
});
