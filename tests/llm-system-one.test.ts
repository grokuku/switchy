/**
 * API « System One » — second type d'API de la passerelle, relayé NATIVEMENT.
 *
 * Ce que cette suite verrouille (aucun réseau : `fetch` est mocké) :
 *   - `POST /api/system/:service` et `POST /v1/systemone` atteignent le BON
 *     endpoint du fournisseur (`{baseUrl}/v1/systemone`, ou `systemOneUrl` s'il
 *     est configuré) ;
 *   - le corps est relayé TEL QUEL : `state` / `questions` / `images` /
 *     `keep_alive` intacts, SEUL `model` remplacé par le modèle de l'étape ;
 *   - AUCUN contrôle de génération n'est ajouté (`reasoning_effort` compris),
 *     contrairement au chat ;
 *   - la réponse du fournisseur est relayée sans transformation ;
 *   - l'auth est celle de Switchy (401 sans clé), la clé du CLIENT ne sort jamais ;
 *   - 404 service inconnu, 503 service désactivé, repli sur l'étape suivante,
 *     non-repli sur 401 amont ;
 *   - le JOURNAL ne contient ni `state` ni `questions` (texte utilisateur), mais
 *     bien service / fournisseur / modèle / statut / durée / tokens ;
 *   - les compteurs du tableau de bord voient l'appel comme n'importe quel autre ;
 *   - NON-RÉGRESSION : `POST /v1/chat/completions` continue de recevoir
 *     `reasoning_effort` et de streamer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  sseResponse,
  type TestEnv,
} from "./helpers.js";
import { systemOneEndpointUrl, upstreamUrl, buildUpstreamBody } from "../src/llm/relay.js";
import { validateSystemOneBody } from "../src/llm/system-one.js";
import type { ProviderRecord, ServiceStep } from "../src/catalog-store.js";

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

/** Catalogue minimal : un fournisseur Ollama Cloud + un service `triage`. */
async function seedTriage(options: { fallback?: boolean; serviceEnabled?: boolean } = {}): Promise<void> {
  await seedProvider(env.app, {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    type: "openai-compatible",
    baseUrl: "https://ollama.com/v1",
    apiKey: "sk-FOURNISSEUR_SECRET",
  });
  if (options.fallback) {
    await seedProvider(env.app, {
      id: "backup",
      label: "Backup",
      type: "openai-compatible",
      baseUrl: "https://backup.example/v1",
      apiKey: "sk-BACKUP_SECRET",
    });
  }
  await seedService(env.app, {
    name: "triage",
    description: "",
    principal: step("ollama-cloud", "clef"),
    fallbacks: options.fallback ? [step("backup", "clef-flash")] : [],
    contextWindow: 65536,
    maxOutputTokens: 16,
    vision: true,
    ...(options.serviceEnabled === false ? { enabled: false } : {}),
  });
}

/** Corps System One d'exemple (celui de la doc Ollama, ticket + 3 questions). */
function systemOneBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "triage",
    state: { ticket: "I was charged twice. Please refund the extra payment." },
    questions: {
      team: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: { billing: "Payments and refunds", technical: "Bugs", other: "None of the above" },
      },
      refund: { type: "noul", instructions: "Does the customer explicitly ask for a refund?" },
      urgency: {
        type: "score",
        instructions: "How urgent is this ticket?",
        criteria: ["Routine", "Soon", "Urgent"],
      },
    },
    ...overrides,
  };
}

/** Réponse System One d'exemple (forme EXACTE de la doc). */
const DOC_ANSWER = {
  model: "clef",
  answers: {
    team: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9888, technical: 0.0044, other: 0.0068 },
      confidence: 0.9667,
    },
    refund: { type: "noul", noul: 0.9916 },
    urgency: {
      type: "score",
      score: 1.5481,
      legend: { "0": "Routine", "1": "Soon", "2": "Urgent" },
      probabilities: { "0": 0.0871, "1": 0.2778, "2": 0.6351 },
      confidence: 0.2322,
    },
  },
  usage: { input_tokens: 332, output_tokens: 0 },
};

