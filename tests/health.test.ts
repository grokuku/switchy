/**
 * Contrat de santé : `GET /health` = {service:"switchy",status:"ok",version},
 * avec la version lue dans package.json. Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { makeTestEnv, type TestEnv } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
) as { name: string; version: string };

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("GET /health", () => {
  it("renvoie le contrat {service, status, version}", async () => {
    const res = await request(env.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ service: "switchy", status: "ok", version: pkg.version });
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
