/**
 * Réglages globaux (Lot 2) — patron Libry : source env/fichier/défaut, verrou
 * d'environnement, secret jamais réaffiché. Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";

let env: TestEnv;
let key: string;

beforeEach(async () => {
  env = makeTestEnv();
  key = await createApiKey(env.app);
});

afterEach(() => env.cleanup());

const auth = (r: request.Test) => r.set("X-API-Key", key);

/** Réglage par nom dans la réponse groupée. */
function findSetting(groups: Array<{ id: string; settings: Record<string, unknown>[] }>, name: string) {
  for (const group of groups) for (const s of group.settings) if (s.name === name) return s;
  return undefined;
}

describe("GET /api/settings", () => {
  it("renvoie les réglages groupés avec leur source « défaut »", async () => {
    const res = await auth(request(env.app).get("/api/settings"));
    expect(res.status).toBe(200);
    const concurrency = findSetting(res.body.groups, "SWITCHY_CONCURRENCY");
    expect(concurrency).toMatchObject({ source: "default", value: "3", type: "number", editable: true });
    const port = findSetting(res.body.groups, "SWITCHY_PORT");
    expect(port).toMatchObject({ restartRequired: true, source: "default" });
  });

  it("le secret d'API n'est jamais réaffiché", async () => {
    const res = await auth(request(env.app).get("/api/settings"));
    const secret = findSetting(res.body.groups, "SWITCHY_API_KEY");
    expect(secret).toMatchObject({ type: "secret", sensitive: true, preview: "••••" });
    expect(secret).not.toHaveProperty("value");
  });
});

describe("POST /api/settings", () => {
  it("écrit un réglage : la source passe à « fichier »", async () => {
    const res = await auth(request(env.app).post("/api/settings")).send({
      settings: { SWITCHY_CONCURRENCY: "5" },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toContain("SWITCHY_CONCURRENCY");
    const updated = findSetting(res.body.groups, "SWITCHY_CONCURRENCY");
    expect(updated).toMatchObject({ source: "file", value: "5" });
  });

  it("un réglage verrouillé par l'environnement est refusé (409)", async () => {
    process.env.SWITCHY_PORT = "9999";
    const res = await auth(request(env.app).post("/api/settings")).send({
      settings: { SWITCHY_PORT: "1234" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LOCKED_BY_ENV");
  });

  it("champ vide = inchangé (aucune écriture)", async () => {
    const res = await auth(request(env.app).post("/api/settings")).send({
      settings: { SWITCHY_LOG_LEVEL: "" },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
  });

  it("valeur invalide → 400 avec message clair", async () => {
    const res = await auth(request(env.app).post("/api/settings")).send({
      settings: { SWITCHY_CONCURRENCY: "abc", SWITCHY_LOG_LEVEL: "verbeux" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.errors.join(" ")).toMatch(/SWITCHY_CONCURRENCY/);
    expect(res.body.errors.join(" ")).toMatch(/SWITCHY_LOG_LEVEL/);
  });

  it("réglage inconnu → 400", async () => {
    const res = await auth(request(env.app).post("/api/settings")).send({
      settings: { SWITCHY_NIMPORTEQUOI: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("écrit config.json en 0600", async () => {
    await auth(request(env.app).post("/api/settings")).send({ settings: { SWITCHY_CONCURRENCY: "4" } });
    const file = join(env.dir, "config.json");
    expect(JSON.parse(readFileSync(file, "utf-8")).SWITCHY_CONCURRENCY).toBe("4");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