describe("URL de l'endpoint System One", () => {
  const provider = (over: Partial<ProviderRecord>): ProviderRecord =>
    ({
      id: "p",
      label: "P",
      type: "openai-compatible",
      baseUrl: "https://ollama.com/v1",
      enabled: true,
      createdAt: "",
      updatedAt: "",
      ...over,
    }) as ProviderRecord;

  it("dérivée du baseUrl : `/v1` → `{base}/systemone` (jamais `/v1/system`)", () => {
    expect(systemOneEndpointUrl(provider({}))).toBe("https://ollama.com/v1/systemone");
    expect(systemOneEndpointUrl(provider({ baseUrl: "http://localhost:11434/v1/" }))).toBe(
      "http://localhost:11434/v1/systemone",
    );
  });

  it("sans suffixe `/v1`, le chemin est complété : `{base}/v1/systemone`", () => {
    expect(systemOneEndpointUrl(provider({ baseUrl: "http://localhost:11434" }))).toBe(
      "http://localhost:11434/v1/systemone",
    );
  });

  it("`systemOneUrl` configuré FAIT FOI (fournisseur au chemin dédié)", () => {
    expect(
      systemOneEndpointUrl(provider({ systemOneUrl: "https://exotic.example/decide/systemone" })),
    ).toBe("https://exotic.example/decide/systemone");
  });

  it("le chat garde SON chemin (non-régression)", () => {
    expect(upstreamUrl(provider({}), "chat")).toBe("https://ollama.com/v1/chat/completions");
    expect(upstreamUrl(provider({}), "systemone")).toBe("https://ollama.com/v1/systemone");
  });
});

describe("corps relayé — pass-through strict", () => {
  const provider: ProviderRecord = {
    id: "p",
    label: "P",
    type: "openai-compatible",
    baseUrl: "https://ollama.com/v1",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  } as ProviderRecord;
  const stepWithReasoning: ServiceStep = { providerId: "p", model: "clef", reasoning: "high", enabled: true };

  it("System One : seul `model` change, AUCUN contrôle de génération ajouté", () => {
    const sent = buildUpstreamBody(systemOneBody(), stepWithReasoning, provider, "systemone");
    expect(sent.model).toBe("clef");
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.state).toEqual({ ticket: "I was charged twice. Please refund the extra payment." });
    expect(Object.keys(sent.questions as object)).toEqual(["team", "refund", "urgency"]);
  });

  it("chat : `reasoning_effort` reste IMPOSÉ (non-régression)", () => {
    const sent = buildUpstreamBody({ messages: [] }, stepWithReasoning, provider, "chat");
    expect(sent.model).toBe("clef");
    expect(sent.reasoning_effort).toBeDefined();
  });
});

describe("validation du corps System One", () => {
  it("accepte le corps de la doc", () => {
    expect(validateSystemOneBody(systemOneBody())).toEqual([]);
  });

  it("`state` absent ou vide est refusé", () => {
    const missing = systemOneBody();
    delete missing.state;
    expect(validateSystemOneBody(missing).join(" ")).toContain("state: required");
    expect(validateSystemOneBody(systemOneBody({ state: "   " })).join(" ")).toContain("non-empty");
    expect(validateSystemOneBody(systemOneBody({ state: {} })).join(" ")).toContain("non-empty");
  });

  it("`questions` absent, vide ou trop nombreuses est refusé", () => {
    const missing = systemOneBody();
    delete missing.questions;
    expect(validateSystemOneBody(missing).join(" ")).toContain("questions: required");
    expect(validateSystemOneBody(systemOneBody({ questions: {} })).join(" ")).toContain("at least one");
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= 64; i++) many[`q${i}`] = { type: "noul", instructions: "x" };
    expect(validateSystemOneBody(systemOneBody({ questions: many })).join(" ")).toContain("at most 64");
  });

  it("type de question inconnu, `score` hors bornes et `choice` à une option refusés", () => {
    expect(
      validateSystemOneBody(
        systemOneBody({ questions: { q: { type: "bool", instructions: "x" } } }),
      ).join(" "),
    ).toContain("type: must be one of choice, noul, score");
    expect(
      validateSystemOneBody(
        systemOneBody({ questions: { q: { type: "score", instructions: "x", criteria: ["seul"] } } }),
      ).join(" "),
    ).toContain("2 to 10 level descriptions");
    expect(
      validateSystemOneBody(
        systemOneBody({ questions: { q: { type: "choice", instructions: "x", criteria: { a: null } } } }),
      ).join(" "),
    ).toContain("at least 2 options");
  });
});

