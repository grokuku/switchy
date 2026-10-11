/**
 * Repli Ollama → DeepSeek : verrouillage du scénario réel d'usage.
 *
 * Le service principal (Ollama Cloud) répond `429` (quota hebdomadaire épuisé)
 * → Switchy bascule sur le repli (DeepSeek). On verrouille :
 *   - `429` → repli, réponse du repli, les DEUX tentatives journalisées ;
 *   - un corps « weekly usage limit » est classé `quota` (jamais journalisé) ;
 *   - `401`/`403` ne déclenchent PAS de repli payant (motif `auth_error`) ;
 *   - `callId` commun aux tentatives d'un appel, distinct entre deux appels ;
 *   - motifs catégorisés (`rate_limit`, `overloaded`, `network_error`) ;
 *   - compteur de replis dans `GET /api/calls`.
 *
 * AUCUN accès réseau : `globalThis.fetch` est mocké.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "fs";
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

function logFile(): string {
  return join(env.dir, "calls.jsonl");
}

function readLog(): Array<Record<string, unknown>> {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Principal `p1` + repli `p2` (miroir du scénario Ollama → DeepSeek). */
async function seedChain(): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Ollama Cloud",
    type: "openai-compatible",
    baseUrl: "https://ollama.example/v1",
    apiKey: "sk-OLLAMA_SECRET",
  });
  await seedProvider(env.app, {
    id: "p2",
    label: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://deepseek.example/v1",
    apiKey: "sk-DEEPSEEK_SECRET",
  });
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: step("p1", "ollama-model"),
    fallbacks: [step("p2", "deepseek-chat")],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
  });
}

describe("repli — quota hebdomadaire (429)", () => {
  it("429 du principal → bascule sur le repli + réponse + DEUX tentatives journalisées", async () => {
    await seedChain();
    mock = installMockFetch((url) =>
      url.includes("ollama.example")
        ? jsonResponse({ message: "too many requests", type: "api_error" }, { status: 429 })
        : jsonResponse({ choices: [{ message: { content: "secours DeepSeek" } }] }),
    );

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("secours DeepSeek");
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://ollama.example/v1/chat/completions",
      "https://deepseek.example/v1/chat/completions",
    ]);

    const log = readLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      service: "chat",
      attempt: 0,
      isFallback: false,
      provider: "p1",
      model: "ollama-model",
      result: "error",
      status: 429,
      reason: "rate_limit",
    });
    expect(log[1]).toMatchObject({
      service: "chat",
      attempt: 1,
      isFallback: true,
      provider: "p2",
      model: "deepseek-chat",
      result: "ok",
      status: 200,
    });
    // callId commun = un seul appel logique constatable sans corrélation manuelle.
    expect(typeof log[0].callId).toBe("string");
    expect(log[0].callId).toBe(log[1].callId);
  });

  it("429 avec le corps réel Ollama (« weekly usage limit ») → repli, motif `quota`, corps JAMAIS journalisé", async () => {
    await seedChain();
    mock = installMockFetch((url) =>
      url.includes("ollama.example")
        ? jsonResponse(
            { message: "you (Holaf) have reached your weekly usage limit, upgrade for more", type: "api_error" },
            { status: 429 },
          )
        : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);

    const log = readLog();
    expect(log[0]).toMatchObject({ attempt: 0, status: 429, reason: "quota" });
    expect(log[1]).toMatchObject({ attempt: 1, isFallback: true, result: "ok" });

    // ⚠️ Le motif est CATÉGORISÉ : jamais le corps, jamais un secret.
    const raw = readFileSync(logFile(), "utf-8");
    expect(raw).not.toContain("weekly usage limit");
    expect(raw).not.toContain("Holaf");
    expect(raw).not.toContain("sk-OLLAMA_SECRET");
    expect(raw).not.toContain("sk-DEEPSEEK_SECRET");
    expect(raw).toContain('"reason":"quota"');
  });
});

describe("repli — 401/403 (clé invalide) : PAS de repli payant", () => {
  it("401 du principal → AUCUN repli, l'erreur est relayée telle quelle, motif `auth_error`", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: "invalid api key" }, { status: 401 }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(401);
    // Le repli payant n'a PAS été sollicité : une clé invalide ne se « répare »
    // pas chez le fournisseur suivant.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("ollama.example");

    const log = readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ attempt: 0, provider: "p1", result: "error", status: 401, reason: "auth_error" });
  });

  it("403 du principal → AUCUN repli, motif `auth_error`", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: "forbidden" }, { status: 403 }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(403);
    expect(mock.calls).toHaveLength(1);

    const log = readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 403, reason: "auth_error" });
  });
});

