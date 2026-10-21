/**
 * Test d'étape d'un service (`POST /api/services/:name/test`) et bascule
 * `enabled` depuis la carte.
 *
 * On verrouille les règles qui protègent l'utilisateur :
 *   - un test CIBLÉ (`stepIndex`) n'appelle QUE cette étape — jamais la chaîne
 *     de replis (sinon on ne teste pas ce qu'on croit) ;
 *   - sans `stepIndex`, la CHAÎNE COMPLÈTE de production s'applique (replis
 *     compris) et `fellBack` dit si un repli a répondu ;
 *   - `maxTokens` est plafonné côté serveur (QUOTA utilisateur) ;
 *   - un échec fournisseur donne une erreur STRUCTURÉE (jamais un 500 opaque) ;
 *   - aucune clé, aucune URL de fournisseur, aucun corps amont brut dans la
 *     réponse ;
 *   - chaque test est journalisé (il compte dans les statistiques) ;
 *   - `enabled` bascule par `PUT /api/services/:name` et un service désactivé
 *     disparaît de `GET /v1/models`.
 *
 * AUCUN accès réseau : `globalThis.fetch` est mocké.
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

function readLog(): Array<Record<string, unknown>> {
  const file = join(env.dir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Deux fournisseurs distincts + un service `chat` : principal `p1`, repli `p2`. */
async function seedChain(): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Ollama Cloud",
    type: "openai-compatible",
    baseUrl: "https://ollama.example/v1",
    apiKey: "sk-OLLAMA_SECRET_0001",
  });
  await seedProvider(env.app, {
    id: "p2",
    label: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://deepseek.example/v1",
    apiKey: "sk-DEEPSEEK_SECRET_0002",
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

/** Réponse fournisseur minimale, avec `usage`. */
function okPayload(text = "ok", promptTokens = 7, completionTokens = 2): Response {
  return jsonResponse({
    id: "chatcmpl-test",
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  });
}

describe("POST /api/services/:name/test — étape ciblée", () => {
  it("stepIndex 0 n'appelle QUE le principal, même quand il échoue (aucun repli)", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: "nope" }, { status: 500 }));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0, prompt: "Réponds uniquement : ok" });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://ollama.example/v1/chat/completions");
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(500);
    expect(res.body.providerId).toBe("p1");
    expect(res.body.model).toBe("ollama-model");
    expect(res.body.fellBack).toBe(false);
    expect(res.body.error.code).toBe("upstream_error");
    expect(res.body.error.reason).toBe("upstream_error");
    expect(typeof res.body.error.message).toBe("string");
  });

  it("stepIndex 1 n'appelle QUE le repli", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload("ok"));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 1 });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://deepseek.example/v1/chat/completions");
    expect(res.body.ok).toBe(true);
    expect(res.body.stepIndex).toBe(1);
    expect(res.body.providerId).toBe("p2");
    expect(res.body.model).toBe("deepseek-chat");
    expect(res.body.text).toBe("ok");
    expect(res.body.tokens).toEqual({ prompt: 7, completion: 2, reasoning: null });
    expect(res.body.fellBack).toBe(false);
  });

  it("envoie le prompt court et `max_tokens` au fournisseur, jamais `stream`", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0, prompt: "Réponds uniquement : ok" });

    const sent = JSON.parse(String(mock.calls[0].init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("ollama-model");
    expect(sent.max_tokens).toBe(64); // défaut
    expect(sent.stream).toBe(false);
    expect(sent.messages).toEqual([{ role: "user", content: "Réponds uniquement : ok" }]);
  });

  it("plafonne maxTokens à 256 côté serveur", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0, maxTokens: 100000 });

    const sent = JSON.parse(String(mock.calls[0].init.body)) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(256);
  });

  it("respecte un maxTokens raisonnable sous le plafond", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0, maxTokens: 16 });

    expect(JSON.parse(String(mock.calls[0].init.body)).max_tokens).toBe(16);
  });
});

describe("POST /api/services/:name/test — chaîne complète", () => {
  it("sans stepIndex : repli utilisé si le principal échoue, `fellBack` le dit", async () => {
    await seedChain();
    mock = installMockFetch((url) => (url.includes("ollama.example") ? jsonResponse({ error: "boom" }, { status: 500 }) : okPayload("ok")));

    const res = await api(env.app).post("/api/services/chat/test").send({});

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(res.body.ok).toBe(true);
    expect(res.body.fellBack).toBe(true);
    expect(res.body.stepIndex).toBe(1);
    expect(res.body.providerId).toBe("p2");
    expect(res.body.text).toBe("ok");
  });

  it("sans stepIndex et principal OK : aucun repli sollicité", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload("ok"));

    const res = await api(env.app).post("/api/services/chat/test").send({});

    expect(mock.calls).toHaveLength(1);
    expect(res.body.ok).toBe(true);
    expect(res.body.fellBack).toBe(false);
    expect(res.body.providerId).toBe("p1");
  });
});