describe("POST /api/system/:service", () => {
  it("relaie le corps tel quel, remplace `model`, ajoute la clé du FOURNISSEUR", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://ollama.com/v1/systemone");
    expect(mock.calls[0].init.method).toBe("POST");
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer sk-FOURNISSEUR_SECRET");
    expect(mock.calls[0].init.headers?.["x-api-key"]).toBeUndefined(); // clé client jamais transmise

    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("clef"); // modèle réel de l'étape, pas le nom du service
    expect(sent.state).toEqual({ ticket: "I was charged twice. Please refund the extra payment." });
    expect(sent.questions).toEqual(systemOneBody().questions);
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.stream).toBeUndefined();
    expect(sent.messages).toBeUndefined(); // jamais converti en chat
  });

  it("relaie la réponse du fournisseur SANS la transformer (answers + usage)", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(res.body).toEqual(DOC_ANSWER);
    expect(res.body.answers.team.choice).toBe("billing");
    expect(res.body.answers.refund.noul).toBeCloseTo(0.9916, 4);
    expect(res.body.usage.input_tokens).toBe(332);
  });

  it("`images` et `keep_alive` passent tels quels", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    await api(env.app)
      .post("/api/system/triage")
      .send({ ...systemOneBody(), images: ["iVBORw0KGgo="], keep_alive: "5m" });
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.images).toEqual(["iVBORw0KGgo="]);
    expect(sent.keep_alive).toBe("5m");
  });

  it("`systemOneUrl` du fournisseur est utilisé quand il est configuré", async () => {
    await seedProvider(env.app, {
      id: "exotic",
      label: "Exotic",
      type: "openai-compatible",
      baseUrl: "https://exotic.example/v1",
      systemOneUrl: "https://exotic.example/decide/systemone",
      apiKey: "sk-EXOTIC",
    });
    await seedService(env.app, {
      name: "triage",
      description: "",
      principal: step("exotic", "clef:cloud"),
      fallbacks: [],
      contextWindow: 65536,
      maxOutputTokens: 16,
      vision: true,
    });
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(res.status).toBe(200);
    expect(mock.calls[0].url).toBe("https://exotic.example/decide/systemone");
  });

  it("401 sans clé d'API / avec une clé invalide", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const anonymous = await (await import("supertest")).default(env.app).post("/api/system/triage").send(systemOneBody());
    expect(anonymous.status).toBe(401);

    const badKey = await (await import("supertest")).default(env.app)
      .post("/api/system/triage")
      .set("X-API-Key", "cle-qui-n-existe-pas")
      .send(systemOneBody());
    expect(badKey.status).toBe(401);
    expect(mock.calls).toHaveLength(0); // aucune requête fournisseur engagée
  });

  it("404 service inconnu, 503 service désactivé (aucun appel fournisseur)", async () => {
    await seedTriage({ serviceEnabled: false });
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const unknown = await api(env.app).post("/api/system/inconnu").send(systemOneBody());
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("NOT_FOUND");

    const disabled = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(disabled.status).toBe(503);
    expect(disabled.body.code).toBe("SERVICE_DISABLED");
    expect(mock.calls).toHaveLength(0);
  });

  it("400 sur corps System One invalide (message explicite, aucun appel fournisseur)", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/api/system/triage").send({ model: "triage" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.body.errors)).toContain("state: required");
    expect(JSON.stringify(res.body.errors)).toContain("questions: required");
    expect(mock.calls).toHaveLength(0);
  });

  it("repli : 503 amont sur le principal → l'étape suivante répond (corps inchangé)", async () => {
    await seedTriage({ fallback: true });
    mock = installMockFetch((url) =>
      url.includes("backup")
        ? jsonResponse(DOC_ANSWER)
        : jsonResponse({ error: "overloaded" }, { status: 503 }),
    );

    const res = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(res.status).toBe(200);
    expect(res.body.answers.team.choice).toBe("billing");
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://ollama.com/v1/systemone",
      "https://backup.example/v1/systemone",
    ]);
    const fallbackBody = JSON.parse(mock.calls[1].init.body ?? "{}") as Record<string, unknown>;
    expect(fallbackBody.model).toBe("clef-flash");
    expect(fallbackBody.state).toEqual(systemOneBody().state);
  });

  it("401 amont relayé tel quel et SANS repli (auth = configuration, pas charge)", async () => {
    await seedTriage({ fallback: true });
    mock = installMockFetch(() => jsonResponse({ error: "invalid api key" }, { status: 401 }));

    const res = await api(env.app).post("/api/system/triage").send(systemOneBody());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid api key");
    expect(mock.calls).toHaveLength(1);
  });

  it("le journal ne contient NI `state` NI `questions`, mais bien les métadonnées", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    await api(env.app).post("/api/system/triage").send(systemOneBody());
    const lines = logLines();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;

    expect(entry.service).toBe("triage");
    expect(entry.provider).toBe("ollama-cloud");
    expect(entry.model).toBe("clef");
    expect(entry.result).toBe("ok");
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.stream).toBe(false);
    expect(entry.tokens).toEqual({ promptTokens: 332, completionTokens: 0 });
    // ⚠️ Aucun contenu utilisateur, aucune clé.
    const raw = lines[0];
    expect(raw).not.toContain("charged twice");
    expect(raw).not.toContain("questions");
    expect(raw).not.toContain("state");
    expect(raw).not.toContain("Which team");
    expect(raw).not.toContain("FOURNISSEUR_SECRET");
    // ⚠️ Le nom de la clé est journalisé (attribution), jamais sa valeur.
    expect(typeof entry.keyName).toBe("string");
  });

  it("le tableau de bord compte l'appel comme n'importe quel autre", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    await api(env.app).post("/api/system/triage").send(systemOneBody());
    const dashboard = await api(env.app).get("/api/dashboard");
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.activity.calls).toBe(1);
    expect(dashboard.body.activity.attempts).toBe(1);
    expect(dashboard.body.activity.successRate).toBe(1);
    // Les tokens System One (`input_tokens`/`output_tokens`) sont comptés
    // comme ceux d'un appel chat : entrée côté service ET côté fournisseur.
    expect(dashboard.body.tokens.byService.triage.prompt).toBe(332);
    expect(dashboard.body.tokens.byProvider["ollama-cloud"].prompt).toBe(332);
    // Les appels EN VOL par clé fonctionnent (compteur libéré en fin d'appel).
    expect(dashboard.body.byKey.reduce((sum: number, row: { calls: number }) => sum + row.calls, 0)).toBe(1);
  });
});