describe("repli — 400 : erreur de requête, toujours PAS de repli", () => {
  it("400 → aucun repli (non-régression)", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: { message: "bad request" } }, { status: 400 }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(400);
    expect(mock.calls).toHaveLength(1);
    expect(readLog()).toHaveLength(1);
    expect(readLog()[0]).toMatchObject({ status: 400, reason: "upstream_error" });
  });
});

describe("repli — motifs catégorisés", () => {
  it("503 → motif `overloaded`", async () => {
    await seedChain();
    mock = installMockFetch((url) =>
      url.includes("ollama.example")
        ? jsonResponse({ error: "unavailable" }, { status: 503 })
        : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(200);
    expect(readLog()[0]).toMatchObject({ status: 503, reason: "overloaded", isFallback: false });
  });

  it("échec réseau (fetch rejette) → motif `network_error` puis repli", async () => {
    await seedChain();
    mock = installMockFetch((url) => {
      if (url.includes("ollama.example")) throw new Error("ECONNREFUSED");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(200);
    const log = readLog();
    expect(log[0]).toMatchObject({ attempt: 0, result: "error", reason: "network_error" });
    expect(log[1]).toMatchObject({ attempt: 1, isFallback: true, result: "ok" });
    expect(log[0].callId).toBe(log[1].callId);
  });
});

describe("repli — identifiant d'appel (callId)", () => {
  it("identique entre les tentatives d'un appel, DIFFÉRENT entre deux appels", async () => {
    await seedChain();
    mock = installMockFetch((url) =>
      url.includes("ollama.example")
        ? jsonResponse({ error: "boom" }, { status: 500 })
        : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    await api(env.app).post("/api/llm/chat").send({ messages: [] });
    await api(env.app).post("/api/llm/chat").send({ messages: [] });

    const log = readLog();
    expect(log).toHaveLength(4);
    const [c1a, c1b, c2a, c2b] = log.map((e) => e.callId);
    expect(typeof c1a).toBe("string");
    expect(c1a).toBe(c1b); // même appel
    expect(c2a).toBe(c2b); // même appel (2ᵉ)
    expect(c1a).not.toBe(c2a); // deux appels distincts
  });
});

describe("repli — compteur exposé par GET /api/calls", () => {
  it("répartition par service et par fournisseur de repli, dernier 24 h et total", async () => {
    await seedChain();
    mock = installMockFetch((url) =>
      url.includes("ollama.example")
        ? jsonResponse({ message: "reached your weekly usage limit", type: "api_error" }, { status: 429 })
        : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    await api(env.app).post("/api/llm/chat").send({ messages: [] });

    const page = await api(env.app).get("/api/calls");
    expect(page.status).toBe(200);
    expect(page.body.summary).toMatchObject({
      windowHours: 24,
      total: 1,
      last24h: 1,
      byService: { chat: 1 },
      byFallbackProvider: { p2: 1 },
      reasons: { quota: 1 },
    });
  });

  it("journal absent → summary vide mais bien formé", async () => {
    const page = await api(env.app).get("/api/calls");
    expect(page.body.summary).toMatchObject({
      windowHours: 24,
      total: 0,
      last24h: 0,
      byService: {},
      byFallbackProvider: {},
      reasons: {},
    });
  });

  it("entrées ANTÉRIEURES (sans callId/reason/isFallback) restent lisibles et comptées", async () => {
    // Format du journal AVANT ce lot : seuls ts/service/attempt/provider/model/result.
    const old = { ts: new Date().toISOString(), service: "chat", attempt: 1, provider: "p2", model: "m", result: "ok", durationMs: 3 };
    writeFileSync(logFile(), `${JSON.stringify(old)}\n`);

    const page = await api(env.app).get("/api/calls");
    expect(page.status).toBe(200);
    expect(page.body.entries[0]).toMatchObject({ service: "chat", attempt: 1, provider: "p2", result: "ok" });
    // `attempt > 0` suffit : le repli est compté même sans le champ explicite.
    expect(page.body.summary.total).toBe(1);
    expect(page.body.summary.last24h).toBe(1);
    expect(page.body.summary.byFallbackProvider).toEqual({ p2: 1 });
  });
});
