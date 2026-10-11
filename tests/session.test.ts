/**
 * Connexion / session / CSRF / garde-fou mot de passe par défaut (Lot 4).
 *
 * L'humain s'authentifie par MOT DE PASSE (défaut `admin`) ; la session est un
 * cookie signé HMAC. Les clés d'API des outils restent un contrat distinct
 * (voir `auth.test.ts`). Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  DEFAULT_ADMIN_PASSWORD,
} from "../src/session-store.js";

let env: TestEnv;
let agent: ReturnType<typeof request.agent>;

beforeEach(() => {
  env = makeTestEnv();
  agent = request.agent(env.app);
});

afterEach(() => env.cleanup());

/** GET /api/session → jeton CSRF + état. */
async function sessionState() {
  const res = await agent.get("/api/session");
  expect(res.status).toBe(200);
  return res.body as { authenticated: boolean; passwordIsDefault?: boolean; csrfToken: string };
}

/** Connexion avec le mot de passe fourni ; renvoie la réponse. */
async function login(password: string, csrf: string) {
  return agent.post("/api/session/login").set("X-CSRF-Token", csrf).send({ password });
}

describe("GET /api/session", () => {
  it("anonyme : { authenticated:false } + jeton CSRF, cookie CSRF posé", async () => {
    const res = await agent.get("/api/session");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.passwordIsDefault).toBeUndefined();
    expect(typeof res.body.csrfToken).toBe("string");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.join(";")).toContain(`${CSRF_COOKIE}=`);
  });
});

describe("POST /api/session/login", () => {
  it("mot de passe par défaut `admin` → session + drapeau mot de passe par défaut", async () => {
    const { csrfToken } = await sessionState();
    const res = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.passwordIsDefault).toBe(true);
    const cookies = (res.headers["set-cookie"] as unknown as string[]).join(";");
    expect(cookies).toContain(`${SESSION_COOKIE}=`);
    expect(cookies).toMatch(/HttpOnly/);
    expect(cookies).toMatch(/SameSite=Strict/);
  });

  it("mauvais mot de passe → 401 INVALID_PASSWORD", async () => {
    const { csrfToken } = await sessionState();
    const res = await login("mauvais", csrfToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_PASSWORD");
  });

  it("sans en-tête CSRF → 403 CSRF_FAILED", async () => {
    await sessionState();
    const res = await agent.post("/api/session/login").send({ password: DEFAULT_ADMIN_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });

  it("la session ouvre les routes de configuration ; sans session → 401", async () => {
    const anonymous = await request(env.app).get("/api/settings");
    expect(anonymous.status).toBe(401);

    const { csrfToken } = await sessionState();
    await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const ok = await agent.get("/api/settings");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.groups)).toBe(true);
  });
});

describe("garde-fou mot de passe par défaut", () => {
  it("action sensible depuis une session (mdp défaut) → 403 PASSWORD_NOT_CHANGED", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const csrf = lg.body.csrfToken as string;

    const res = await agent
      .post("/api/settings")
      .set("X-CSRF-Token", csrf)
      .send({ settings: { SWITCHY_CONCURRENCY: "9" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_NOT_CHANGED");

    // La création de clé (outil) est aussi bloquée pour une session « défaut ».
    const key = await agent.post("/api/keys").set("X-CSRF-Token", csrf).send({ name: "pi-web" });
    expect(key.status).toBe(403);
    expect(key.body.code).toBe("PASSWORD_NOT_CHANGED");
  });
});

describe("POST /api/session/password", () => {
  it("change le mot de passe : invalide la session, la nouvelle marche, l'ancienne non", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const csrf = lg.body.csrfToken as string;

    const changed = await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", csrf)
      .send({ current: DEFAULT_ADMIN_PASSWORD, next: "nouveau-secret" });
    expect(changed.status).toBe(200);

    // La session courante est invalidée par le changement d'époque.
    const after = await agent.get("/api/session");
    expect(after.body.authenticated).toBe(false);

    // Ancien mot de passe refusé, nouveau accepté.
    const old = await login(DEFAULT_ADMIN_PASSWORD, after.body.csrfToken as string);
    expect(old.status).toBe(401);
    const again = await sessionState();
    const fresh = await login("nouveau-secret", again.csrfToken);
    expect(fresh.status).toBe(200);
    expect(fresh.body.passwordIsDefault).toBe(false);

    // Une action sensible passe désormais (mot de passe changé).
    const res = await agent
      .post("/api/settings")
      .set("X-CSRF-Token", fresh.body.csrfToken as string)
      .send({ settings: { SWITCHY_CONCURRENCY: "6" } });
    expect(res.status).toBe(200);
    expect(res.body.updated).toContain("SWITCHY_CONCURRENCY");
  });

  it("mauvais mot de passe courant → 401", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const res = await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", lg.body.csrfToken as string)
      .send({ current: "faux", next: "nouveau-secret" });
    expect(res.status).toBe(401);
  });
});

describe("CSRF double-submit", () => {
  it("mutation avec session sans jeton CSRF → 403 CSRF_FAILED", async () => {
    const { csrfToken } = await sessionState();
    await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const res = await agent.post("/api/settings").send({ settings: { SWITCHY_CONCURRENCY: "4" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });

  it("mutation avec un jeton CSRF qui ne correspond pas au cookie → 403", async () => {
    const { csrfToken } = await sessionState();
    await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const res = await agent
      .post("/api/settings")
      .set("X-CSRF-Token", "jeton-bidon")
      .send({ settings: { SWITCHY_CONCURRENCY: "4" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_FAILED");
  });
});

describe("POST /api/session/logout", () => {
  it("vide la session → retour à l'état anonyme et 401 sur les routes protégées", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const csrf = lg.body.csrfToken as string;

    const out = await agent.post("/api/session/logout").set("X-CSRF-Token", csrf);
    expect(out.status).toBe(200);

    const state = await sessionState();
    expect(state.authenticated).toBe(false);

    const protectedRes = await agent.get("/api/keys");
    expect(protectedRes.status).toBe(401);
  });
});

describe("clés d'API des outils — contrat inchangé", () => {
  it("une clé d'API valide authentifie SANS cookie ni CSRF", async () => {
    const key = await createApiKey(env.app, "yuki");
    const res = await request(env.app).get("/api/services").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(200);

    const csrfCookieMissing = await request(env.app).post("/api/settings").set("X-API-Key", key).send({
      settings: { SWITCHY_CONCURRENCY: "5" },
    });
    expect(csrfCookieMissing.status).toBe(200);
  });
});
