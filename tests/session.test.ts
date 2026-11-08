/**
 * Connexion / session / CSRF / garde-fou mot de passe par défaut (Lot 4).
 *
 * L'humain s'authentifie par MOT DE PASSE (défaut `admin`) ; la session est un
 * cookie signé HMAC. Les clés d'API des outils restent un contrat distinct
 * (voir `auth.test.ts`). Aucun accès réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  DEFAULT_ADMIN_PASSWORD,
  getStoredPasswordHash,
  getSessionSecret,
  getSessionEpoch,
} from "../src/session-store.js";
import { signSession } from "../src/utils/session-crypto.js";
import { verifySecretHash } from "../src/utils/secret-hash.js";
import { resetSettingsCache } from "../src/settings-store.js";

const RESET_SCRIPT = fileURLToPath(new URL("../scripts/reset-admin-password.mjs", import.meta.url));

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


// ────────────────────────────────────────────────────────────────────────────
// Constat [11] — `/api/session/password` : SESSION obligatoire (une clé d'API
// est refusée) et limiteur de login appliqué (anti-force brute sur `current`).
// ────────────────────────────────────────────────────────────────────────────
describe("[11] changement de mot de passe réservé à une session", () => {
  it("une clé d'API ne peut PAS changer le mot de passe admin → 401 SESSION_REQUIRED", async () => {
    const key = await createApiKey(env.app, "outil-malin");
    const res = await request(env.app)
      .post("/api/session/password")
      .set("X-API-Key", key)
      .send({ current: DEFAULT_ADMIN_PASSWORD, next: "pris-par-loutil" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REQUIRED");

    // Le mot de passe est INCHANGÉ : `admin` fonctionne encore.
    const state = await sessionState();
    expect((await login(DEFAULT_ADMIN_PASSWORD, state.csrfToken)).status).toBe(200);
  });

  it("le limiteur de login s'applique : 5 `current` faux → 429 sur la route", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const csrf = lg.body.csrfToken as string;
    for (let i = 0; i < 5; i += 1) {
      const res = await agent
        .post("/api/session/password")
        .set("X-CSRF-Token", csrf)
        .send({ current: "faux", next: "autre-secret" });
      expect(res.status).toBe(401);
    }
    const blocked = await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", csrf)
      .send({ current: "faux", next: "autre-secret" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("LOGIN_RATE_LIMITED");
  });

  it("PARCOURS COMPLET d'amorçage : login `admin` → changement → login avec le nouveau", async () => {
    // Dossier de données NEUF, aucun hash stocké : l'utilisateur doit pouvoir
    // définir son mot de passe sans jamais être enfermé dehors.
    expect(getStoredPasswordHash()).toBeNull();
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    expect(lg.status).toBe(200);

    const changed = await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", lg.body.csrfToken as string)
      .send({ current: DEFAULT_ADMIN_PASSWORD, next: "mon-vrai-secret" });
    expect(changed.status).toBe(200);

    // Session invalidée par le changement d'époque, puis reconnexion réussie.
    expect((await agent.get("/api/session")).body.authenticated).toBe(false);
    const fresh = await sessionState();
    expect((await login("mon-vrai-secret", fresh.csrfToken)).status).toBe(200);
    // L'ancien défaut n'est plus accepté (attendu, non ambigu).
    const again = await sessionState();
    expect((await login(DEFAULT_ADMIN_PASSWORD, again.csrfToken)).status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Constat [10] — révocation globale des sessions (époque de session distincte).
// ────────────────────────────────────────────────────────────────────────────
describe("[10] révocation de toutes les sessions", () => {
  it("un jeton émis AVANT la révocation est refusé APRÈS (logout ne suffisait pas)", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const csrf = lg.body.csrfToken as string;
    // Jeton « intercepté » : une copie indépendante du cookie de session.
    const stolen = (lg.headers["set-cookie"] as unknown as string[])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`)) as string;
    const withStolen = () => request(env.app).get("/api/keys").set("Cookie", stolen);
    expect((await withStolen()).status).toBe(200);

    const revoked = await agent.post("/api/session/revoke").set("X-CSRF-Token", csrf);
    expect(revoked.status).toBe(200);

    // Avant le correctif : le jeton restait valide jusqu'à `exp` (12 h).
    expect((await withStolen()).status).toBe(401);
    expect((await agent.get("/api/session")).body.authenticated).toBe(false);

    // On n'est PAS enfermé dehors : reconnexion avec le même mot de passe.
    const state = await sessionState();
    expect((await login(DEFAULT_ADMIN_PASSWORD, state.csrfToken)).status).toBe(200);
    expect((await agent.get("/api/keys")).status).toBe(200);
  });

  it("une clé d'API ne peut pas révoquer la session d'un humain", async () => {
    const key = await createApiKey(env.app, "outil");
    const res = await request(env.app)
      .post("/api/session/revoke")
      .set("X-API-Key", key)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REQUIRED");
  });

  it("compatibilité : un jeton ANTÉRIEUR (sans champ `sep`) reste valide", async () => {
    const legacy = signSession(
      { sid: "0123456789abcdef", exp: Math.floor(Date.now() / 1000) + 3600, ep: getSessionEpoch() },
      getSessionSecret(),
    );
    const res = await request(env.app)
      .get("/api/keys")
      .set("Cookie", `${SESSION_COOKIE}=${legacy}`);
    expect(res.status).toBe(200);
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

// ────────────────────────────────────────────────────────────────────────────
// LE cas qui manquait : « première utilisation » = dossier de données neuf,
// aucun hash stocké → le mot de passe par défaut `admin` DOIT être accepté.
// ────────────────────────────────────────────────────────────────────────────
describe("première utilisation (dossier de données neuf)", () => {
  it("aucun hash stocké → `admin` accepté (le défaut s'applique)", async () => {
    expect(getStoredPasswordHash()).toBeNull();
    const { csrfToken } = await sessionState();
    const res = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.passwordIsDefault).toBe(true);
  });

  it("dès qu'un mot de passe a été changé, `admin` n'est plus accepté (le dossier persiste)", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    const changed = await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", lg.body.csrfToken as string)
      .send({ current: DEFAULT_ADMIN_PASSWORD, next: "change-une-fois" });
    expect(changed.status).toBe(200);

    const after = await sessionState();
    const ko = await login(DEFAULT_ADMIN_PASSWORD, after.csrfToken);
    expect(ko.status).toBe(401);
    expect(ko.body.code).toBe("INVALID_PASSWORD");
    // Message NON trompeur : on explique POURQUOI le défaut ne s'applique plus.
    expect(typeof ko.body.hint).toBe("string");
  });
});

describe("rate-limit du login — message distinct du 401", () => {
  it("5 échecs → 6e tentative en 429 LOGIN_RATE_LIMITED (jamais 401 trompeur)", async () => {
    const { csrfToken } = await sessionState();
    for (let i = 0; i < 5; i += 1) {
      const res = await login("faux", csrfToken);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_PASSWORD");
    }
    const blocked = await login("faux", csrfToken);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("LOGIN_RATE_LIMITED");
    // Même le BON mot de passe est refusé tant que la fenêtre court : le code
    // 429 + son message disent clairement que ce n'est PAS un mot de passe faux.
    const correctButLimited = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    expect(correctButLimited.status).toBe(429);
    expect(correctButLimited.body.code).toBe("LOGIN_RATE_LIMITED");
  });

  it("une connexion RÉUSSIE ne consomme pas le quota (5 succès d'affilée → toujours 200)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const state = await sessionState();
      const res = await login(DEFAULT_ADMIN_PASSWORD, state.csrfToken);
      expect(res.status).toBe(200);
    }
    const state = await sessionState();
    const sixth = await login(DEFAULT_ADMIN_PASSWORD, state.csrfToken);
    expect(sixth.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Régression : dossier de données NON inscriptible (volume recréé par Docker en
// root alors que le service tourne en uid 10001). L'ancien comportement était un
// 500 HTML opaque, affiché par l'interface comme « Mot de passe incorrect. » —
// c'est exactement ce qui faisait croire que le mot de passe par défaut ne
// marchait pas. Désormais : 503 JSON STORAGE_NOT_WRITABLE, cause explicite.
// ────────────────────────────────────────────────────────────────────────────
describe("dossier de données non inscriptible", () => {
  it("login → 503 STORAGE_NOT_WRITABLE en JSON (jamais un 500 HTML opaque)", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchy-bad-dir-"));
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const bad = makeTestEnv({ SWITCHY_DATA_DIR: join(blocker, "data") });
    try {
      const ag = request.agent(bad.app);
      const state = await ag.get("/api/session");
      expect(state.status).toBe(200);
      const res = await ag
        .post("/api/session/login")
        .set("X-CSRF-Token", state.body.csrfToken as string)
        .send({ password: DEFAULT_ADMIN_PASSWORD });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("STORAGE_NOT_WRITABLE");
      expect(String(res.headers["content-type"])).toContain("json");
    } finally {
      bad.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Procédure de secours documentée (accès machine requis, aucune route HTTP).
// ────────────────────────────────────────────────────────────────────────────
describe("scripts/reset-admin-password.mjs", () => {
  it("restaure le défaut `admin` sur un dossier où le mot de passe a été changé", async () => {
    const { csrfToken } = await sessionState();
    const lg = await login(DEFAULT_ADMIN_PASSWORD, csrfToken);
    await agent
      .post("/api/session/password")
      .set("X-CSRF-Token", lg.body.csrfToken as string)
      .send({ current: DEFAULT_ADMIN_PASSWORD, next: "mot-de-passe-perdu" });

    const afterChange = await sessionState();
    expect((await login(DEFAULT_ADMIN_PASSWORD, afterChange.csrfToken)).status).toBe(401);

    execFileSync(process.execPath, [RESET_SCRIPT], { env: { ...process.env }, stdio: "pipe" });
    resetSettingsCache();
    expect(getStoredPasswordHash()).toBeNull();

    const restored = await sessionState();
    const ok = await login(DEFAULT_ADMIN_PASSWORD, restored.csrfToken);
    expect(ok.status).toBe(200);
    expect(ok.body.passwordIsDefault).toBe(true);
  });

  it("`--password` écrit un hash reconnu par verifySecretHash de l'application", async () => {
    execFileSync(process.execPath, [RESET_SCRIPT, "--password", "Repare-2026"], {
      env: { ...process.env },
      stdio: "pipe",
    });
    resetSettingsCache();
    const stored = getStoredPasswordHash();
    expect(stored).not.toBeNull();
    expect(verifySecretHash("Repare-2026", stored as string)).toBe(true);
    expect(verifySecretHash(DEFAULT_ADMIN_PASSWORD, stored as string)).toBe(false);

    const state = await sessionState();
    expect((await login("Repare-2026", state.csrfToken)).status).toBe(200);
    // Le hash n'est JAMAIS stocké en clair ni réaffiché.
    expect(readFileSync(join(env.dir, "config.json"), "utf-8")).not.toContain("Repare-2026");
  });
});
