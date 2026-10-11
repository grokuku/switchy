/**
 * Authentification par clé d'API (Lot 2). Aucun accès réseau.
 *
 * Mode amorçage : tant qu'aucune clé n'existe, l'API est ouverte (configuration
 * possible depuis l'interface). Dès qu'une clé existe, elle est exigée.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("clés d'API — amorçage & protection", () => {
  it("API ouverte tant qu'aucune clé n'existe (mode amorçage)", async () => {
    const res = await request(env.app).get("/api/services");
    expect(res.status).toBe(200);
    expect(res.body.services).toEqual([]);
  });

  it("la clé n'est renvoyée qu'à la création ; l'aperçu est masqué ensuite", async () => {
    const created = await request(env.app).post("/api/keys").send({ name: "pi-web" });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^switchy_[0-9a-f]{32}$/);
    expect(created.body.key.keyPreview).toMatch(/…$/);

    const list = await request(env.app).get("/api/keys").set("X-API-Key", created.body.secret);
    expect(list.status).toBe(200);
    expect(list.body.authRequired).toBe(true);
    expect(list.body.keys[0].keyPreview).toBe(created.body.key.keyPreview);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    expect(JSON.stringify(list.body)).not.toContain("scrypt:");
  });

  it("sans clé (après création) → 401 ; avec la bonne clé → 200", async () => {
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

  it("révocation d'une clé → 404 sur une clé inconnue", async () => {
    const res = await request(env.app).delete("/api/keys/switchyk_inconnu");
    expect(res.status).toBe(404);
  });
});
