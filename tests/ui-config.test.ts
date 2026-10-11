/**
 * Interface de configuration (Lot 2) — vérifications STATIQUES (pas de
 * navigateur) : les trois onglets sont présents, app.js parle aux endpoints
 * `/api/*` avec l'en-tête de clé, et les briques sont branchées.
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

describe("interface — onglets et endpoints", () => {
  it("index.html expose les trois onglets et leurs panneaux", async () => {
    const res = await request(env.app).get("/");
    expect(res.status).toBe(200);
    for (const tab of ["services", "providers", "settings"]) {
      expect(res.text).toContain(`data-tab="${tab}"`);
      expect(res.text).toContain(`id="panel-${tab}"`);
    }
    expect(res.text).toContain("Fournisseurs");
  });

  it("app.js appelle l'API avec la clé et ouvre des modales de confirmation", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("/api/providers");
    expect(res.text).toContain("/api/services");
    expect(res.text).toContain("/api/settings");
    expect(res.text).toContain("/api/keys");
    expect(res.text).toContain("X-API-Key");
    // Confirmations destructives via la brique modal + notifications toast.
    expect(res.text).toContain("modal.confirm");
    expect(res.text).toContain("HolafModal");
    expect(res.text).toContain("HolafToast");
  });

  it("styles.css reste en pleine largeur (aucun max-width sur le conteneur)", async () => {
    const res = await request(env.app).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.text).toContain(".cards-grid");
    expect(res.text).toMatch(/\.content\s*\{[^}]*width:\s*100%/);
  });
});
