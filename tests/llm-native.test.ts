/**
 * Relais de l'API NATIVE des fournisseurs (Lot 3) — `/api/native/:providerId/*`
 * → `nativeUrl`. La découverte des modèles Ollama (`/api/tags`) et les routes
 * de capacités (`/api/show`) doivent continuer de fonctionner : ce relais est
 * un passthrough fidèle. Aucun réseau : `fetch` est mocké.
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

describe("relais natif — /api/native/:providerId/*", () => {
  it("GET /api/tags est relayé tel quel vers nativeUrl, avec la clé DU fournisseur", async () => {
    await seedProvider(env.app, {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      type: "ollama-native",
      baseUrl: "https://ollama.com/v1",
      nativeUrl: "https://ollama.com",
      apiKey: "ollama-secret",
    });
    mock = installMockFetch(() =>
      jsonResponse({ models: [{ name: "deepseek-v3.1:671b", model: "deepseek-v3.1:671b" }] }),
    );

    const res = await api(env.app).get("/api/native/ollama-cloud/api/tags");
    expect(res.status).toBe(200);
    expect(res.body.models[0].name).toBe("deepseek-v3.1:671b");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://ollama.com/api/tags");
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer ollama-secret");
  });

  it("nativeUrl absent → dérivé du baseUrl (suffixe /v1 retiré), POST /api/show relayé", async () => {
    await seedProvider(env.app, {
      id: "ollama-local",
      label: "Ollama local",
      type: "ollama-native",
      baseUrl: "https://ollama.example:11434/v1",
    });
    mock = installMockFetch((url) => {
      if (url.includes("/api/show")) return jsonResponse({ capabilities: ["completion", "tools"] });
      return jsonResponse({ models: [] });
    });

    const res = await api(env.app)
      .post("/api/native/ollama-local/api/show")
      .send({ name: "qwen3:8b" });
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toContain("tools");
    expect(mock.calls[0].url).toBe("https://ollama.example:11434/api/show");
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as { name?: string };
    expect(sent.name).toBe("qwen3:8b");
  });

  it("la chaîne de requête est préservée et le provider inconnu → 404", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "P1",
      type: "ollama-native",
      baseUrl: "https://p1.example/v1",
      nativeUrl: "https://p1.example",
    });
    mock = installMockFetch(() => jsonResponse({ ok: true }));

    const res = await api(env.app).get("/api/native/p1/api/tags?limit=10");
    expect(res.status).toBe(200);
    expect(mock.calls[0].url).toBe("https://p1.example/api/tags?limit=10");

    const unknown = await api(env.app).get("/api/native/inconnu/api/tags");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("NOT_FOUND");
    expect(mock.calls).toHaveLength(1);
  });

  it("traversée de chemin (`..`) refusée", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "P1",
      type: "ollama-native",
      baseUrl: "https://p1.example/v1",
      nativeUrl: "https://p1.example",
    });
    mock = installMockFetch(() => jsonResponse({}));

    const res = await api(env.app).get("/api/native/p1/api/../../etc/passwd");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mock.calls).toHaveLength(0);
  });
});