describe("POST /v1/systemone (chemin du fournisseur, `model` = service)", () => {
  it("atteint le fournisseur avec le modèle réel de l'étape", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/v1/systemone").send(systemOneBody());
    expect(res.status).toBe(200);
    expect(res.body.answers.urgency.score).toBeCloseTo(1.5481, 4);
    expect(mock.calls[0].url).toBe("https://ollama.com/v1/systemone");
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("clef");
  });

  it("`model` absent → 400 (le nom du service est obligatoire)", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/v1/systemone").send({ state: "x", questions: { q: { type: "noul", instructions: "y" } } });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContain(
      "model: required — POST /v1/systemone expects the name of a service of the Switchy catalog",
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("service inconnu → 404", async () => {
    await seedTriage();
    mock = installMockFetch(() => jsonResponse(DOC_ANSWER));

    const res = await api(env.app).post("/v1/systemone").send(systemOneBody({ model: "fantome" }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("non-régression — le chat reste inchangé", () => {
  it("POST /v1/chat/completions reçoit toujours `reasoning_effort` et streame", async () => {
    await seedProvider(env.app, {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      type: "openai-compatible",
      baseUrl: "https://ollama.com/v1",
      apiKey: "sk-FOURNISSEUR_SECRET",
    });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: { providerId: "ollama-cloud", model: "qwen3:8b", reasoning: "low", enabled: true },
      fallbacks: [],
      contextWindow: 32000,
      maxOutputTokens: 1000,
      vision: false,
    });
    mock = installMockFetch(() =>
      sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]),
    );

    const res = await api(env.app)
      .post("/v1/chat/completions")
      .send({ model: "chat", stream: true, messages: [{ role: "user", content: "salut" }] });

    expect(res.status).toBe(200);
    expect(mock.calls[0].url).toBe("https://ollama.com/v1/chat/completions");
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("qwen3:8b");
    expect(sent.reasoning_effort).toBeDefined();
    expect(sent.stream).toBe(true);
    expect(sent.state).toBeUndefined();
  });
});
