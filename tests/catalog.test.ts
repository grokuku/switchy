/**
 * Catalogue — fournisseurs & services (Lot 2). Aucun accès réseau.
 *
 * Couvre : CRUD fournisseurs (secret jamais réaffiché, champ vide = inchangé,
 * null = efface), CRUD services (validation : nom dupliqué, providerId
 * inexistant, bornes), persistance du fichier (relecture après écriture) et
 * permissions (0600 / 0700).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { resetCatalogCache } from "../src/catalog-store.js";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";

let env: TestEnv;
let key: string;

beforeEach(async () => {
  env = makeTestEnv();
  key = await createApiKey(env.app);
});

afterEach(() => env.cleanup());

const auth = (r: request.Test) => r.set("X-API-Key", key);

const validProvider = (over = {}) => ({
  id: "ollama-cloud",
  label: "Ollama Cloud",
  type: "openai-compatible",
  baseUrl: "https://ollama.com/v1",
  nativeUrl: "https://ollama.com/api",
  apiKey: "sk-secret-123",
  enabled: true,
  ...over,
});

describe("providers — CRUD", () => {
  it("crée un fournisseur ; la clé n'est jamais réaffichée", async () => {
    const res = await auth(request(env.app).post("/api/providers")).send(validProvider());
    expect(res.status).toBe(201);
    expect(res.body.provider.id).toBe("ollama-cloud");
    expect(res.body.provider.apiKey).toEqual({ configured: true, preview: "••••" });
    expect(JSON.stringify(res.body)).not.toContain("sk-secret-123");

    const list = await auth(request(env.app).get("/api/providers"));
    expect(list.status).toBe(200);
    expect(list.body.providers).toHaveLength(1);
    expect(list.body.providers[0].apiKey).toEqual({ configured: true, preview: "••••" });
    expect(JSON.stringify(list.body)).not.toContain("sk-secret-123");
  });

  it("champ apiKey vide = inchangé", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    const res = await auth(request(env.app).put("/api/providers/ollama-cloud")).send({
      label: "Ollama Cloud v2",
      apiKey: "",
    });
    expect(res.status).toBe(200);
    expect(res.body.provider.label).toBe("Ollama Cloud v2");
    expect(res.body.provider.apiKey).toEqual({ configured: true, preview: "••••" });
  });

  it("apiKey: null efface la clé (sentinelle)", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    const res = await auth(request(env.app).put("/api/providers/ollama-cloud")).send({ apiKey: null });
    expect(res.status).toBe(200);
    expect(res.body.provider.apiKey).toEqual({ configured: false, preview: "••••" });
  });

  it("id dupliqué → 409", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    const res = await auth(request(env.app).post("/api/providers")).send(validProvider({ label: "Autre" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("validation : champs requis, type, URL, bornes", async () => {
    const res = await auth(request(env.app).post("/api/providers")).send({
      id: "x",
      label: "",
      type: "nimporte",
      baseUrl: "not-a-url",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.errors.join(" ")).toMatch(/label/);
    expect(res.body.errors.join(" ")).toMatch(/type/);
    expect(res.body.errors.join(" ")).toMatch(/baseUrl/);
  });

  it("suppression refusée si un service utilise le fournisseur", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    await auth(request(env.app).post("/api/services")).send(validService());
    const res = await auth(request(env.app).delete("/api/providers/ollama-cloud"));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/used by service/);
  });

  it("suppression d'un fournisseur inexistant → 404", async () => {
    const res = await auth(request(env.app).delete("/api/providers/inexistant"));
    expect(res.status).toBe(404);
  });

  it("maxConcurrency : accepté (≥ 1), absent = défaut global, 0 refusé", async () => {
    const withLimit = await auth(request(env.app).post("/api/providers")).send(validProvider({ maxConcurrency: 3 }));
    expect(withLimit.status).toBe(201);
    expect(withLimit.body.provider.maxConcurrency).toBe(3);

    const noLimit = await auth(request(env.app)
      .post("/api/providers"))
      .send(validProvider({ id: "sans-limite", label: "Sans limite" }));
    expect(noLimit.status).toBe(201);
    expect(noLimit.body.provider.maxConcurrency).toBeUndefined();

    const zero = await auth(request(env.app)
      .post("/api/providers"))
      .send(validProvider({ id: "zero", label: "Zero", maxConcurrency: 0 }));
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe("VALIDATION_ERROR");
    expect(zero.body.errors.join(" ")).toMatch(/maxConcurrency/);
  });

  it("mise à jour : maxConcurrency null → retour au défaut global", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider({ maxConcurrency: 5 }));
    const res = await auth(request(env.app).put("/api/providers/ollama-cloud")).send({ maxConcurrency: null });
    expect(res.status).toBe(200);
    expect(res.body.provider.maxConcurrency).toBeUndefined();
  });
});

const validService = (over = {}) => ({
  name: "Deepseek-Fast",
  description: "Rapide, bon marché",
  principal: { providerId: "ollama-cloud", model: "deepseek-v3", reasoning: "low" },
  fallbacks: [{ providerId: "ollama-cloud", model: "llama3.3", reasoning: "off" }],
  contextWindow: 128000,
  maxOutputTokens: 8192,
  vision: false,
  prioritaire: true,
  enabled: true,
  ...over,
});

describe("services — CRUD & validation", () => {
  beforeEach(async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
  });

  it("crée un service complet", async () => {
    const res = await auth(request(env.app).post("/api/services")).send(validService());
    expect(res.status).toBe(201);
    expect(res.body.service.name).toBe("Deepseek-Fast");
    expect(res.body.service.principal.model).toBe("deepseek-v3");
    expect(res.body.service.fallbacks).toHaveLength(1);
    expect(res.body.service.prioritaire).toBe(true);
    // `reservations` n'existe plus au niveau du service.
    expect(res.body.service.reservations).toBeUndefined();
  });

  it("nom dupliqué → 409", async () => {
    await auth(request(env.app).post("/api/services")).send(validService());
    const res = await auth(request(env.app).post("/api/services")).send(validService());
    expect(res.status).toBe(409);
  });

  it("providerId inexistant → 400", async () => {
    const res = await auth(request(env.app).post("/api/services")).send(
      validService({ principal: { providerId: "inconnu", model: "m", reasoning: "off" } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toMatch(/unknown provider/);
  });

  it("bornes numériques respectées", async () => {
    const res = await auth(request(env.app).post("/api/services")).send(validService({ contextWindow: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toMatch(/contextWindow/);

    const res2 = await auth(request(env.app).post("/api/services")).send(
      validService({ name: "Autre", maxOutputTokens: -5 }),
    );
    expect(res2.status).toBe(400);
    expect(res2.body.errors.join(" ")).toMatch(/maxOutputTokens/);
  });

  it("mise à jour partielle (enabled) puis suppression", async () => {
    await auth(request(env.app).post("/api/services")).send(validService());
    const upd = await auth(request(env.app).put("/api/services/Deepseek-Fast")).send({ enabled: false });
    expect(upd.status).toBe(200);
    expect(upd.body.service.enabled).toBe(false);
    expect(upd.body.service.contextWindow).toBe(128000);

    const del = await auth(request(env.app).delete("/api/services/Deepseek-Fast"));
    expect(del.status).toBe(204);

    const list = await auth(request(env.app).get("/api/services"));
    expect(list.body.services).toHaveLength(0);
  });

  it("service inexistant → 404", async () => {
    const res = await auth(request(env.app).put("/api/services/Fantome")).send({ enabled: false });
    expect(res.status).toBe(404);
  });
});

describe("catalogue — persistance & permissions", () => {
  it("le catalogue est relu après écriture (source de vérité fichier)", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    const file = join(env.dir, "catalog.json");
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    expect(raw.providers[0].id).toBe("ollama-cloud");
    expect(raw.providers[0].apiKey).toBe("sk-secret-123"); // clé stockée en clair sur disque (présentée au fournisseur)

    const list = await auth(request(env.app).get("/api/providers"));
    expect(list.body.providers[0].id).toBe("ollama-cloud");
  });

  it.skipIf(process.platform === "win32")("fichier 0600 et répertoire 0700", async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
    const fileMode = statSync(join(env.dir, "catalog.json")).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(env.dir).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("migration douce : un ancien catalogue (reservations) reste lisible sans casser", async () => {
    // Fichier d'une version antérieure : service avec `reservations`, fournisseur
    // sans `maxConcurrency`, service sans `prioritaire`.
    const legacy = {
      version: 1,
      providers: [
        {
          id: "ollama-cloud",
          label: "Ollama Cloud",
          type: "openai-compatible",
          baseUrl: "https://ollama.com/v1",
          enabled: true,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      services: [
        {
          name: "Legacy",
          description: "ancien",
          principal: { providerId: "ollama-cloud", model: "m", reasoning: "off" },
          fallbacks: [],
          contextWindow: 8000,
          maxOutputTokens: 1000,
          vision: false,
          reservations: { light: 1, heavy: 2 },
          enabled: true,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(env.dir, "catalog.json"), JSON.stringify(legacy), { mode: 0o600 });
    resetCatalogCache();

    const services = await auth(request(env.app).get("/api/services"));
    expect(services.status).toBe(200);
    expect(services.body.services[0].name).toBe("Legacy");
    expect(services.body.services[0].reservations).toBeUndefined();
    expect(services.body.services[0].prioritaire).toBe(false);

    const providers = await auth(request(env.app).get("/api/providers"));
    expect(providers.body.providers[0].maxConcurrency).toBeUndefined();
  });
});

describe("étapes — bouton on/off par étape (`enabled`)", () => {
  beforeEach(async () => {
    await auth(request(env.app).post("/api/providers")).send(validProvider());
  });

  it("une étape sans `enabled` est ACTIVÉE (rétro-compatibilité)", async () => {
    const res = await auth(request(env.app).post("/api/services")).send(validService());
    expect(res.status).toBe(201);
    expect(res.body.service.principal.enabled).toBe(true);
    expect(res.body.service.fallbacks[0].enabled).toBe(true);
  });

  it("`enabled: false` est enregistré et persiste (fichier = source de vérité)", async () => {
    const created = await auth(request(env.app).post("/api/services")).send(
      validService({
        fallbacks: [{ providerId: "ollama-cloud", model: "llama3.3", reasoning: "off", enabled: false }],
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.service.fallbacks[0].enabled).toBe(false);
    // Le principal reste actif : le service continue de fonctionner.
    expect(created.body.service.principal.enabled).toBe(true);

    const raw = JSON.parse(readFileSync(join(env.dir, "catalog.json"), "utf-8"));
    expect(raw.services[0].fallbacks[0].enabled).toBe(false);
  });

  it("bascule d'UNE étape par PUT (sans toucher aux autres étapes)", async () => {
    await auth(request(env.app).post("/api/services")).send(validService());
    const upd = await auth(request(env.app).put("/api/services/Deepseek-Fast")).send({
      principal: { providerId: "ollama-cloud", model: "deepseek-v3", reasoning: "low", enabled: false },
      fallbacks: [{ providerId: "ollama-cloud", model: "llama3.3", reasoning: "off" }],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.service.principal.enabled).toBe(false);
    // Un `fallbacks` réenvoyé SANS le champ revient à « activée » (défaut documenté).
    expect(upd.body.service.fallbacks[0].enabled).toBe(true);
  });

  it("`enabled` non booléen → 400 (booléen STRICT, pas de coercition)", async () => {
    const res = await auth(request(env.app).post("/api/services")).send(
      validService({
        principal: { providerId: "ollama-cloud", model: "deepseek-v3", reasoning: "low", enabled: "false" },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toMatch(/principal\.enabled: required, must be a boolean/);
  });

  it("catalogue antérieur : une étape sans le champ est ACTIVÉE à la lecture", async () => {
    const legacy = {
      version: 1,
      providers: [
        {
          id: "ollama-cloud",
          label: "Ollama",
          type: "openai-compatible",
          baseUrl: "https://ollama.example/v1",
          enabled: true,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      services: [
        {
          name: "Ancien",
          description: "",
          principal: { providerId: "ollama-cloud", model: "m", reasoning: "off" },
          fallbacks: [{ providerId: "ollama-cloud", model: "m2", reasoning: "off" }],
          contextWindow: 8000,
          maxOutputTokens: 1000,
          vision: false,
          enabled: true,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(join(env.dir, "catalog.json"), JSON.stringify(legacy), { mode: 0o600 });
    resetCatalogCache();

    const res = await auth(request(env.app).get("/api/services"));
    expect(res.status).toBe(200);
    expect(res.body.services[0].principal.enabled).toBe(true);
    expect(res.body.services[0].fallbacks[0].enabled).toBe(true);
  });
});
