/**
 * Journal d'appels (Lot 3) — contenu (aucune clé, aucun prompt), bornes
 * (compaction par nombre), rétention (purge par âge), consultation paginée.
 * Aucun réseau : `fetch` est mocké.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "fs";
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
import { compactCallsLog, resetCallsLogState } from "../src/llm/calls-log.js";

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

function logLines(): string[] {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

async function seedChat(overrides: Record<string, unknown> = {}): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Fournisseur 1",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
    apiKey: "sk-FOURNISSEUR_SECRET",
  });
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: step("p1", "model-a"),
    fallbacks: [],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
    ...overrides,
  });
}

describe("journal d'appels — contenu", () => {
  it("jamais de clé d'API ni de contenu de prompt dans le fichier", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "réponse" } }] }));

    const res = await api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [{ role: "user", content: "PROMPT_SECRET_XYZ" }] });
    expect(res.status).toBe(200);
    // La clé EST bien allée au fournisseur (sinon le test ne prouverait rien)…
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer sk-FOURNISSEUR_SECRET");

    // …mais ni la clé ni le prompt n'apparaissent dans le journal.
    const raw = readFileSync(logFile(), "utf-8");
    expect(raw).not.toContain("sk-FOURNISSEUR_SECRET");
    expect(raw).not.toContain("PROMPT_SECRET_XYZ");
    expect(raw).toContain("model-a");
    expect(raw).toContain("chat");
  });

  it("mode full : ajoute la priorité, le streaming et la provenance — toujours sans contenu", async () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_MODE: "full" });
    await seedChat({ prioritaire: true });
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    await api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [{ role: "user", content: "SECRET" }] });

    const entry = JSON.parse(logLines()[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({ prioritaire: true, stream: false, endpoint: "POST /api/llm/:service" });
    expect(entry).not.toHaveProperty("messages");
    expect(JSON.stringify(entry)).not.toContain("SECRET");
  });
});

describe("journal d'appels — bornes et rétention", () => {
  it("compaction par nombre : le fichier reste borné par SWITCHY_CALLS_LOG_MAX_ENTRIES", async () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_MAX_ENTRIES: "5" });
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    for (let i = 0; i < 12; i++) {
      const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
      expect(res.status).toBe(200);
    }
    expect(logLines().length).toBeLessThanOrEqual(5);

    const page = await api(env.app).get("/api/calls");
    expect(page.status).toBe(200);
    expect(page.body.total).toBeLessThanOrEqual(5);
  });

  it("rétention : les entrées plus vieilles que SWITCHY_CALLS_LOG_RETENTION_DAYS sont purgées", async () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_RETENTION_DAYS: "7" });
    resetCallsLogState();

    const now = Date.now();
    const oldTs = new Date(now - 10 * 86_400_000).toISOString();
    const freshTs = new Date(now - 1 * 86_400_000).toISOString();
    const lines = [
      { ts: oldTs, service: "chat", attempt: 0, provider: "p1", model: "m", result: "ok", durationMs: 1 },
      { ts: freshTs, service: "chat", attempt: 0, provider: "p1", model: "m", result: "ok", durationMs: 2 },
      { ts: new Date(now).toISOString(), service: "chat", attempt: 0, provider: "p1", model: "m", result: "ok", durationMs: 3 },
    ];
    writeFileSync(logFile(), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const result = compactCallsLog(now);
    expect(result.removed).toBe(1);
    expect(logLines()).toHaveLength(2);
    expect(readFileSync(logFile(), "utf-8")).not.toContain(oldTs);
    expect(readFileSync(logFile(), "utf-8")).toContain(freshTs);
  });

  it("mode off : aucune écriture", async () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_CALLS_LOG_MODE: "off" });
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(200);
    expect(existsSync(logFile())).toBe(false);
  });
});

describe("journal d'appels — consultation paginée", () => {
  it("GET /api/calls : le plus récent d'abord, pagination et filtre par service", async () => {
    await seedProvider(env.app, { id: "p2", label: "P2", type: "openai-compatible", baseUrl: "https://p2.example/v1" });
    await seedChat({ fallbacks: [step("p2", "model-b")] });
    mock = installMockFetch((url) =>
      url.includes("p1.example") ? jsonResponse({ error: "boom" }, { status: 500 }) : jsonResponse({ choices: [] }),
    );

    await api(env.app).post("/api/llm/chat").send({ messages: [] });

    const page = await api(env.app).get("/api/calls?limit=1");
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(2);
    expect(page.body.limit).toBe(1);
    expect(page.body.entries).toHaveLength(1);
    // Le plus récent d'abord : la tentative de repli (attempt 1) avant le principal.
    expect(page.body.entries[0]).toMatchObject({ attempt: 1, provider: "p2", result: "ok" });
    expect(page.body.entries[0]).not.toHaveProperty("key");

    const rest = await api(env.app).get("/api/calls?limit=10&offset=1");
    expect(rest.body.entries).toHaveLength(1);
    expect(rest.body.entries[0]).toMatchObject({ attempt: 0, provider: "p1", result: "error", status: 500 });

    const filtered = await api(env.app).get("/api/calls?service=autre");
    expect(filtered.body.total).toBe(0);
  });

  it("journal absent : la route répond 200 avec une page vide", async () => {
    const page = await api(env.app).get("/api/calls");
    expect(page.body).toMatchObject({ total: 0, entries: [], limit: 50, offset: 0 });
  });
});
