/**
 * Socle statique (dossier `public/`) : index, fichiers, absence de fallback
 * SPA, traversée de chemin refusée, et non-capture des routes réservées.
 * Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("socle statique — index", () => {
  it("GET / → 200 text/html (les deux onglets sont présents)", async () => {
    const res = await request(env.app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html\b/);
    expect(res.text).toContain("Services");
    expect(res.text).toContain("Réglages");
    expect(res.text).toContain("app.js");
  });
});

describe("socle statique — fichiers", () => {
  it("GET /styles.css → 200 text/css", async () => {
    const res = await request(env.app).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/css\b/);
    expect(res.text).toContain("--switchy-bg");
  });

  it("GET /app.js → 200 javascript", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^(text|application)\/javascript\b/);
    expect(res.text).toContain("activate");
  });
});

describe("socle statique — pas de fallback SPA", () => {
  it("route inconnue → 404 (pas d'index servi)", async () => {
    const res = await request(env.app).get("/nimportequoi");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Passerelle LLM");
  });

  it("chemin profond inconnu → 404", async () => {
    const res = await request(env.app).get("/sous/dossier/inconnu");
    expect(res.status).toBe(404);
  });

  it("préfixe réservé /api (non implémenté en Lot 1) → 404, pas l'index", async () => {
    const res = await request(env.app).get("/api/services");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("Passerelle LLM");
  });
});

describe("socle statique — traversée de chemin", () => {
  it("..%2f encodé → 403 ou 404, jamais package.json", async () => {
    const res = await request(env.app).get("/..%2fpackage.json");
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain('"name": "switchy"');
  });

  it("../ littéral → 403 ou 404, jamais src/index.ts", async () => {
    const res = await request(env.app).get("/../src/index.ts");
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain("createApp");
  });
});
