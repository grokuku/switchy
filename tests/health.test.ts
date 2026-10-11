/**
 * Contrat de santé : `GET /health` = {service:"switchy",status:"ok",version},
 * avec la version lue dans package.json. Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
) as { name: string; version: string };

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("GET /health", () => {
  it("renvoie le contrat {service, status, version} + compteurs", async () => {
    const res = await request(env.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    // Forme de base INCHANGÉE ; les compteurs du Lot 2 s'ajoutent sans la casser.
    expect(res.body).toMatchObject({ service: "switchy", status: "ok", version: pkg.version });
    expect(res.body.providers).toBe(0);
    expect(res.body.services).toBe(0);
  });

  it("les compteurs reflètent le catalogue", async () => {
    const key = await createApiKey(env.app);
    await request(env.app)
      .post("/api/providers")
      .set("X-API-Key", key)
      .send({ id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://example.com/v1" });
    const res = await request(env.app).get("/health");
    expect(res.body.providers).toBe(1);
  });

  it("la version servie est celle de package.json (format MAJOR.MINOR.PATCH)", async () => {
    const res = await request(env.app).get("/health");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.body.version).toBe(pkg.version);
  });

  it("ne dépend pas des variables d'environnement du serveur", async () => {
    const other = makeTestEnv({ SWITCHY_PORT: "9999", SWITCHY_HOST: "127.0.0.1" });
    try {
      const res = await request(other.app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("switchy");
    } finally {
      other.cleanup();
    }
  });
});
