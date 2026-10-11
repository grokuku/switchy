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

  it("app.js appelle l'API par la session (cookie + CSRF) et ouvre des modales", async () => {
    const res = await request(env.app).get("/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("/api/providers");
    expect(res.text).toContain("/api/services");
    expect(res.text).toContain("/api/settings");
    expect(res.text).toContain("/api/keys");
    // Connexion par mot de passe + session, CSRF en double-submit.
    expect(res.text).toContain("/api/session");
    expect(res.text).toContain("X-CSRF-Token");
    // Plus de « clé d'accès du navigateur » ni de mode amorçage.
    expect(res.text).not.toContain("X-API-Key");
    expect(res.text).not.toContain("switchy.apiKey");
    // Confirmations destructives via la brique modal + notifications toast.
    expect(res.text).toContain("modal.confirm");
    expect(res.text).toContain("HolafModal");
    expect(res.text).toContain("HolafToast");
  });

  it("écran de connexion SEUL : #app-shell masqué, aucun contenu avant auth", async () => {
    const res = await request(env.app).get("/");
    expect(res.status).toBe(200);
    // L'écran de connexion est la page d'entrée...
    expect(res.text).toContain('id="login-screen"');
    expect(res.text).toContain('id="login-password"');
    // ...et le contenu applicatif est masqué par défaut (pas de flash).
    expect(res.text).toMatch(/<div id="app-shell" hidden>/);
    // Plus de carte « clé d'accès du navigateur ».
    expect(res.text).not.toContain('id="access-card"');
    expect(res.text).not.toContain('id="api-key-form"');
  });

  it("styles.css reste en pleine largeur (aucun max-width sur le conteneur)", async () => {
    const res = await request(env.app).get("/styles.css");
    expect(res.status).toBe(200);
    expect(res.text).toContain(".cards-grid");
    expect(res.text).toMatch(/\.content\s*\{[^}]*width:\s*100%/);
  });
});
