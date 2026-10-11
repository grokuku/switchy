/**
 * Routes de découverte des modèles — `/api/providers/:id/models` et
 * `/api/providers/:id/models/:model`. AUCUN réseau : `fetch` est mocké.
 *
 * Couvre : OpenAI-compatible (`GET {baseUrl}/models`), Ollama natif
 * (`GET {nativeUrl}/api/tags` + `POST {nativeUrl}/api/show`), clé DU
 * fournisseur, fournisseur injoignable (502), 401 (message auth clair),
 * liste vide, capacités détectées vs non exposées, et identifiant avec `/`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { api, makeTestEnv, installMockFetch, seedProvider, jsonResponse, type TestEnv } from "./helpers.js";

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

async function seedOpenAi(): Promise<void> {
  await seedProvider(env.app, {
    id: "openai",
    label: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.example/v1",
    apiKey: "sk-openai-secret",
  });
}

async function seedOllama(): Promise<void> {
  await seedProvider(env.app, {
    id: "ollama",
    label: "Ollama",
    type: "ollama-native",
    baseUrl: "https://ollama.example/v1",
    nativeUrl: "https://ollama.example",
    apiKey: "ollama-secret",
  });
}

describe("liste des modèles", () => {
  it("OpenAI-compatible : GET {baseUrl}/models avec la clé du fournisseur", async () => {
    await seedOpenAi();
    mock = installMockFetch(() => jsonResponse({ data: [{ id: "gpt-x" }, { id: "gpt-y" }, { id: "audio-z" }] }));

    const res = await api(env.app).get("/api/providers/openai/models");
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(["gpt-x", "gpt-y", "audio-z"]);
    expect(mock.calls[0].url).toBe("https://api.openai.example/v1/models");
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer sk-openai-secret");
  });

  it("Ollama natif : GET {nativeUrl}/api/tags (clé du fournisseur, jamais celle du client)", async () => {
    await seedOllama();
    mock = installMockFetch(() =>
      jsonResponse({ models: [{ name: "qwen3:8b", model: "qwen3:8b", size: 5_000_000 }, { name: "llama3.3" }] }),
    );

    const res = await api(env.app).get("/api/providers/ollama/models");
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(["qwen3:8b", "llama3.3"]);
    expect(mock.calls[0].url).toBe("https://ollama.example/api/tags");
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer ollama-secret");
  });

  it("liste vide → 200 avec un tableau vide (pas d'erreur)", async () => {
    await seedOpenAi();
    mock = installMockFetch(() => jsonResponse({ data: [] }));
    const res = await api(env.app).get("/api/providers/openai/models");
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("fournisseur injoignable → 502 message clair", async () => {
    await seedOpenAi();
    mock = installMockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await api(env.app).get("/api/providers/openai/models");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PROVIDER_UNREACHABLE");
  });

  it("401 amont → 502 PROVIDER_AUTH_ERROR (clé absente ou invalide)", async () => {
    await seedOpenAi();
    mock = installMockFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
    const res = await api(env.app).get("/api/providers/openai/models");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PROVIDER_AUTH_ERROR");
  });

  it("fournisseur inconnu → 404", async () => {
    mock = installMockFetch(() => jsonResponse({ data: [] }));
    const res = await api(env.app).get("/api/providers/inconnu/models");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("capacités d'un modèle", () => {
  it("Ollama natif : POST /api/show → capacités + taille de contexte pré-remplies", async () => {
    await seedOllama();
    mock = installMockFetch((url, init) => {
      expect(url).toBe("https://ollama.example/api/show");
      expect(init.method).toBe("POST");
      return jsonResponse({
        capabilities: ["completion", "tools", "thinking", "vision"],
        model_info: { "qwen3.context_length": 32768, "qwen3.attention.head_count": 8 },
      });
    });

    const res = await api(env.app).get("/api/providers/ollama/models/qwen3:8b");
    expect(res.status).toBe(200);
    expect(res.body.model.detected).toBe(true);
    expect(res.body.model.capabilities).toEqual({ completion: true, tools: true, thinking: true, vision: true });
    expect(res.body.model.contextWindow).toBe(32768);
    expect(res.body.model.reasoningLevels).toEqual(["off", "low", "medium", "high"]);
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as { model?: string };
    expect(sent.model).toBe("qwen3:8b");
  });

  it("Ollama natif sans capacité « thinking » → réflexion limitée à « off »", async () => {
    await seedOllama();
    mock = installMockFetch(() => jsonResponse({ capabilities: ["completion"], model_info: {} }));
    const res = await api(env.app).get("/api/providers/ollama/models/embed");
    expect(res.status).toBe(200);
    expect(res.body.model.detected).toBe(true);
    expect(res.body.model.capabilities.thinking).toBe(false);
    expect(res.body.model.reasoningLevels).toEqual(["off"]);
  });

  it("OpenAI-compatible : capacités non exposées → detected=false + note (saisie manuelle)", async () => {
    await seedOpenAi();
    mock = installMockFetch(() => jsonResponse({}));
    const res = await api(env.app).get("/api/providers/openai/models/gpt-x");
    expect(res.status).toBe(200);
    expect(res.body.model.detected).toBe(false);
    expect(res.body.model.note).toMatch(/non exposées/);
    expect(res.body.model.reasoningLevels).toEqual(["off", "low", "medium", "high"]);
    expect(mock.calls).toHaveLength(0); // aucune requête réseau pour l'OpenAI-compatible
  });

  it("identifiant de modèle encodé avec `/` (route wildcard)", async () => {
    await seedOllama();
    mock = installMockFetch(() => jsonResponse({ capabilities: ["completion"], model_info: {} }));
    const res = await api(env.app).get("/api/providers/ollama/models/vendor%2Fmodel-x");
    expect(res.status).toBe(200);
    expect(res.body.model.model).toBe("vendor/model-x");
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as { model?: string };
    expect(sent.model).toBe("vendor/model-x");
  });
});
