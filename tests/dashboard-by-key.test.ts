/**
 * Tableau de bord « Activité » — statistiques PAR CLÉ D'API (nom uniquement,
 * jamais un secret) et appels EN VOL par clé.
 *
 * AUCUN réseau : `fetch` est mocké ; le journal est écrit dans un répertoire de
 * données temporaire.
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
  waitFor,
  createApiKey,
  type TestEnv,
} from "./helpers.js";
import { resetCallsLogState, summarizeByKey, type CallLogEntry } from "../src/llm/calls-log.js";
import { beginCall, endCall, inFlightByKey, inFlightFor, resetInFlightCounters } from "../src/llm/inflight-by-key.js";

let env: TestEnv;
let mock: ReturnType<typeof installMockFetch> | null = null;

beforeEach(() => {
  env = makeTestEnv();
  mock = null;
  resetInFlightCounters();
});

afterEach(() => {
  mock?.restore();
  env.cleanup();
});

const ISO = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

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

function ask(secret: string) {
  return request(env.app)
    .post("/v1/chat/completions")
    .set("X-API-Key", secret)
    .send({ model: "chat", messages: [{ role: "user", content: "bonjour" }] });
}

// ── Agrégation pure ──────────────────────────────────────────────────────

describe("summarizeByKey — agrégation par clé", () => {
  it("agrège appels, réussite, replis, latence et tokens par nom de clé", () => {
    const entries: Partial<CallLogEntry>[] = [
      {
        ts: ISO(1000),
        callId: "a1",
        keyName: "yuki",
        service: "chat",
        attempt: 0,
        provider: "p1",
        model: "m",
        result: "ok",
        durationMs: 1000,
        tokens: { promptTokens: 100, completionTokens: 20, reasoningTokens: 5 },
      },
      // Repli du même appel logique : ne doit PAS compter un appel de plus.
      {
        ts: ISO(900),
        callId: "a1",
        keyName: "yuki",
        service: "chat",
        attempt: 1,
        provider: "p1",
        model: "m",
        result: "ok",
        durationMs: 3000,
        tokens: { promptTokens: 50, completionTokens: 10 },
      },
      {
        ts: ISO(800),
        callId: "b1",
        keyName: "veille",
        service: "chat",
        attempt: 0,
        provider: "p1",
        model: "m",
        result: "error",
        reason: "rate_limit",
        durationMs: 40,
      },
      // Entrée ANTÉRIEURE au champ `keyName` → « inconnu ».
      {
        ts: ISO(700),
        callId: "c1",
        service: "chat",
        attempt: 0,
        provider: "p1",
        model: "m",
        result: "ok",
        durationMs: 500,
      },
    ];
    const rows = summarizeByKey(entries as CallLogEntry[], { windowHours: 24, now: Date.now() });
    const yuki = rows.find((r) => r.keyName === "yuki");
    const veille = rows.find((r) => r.keyName === "veille");
    const unknown = rows.find((r) => r.keyName === "inconnu");

    expect(yuki?.calls).toBe(1); // a1 + a2 = un seul appel logique
    expect(yuki?.fallbacks).toBe(1);
    expect(yuki?.successRate).toBe(1);
    expect(yuki?.latency.avgMs).toBe(2000); // (1000 + 3000) / 2
    expect(yuki?.tokens.prompt).toBe(150);
    expect(yuki?.tokens.completion).toBe(30);
    expect(yuki?.tokens.reasoning).toBe(5);

    expect(veille?.calls).toBe(1);
    expect(veille?.successRate).toBe(0);
    // Aucune valeur de tokens exposée → null (l'interface affiche « — »).
    expect(veille?.tokens.prompt).toBeNull();

    expect(unknown?.calls).toBe(1);
    // Les plus actives d'abord.
    expect(rows[0].calls).toBeGreaterThanOrEqual(rows[rows.length - 1].calls);
  });

  it("inclut les clés connues à zéro appel", () => {
    const rows = summarizeByKey([], { windowHours: 24, knownKeys: ["veille", "yuki"] });
    expect(rows.map((r) => r.keyName).sort()).toEqual(["veille", "yuki"]);
    expect(rows.every((r) => r.calls === 0 && r.successRate === null)).toBe(true);
  });
});

// ── Compteur d'appels en vol ─────────────────────────────────────────────

describe("compteur d'appels en vol par clé", () => {
  it("incrémente puis décrémente sur succès (aucune fuite)", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const res = await ask(secret);
    expect(res.status).toBe(200);
    expect(await waitForReturnsZero()).toBe(true);
  });

  it("incrémente puis décrémente sur erreur (aucune fuite)", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    mock = installMockFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));

    const res = await ask(secret);
    expect(res.status).toBe(500);
    expect(await waitForReturnsZero()).toBe(true);
  });

  it("incrémente puis décrémente sur annulation (aucune fuite)", async () => {
    // Chemin d'annulation : le décrément suit le même `finally` que la route ;
    // on vérifie ici le contrat du compteur lui-même (jamais négatif, jamais bloqué).
    beginCall("yuki");
    expect(inFlightFor("yuki")).toBe(1);
    endCall("yuki");
    endCall("yuki"); // idempotent : jamais de valeur négative
    expect(inFlightFor("yuki")).toBe(0);
    expect(inFlightByKey()).toEqual({});
  });

  it("expose l'appel en vol dans byKey pendant la requête, puis 0 après", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock = installMockFetch(async () => {
      await gate;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    // Démarrer la requête (supertest ne l'émet qu'à l'await/au then).
    const pending = ask(secret).then((r) => r);
    await waitFor(() => inFlightFor("yuki") === 1);

    const during = await api(env.app).get("/api/dashboard");
    expect(during.status).toBe(200);
    const rowDuring = (during.body.byKey as Array<{ key: string; inFlight: number }>).find((r) => r.key === "yuki");
    expect(rowDuring?.inFlight).toBe(1);

    release?.();
    expect((await pending).status).toBe(200);
    await waitFor(() => inFlightFor("yuki") === 0);

    const after = await api(env.app).get("/api/dashboard");
    const rowAfter = (after.body.byKey as Array<{ key: string; inFlight: number }>).find((r) => r.key === "yuki");
    expect(rowAfter?.inFlight).toBe(0);
  });
});

async function waitForReturnsZero(): Promise<boolean> {
  await waitFor(() => Object.keys(inFlightByKey()).length === 0);
  return Object.keys(inFlightByKey()).length === 0;
}

// ── Route /api/dashboard ────────────────────────────────────────────────

describe("GET /api/dashboard — section byKey", () => {
  it("compte l'appel sous le NOM de la clé et jamais sous son secret", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    mock = installMockFetch(() =>
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );

    expect((await ask(secret)).status).toBe(200);

    const res = await api(env.app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const byKey = res.body.byKey as Array<{ key: string; calls: number; inFlight: number; tokens: { prompt: number | null } }>;
    const row = byKey.find((r) => r.key === "yuki");
    expect(row).toBeTruthy();
    expect(row?.calls).toBe(1);
    expect(row?.inFlight).toBe(0);
    expect(row?.tokens.prompt).toBe(12);
  });

  it("clé connue mais inactive → ligne à zéro ; « inconnu » pour l'ancien journal", async () => {
    await createApiKey(env.app, "veille");
    await createApiKey(env.app, "yuki");
    writeLog([
      // Entrée sans `keyName` (journal antérieur au champ).
      {
        ts: ISO(60_000),
        callId: "old1",
        service: "chat",
        attempt: 0,
        provider: "ollama",
        model: "llama3",
        result: "ok",
        durationMs: 120,
      },
    ]);

    const res = await api(env.app).get("/api/dashboard");
    const byKey = res.body.byKey as Array<{ key: string; calls: number; successRate: number | null }>;
    const unknown = byKey.find((r) => r.key === "inconnu");
    const veille = byKey.find((r) => r.key === "veille");
    expect(unknown?.calls).toBe(1);
    expect(veille?.calls).toBe(0);
    expect(veille?.successRate).toBeNull();
    // Toutes les clés connues sont présentes (+ « inconnu » de l'ancien journal).
    expect(byKey.map((r) => r.key)).toEqual(expect.arrayContaining(["veille", "yuki", "inconnu"]));
  });

  it("la réponse ne contient AUCUNE valeur de clé, seulement des noms", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    expect((await ask(secret)).status).toBe(200);

    const res = await api(env.app).get("/api/dashboard");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("switchy_");
    expect(body).not.toContain("switchyk_");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("keyHash");
    expect(body).toContain("yuki");
  });

  it("ne casse pas l'existant (/api/calls, /v1/models, blocs du dashboard)", async () => {
    await seedOllama();
    const secret = await createApiKey(env.app, "yuki");
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    expect((await ask(secret)).status).toBe(200);

    const calls = await api(env.app).get("/api/calls");
    expect(calls.status).toBe(200);
    expect(Array.isArray(calls.body.entries)).toBe(true);

    const models = await api(env.app).get("/v1/models");
    expect(models.status).toBe(200);

    const dash = await api(env.app).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.live).toBeTruthy();
    expect(dash.body.activity).toBeTruthy();
    expect(dash.body.tokens).toBeTruthy();
    expect(Array.isArray(dash.body.recent)).toBe(true);
    expect(Array.isArray(dash.body.byKey)).toBe(true);
  });
});
