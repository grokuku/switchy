/**
 * Exposition des services au format OpenAI — `GET /v1/models` et
 * `GET /v1/models/:id`.
 *
 * Un SERVICE du catalogue EST le « modèle » du client : son nom est la valeur
 * de `body.model` de `POST /v1/chat/completions`. Ces suites vérifient la
 * forme OpenAI, l'authentification (même garde que le relais), le filtrage des
 * services désactivés, l'absence de tout champ sensible et la non-régression du
 * relais `/v1/chat/completions`. Le catalogue vient d'un dossier temporaire.
 *
 * AUCUN réseau : les routes de liste n'appellent aucun fournisseur ; la suite de
 * non-régression du relais mocke `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  createApiKey,
  TEST_API_KEY,
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

/** Fournisseur `p1` — sa clé et son URL ne doivent JAMAIS apparaître en réponse. */
const PROVIDER_SECRET = "sk-SECRET_PROVIDER_NEVER_EXPOSED";
const PROVIDER_BASE_URL = "https://fournisseur-prive.example/v1";

async function seedCatalog(): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Fournisseur 1",
    type: "openai-compatible",
    baseUrl: PROVIDER_BASE_URL,
    apiKey: PROVIDER_SECRET,
  });
  await seedService(env.app, {
    name: "chat",
    description: "Service de discussion généraliste",
    principal: step("p1", "model-a"),
    fallbacks: [],
    contextWindow: 128000,
    maxOutputTokens: 8000,
    vision: true,
    enabled: true,
  });
  await seedService(env.app, {
    name: "rapide",
    description: "Service rapide et léger",
    principal: step("p1", "model-b"),
    fallbacks: [],
    contextWindow: 32000,
    maxOutputTokens: 2000,
    vision: false,
    enabled: true,
  });
  // Désactivé : ne doit apparaître NI en liste NI en détail.
  await seedService(env.app, {
    name: "archive",
    description: "Service désactivé",
    principal: step("p1", "model-c"),
    fallbacks: [],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: false,
  });
}

describe("GET /v1/models — liste au format OpenAI", () => {
  it("avec une clé valide : objet `list`, id = nom du service, métadonnées OpenAI + Switchy", async () => {
    await seedCatalog();

    const res = await api(env.app).get("/v1/models");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);

    const ids = (res.body.data as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(["chat", "rapide"]);

    const chat = (res.body.data as Record<string, unknown>[]).find((m) => m.id === "chat")!;
    expect(chat.object).toBe("model");
    expect(chat.owned_by).toBe("switchy");
    expect(typeof chat.created).toBe("number");
    expect(chat.created as number).toBeGreaterThan(0);
    // Métadonnées Switchy, EN PLUS des champs standard.
    expect(chat.context_length).toBe(128000);
    expect(chat.max_output_tokens).toBe(8000);
    expect(chat.capabilities).toEqual({ vision: true });

    const rapide = (res.body.data as Record<string, unknown>[]).find((m) => m.id === "rapide")!;
    expect(rapide.capabilities).toEqual({ vision: false });
  });

  it("`Authorization: Bearer` fonctionne aussi (même garde que /v1/chat/completions)", async () => {
    await seedCatalog();
    const res = await request(env.app).get("/v1/models").set("Authorization", `Bearer ${TEST_API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
  });

  it("sans clé → 401 JSON (jamais une page HTML)", async () => {
    await seedCatalog();
    const res = await request(env.app).get("/v1/models");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("clé invalide → 401 JSON", async () => {
    await seedCatalog();
    const res = await request(env.app).get("/v1/models").set("X-API-Key", "switchy_deadbeef");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("n'importe quel client avec une clé valide lit la liste (aucune restriction par client)", async () => {
    await seedCatalog();
    const other = await createApiKey(env.app, "un-client-quelconque");
    const res = await request(env.app).get("/v1/models").set("X-API-Key", other);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("services désactivés absents de la liste", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/models");
    const ids = (res.body.data as { id: string }[]).map((m) => m.id);
    expect(ids).not.toContain("archive");
  });

  it("catalogue vide → liste vide (forme OpenAI conservée)", async () => {
    const res = await api(env.app).get("/v1/models");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ object: "list", data: [] });
  });

  it("aucun champ sensible : ni apiKey, ni baseUrl, ni identifiant de fournisseur", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/models");

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(PROVIDER_SECRET);
    expect(raw).not.toContain(PROVIDER_BASE_URL);
    expect(raw).not.toContain("fournisseur-prive.example");
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("baseUrl");
    expect(raw).not.toContain("providerId");
    expect(raw).not.toContain("nativeUrl");

    for (const model of res.body.data as Record<string, unknown>[]) {
      expect(Object.keys(model).sort()).toEqual([
        "capabilities",
        "context_length",
        "created",
        "description",
        "id",
        "max_output_tokens",
        "object",
        "owned_by",
      ]);
      expect(model.owned_by).toBe("switchy");
    }
  });
});

describe("GET /v1/models/:id — détail d'un service", () => {
  it("id connu → objet unique `model`", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/models/chat");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("chat");
    expect(res.body.object).toBe("model");
    expect(res.body.owned_by).toBe("switchy");
    expect(res.body.context_length).toBe(128000);
    expect(res.body.capabilities).toEqual({ vision: true });
    expect(JSON.stringify(res.body)).not.toContain(PROVIDER_SECRET);
    expect(JSON.stringify(res.body)).not.toContain("baseUrl");
  });

  it("id inconnu → 404 JSON", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/models/inexistant");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("id désactivé → 404 JSON (même réponse qu'un id inconnu)", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/models/archive");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("sans clé → 401 JSON avant toute lecture du catalogue", async () => {
    await seedCatalog();
    const res = await request(env.app).get("/v1/models/chat");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});

describe("non-régression", () => {
  it("POST /v1/chat/completions fonctionne toujours (model = nom du service)", async () => {
    await seedCatalog();
    mock = installMockFetch(() =>
      jsonResponse({ id: "cmpl-1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );

    const res = await api(env.app).post("/v1/chat/completions").send({
      model: "chat",
      messages: [{ role: "user", content: "bonjour" }],
    });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    // Le nom du SERVICE devient bien le modèle de l'étape, côté fournisseur.
    const sent = JSON.parse(String(mock.calls[0].init.body)) as { model: string };
    expect(sent.model).toBe("model-a");
  });

  it("POST /v1/chat/completions sans `model` reste 400 (contrat inchangé)", async () => {
    await seedCatalog();
    const res = await api(env.app).post("/v1/chat/completions").send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("/api/services expose toujours TOUS les services (désactivés compris)", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/api/services");
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(3);
  });

  it("GET /v1/models ne capte pas les autres routes /v1 (chemin inconnu → 404)", async () => {
    await seedCatalog();
    const res = await api(env.app).get("/v1/inexistant");
    expect(res.status).toBe(404);
  });
});