describe("POST /api/services/:name/test — garde-fous", () => {
  it("service inconnu → 404 JSON", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/inexistant/test").send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(mock.calls).toHaveLength(0);
  });

  it("stepIndex hors bornes → 400, aucun appel réseau", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 2 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mock.calls).toHaveLength(0);
  });

  it("stepIndex négatif / non entier → 400", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    for (const stepIndex of [-1, 1.5, "0"]) {
      const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("prompt vide → 400", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/chat/test").send({ prompt: "   " });

    expect(res.status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it("ne divulgue AUCUNE clé ni URL de fournisseur dans la réponse", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload("ok"));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0 });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("sk-OLLAMA_SECRET_0001");
    expect(serialized).not.toContain("sk-DEEPSEEK_SECRET_0002");
    expect(serialized).not.toContain("ollama.example");
    expect(serialized).not.toContain("deepseek.example");
  });

  it("fournisseur en erreur 401 : erreur structurée lisible, jamais un 500 opaque", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: "invalid api key sk-SECRET" }, { status: 401 }));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(401);
    expect(res.body.error.reason).toBe("auth_error");
    expect(res.body.error.message).toContain("401");
    expect(JSON.stringify(res.body)).not.toContain("sk-SECRET");
  });

  it("fournisseur dont la clé est un secret : la réponse ne contient pas le corps amont", async () => {
    await seedChain();
    mock = installMockFetch(() => jsonResponse({ error: "quota", details: "sk-OLLAMA_SECRET_0001" }, { status: 429 }));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0 });

    expect(res.body.error.reason).toBe("quota");
    expect(JSON.stringify(res.body)).not.toContain("sk-OLLAMA_SECRET_0001");
  });

  it("fournisseur désactivé → erreur honnête, aucun appel", async () => {
    await seedChain();
    await api(env.app).put("/api/providers/p1").send({ enabled: false });
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("provider_disabled");
    expect(mock.calls).toHaveLength(0);
  });

  it("journalise le test (il compte dans les statistiques)", async () => {
    await seedChain();
    mock = installMockFetch(() => okPayload());

    await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0 });

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("chat");
    expect(entries[0].provider).toBe("p1");
    expect(entries[0].model).toBe("ollama-model");
    expect(entries[0].result).toBe("ok");
    // Ni clé ni prompt dans le journal.
    const raw = readFileSync(join(env.dir, "calls.jsonl"), "utf-8");
    expect(raw).not.toContain("sk-OLLAMA_SECRET_0001");
    expect(raw).not.toContain("Réponds uniquement");
  });
});

describe("Bascule `enabled` depuis la carte", () => {
  it("PUT /api/services/:name bascule le service et le retire de /v1/models", async () => {
    await seedChain();

    let models = await api(env.app).get("/v1/models");
    expect(models.status).toBe(200);
    expect((models.body.data as Array<{ id: string }>).map((m) => m.id)).toContain("chat");

    const off = await api(env.app).put("/api/services/chat").send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.service.enabled).toBe(false);

    models = await api(env.app).get("/v1/models");
    expect((models.body.data as Array<{ id: string }>).map((m) => m.id)).not.toContain("chat");

    // Le service reste VISIBLE dans la configuration (l'interface l'atténue).
    const list = await api(env.app).get("/api/services");
    expect((list.body.services as Array<{ name: string; enabled: boolean }>)[0]).toMatchObject({ name: "chat", enabled: false });

    const on = await api(env.app).put("/api/services/chat").send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.service.enabled).toBe(true);

    models = await api(env.app).get("/v1/models");
    expect((models.body.data as Array<{ id: string }>).map((m) => m.id)).toContain("chat");
  });

  it("un service désactivé n'est plus relayé (503 SERVICE_DISABLED)", async () => {
    await seedChain();
    await api(env.app).put("/api/services/chat").send({ enabled: false });
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [{ role: "user", content: "salut" }] });

    expect(res.status).toBe(503);
    expect(mock.calls).toHaveLength(0);
  });
});
