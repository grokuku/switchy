/**
 * Authentification par clé d'API (outils) — Lot 2, révisé Lot 4.
 *
 * ⚠️ Plus de « mode amorçage » : l'API n'est jamais ouverte. Elle accepte une
 * clé d'API (outils : `Authorization: Bearer` ou `X-API-Key`) OU une session
 * d'administration (navigateur, voir `session.test.ts`). Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("clés d'API — protection (plus de mode amorçage)", () => {
  it("sans clé ni session → 401 JSON (l'API n'est jamais ouverte)", async () => {
    const res = await request(env.app).get("/api/services");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("la clé n'est renvoyée qu'à la création ; l'aperçu est masqué ensuite", async () => {
    const secret = await createApiKey(env.app, "pi-web");
    expect(secret).toMatch(/^switchy_[0-9a-f]{32}$/);

    const list = await request(env.app).get("/api/keys").set("X-API-Key", secret);
    expect(list.status).toBe(200);
    expect(list.body.keys).toHaveLength(1);
    expect(list.body.keys[0].keyPreview).toMatch(/…$/);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain("scrypt:");
  });

  it("sans clé → 401 ; avec la bonne clé → 200", async () => {
    const key = await createApiKey(env.app, "yuki");

    const missing = await request(env.app).get("/api/settings");
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe("UNAUTHORIZED");

    const bad = await request(env.app).get("/api/settings").set("X-API-Key", "switchy_deadbeef");
    expect(bad.status).toBe(401);

    const ok = await request(env.app).get("/api/settings").set("X-API-Key", key);
    expect(ok.status).toBe(200);

    const bearer = await request(env.app).get("/api/services").set("Authorization", `Bearer ${key}`);
    expect(bearer.status).toBe(200);
  });

  it("clé d'environnement acceptée (SWITCHY_API_KEY)", async () => {
    const other = makeTestEnv({ SWITCHY_API_KEY: "switchy_env_bootstrap_key" });
    try {
      const missing = await request(other.app).get("/api/services");
      expect(missing.status).toBe(401);

      const ok = await request(other.app)
        .get("/api/services")
        .set("X-API-Key", "switchy_env_bootstrap_key");
      expect(ok.status).toBe(200);
    } finally {
      other.cleanup();
    }
  });

  it("les clés d'API des outils écrivent les réglages SANS CSRF ni garde-fou mot de passe", async () => {
    const key = await createApiKey(env.app, "pi-web");
    // Mot de passe admin resté au défaut : les accès scriptés restent inchangés.
    const res = await request(env.app)
      .post("/api/settings")
      .set("X-API-Key", key)
      .send({ settings: { SWITCHY_CONCURRENCY: "7" } });
    expect(res.status).toBe(200);
    expect(res.body.updated).toContain("SWITCHY_CONCURRENCY");
  });

  it("révocation d'une clé inconnue → 404", async () => {
    const key = await createApiKey(env.app, "temp");
    const res = await request(env.app).delete("/api/keys/switchyk_inconnu").set("X-API-Key", key);
    expect(res.status).toBe(404);
  });
});
