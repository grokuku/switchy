/**
 * [4] `trust proxy` : les seaux de limitation doivent être PAR IP CLIENT, pas
 * par IP du reverse proxy.
 *
 * Sans `trust proxy`, `req.ip` vaut l'IP du proxy pour tout le monde : le
 * limiteur de login (5 échecs/min) devient GLOBAL — 5 mauvais mots de passe
 * envoyés par n'importe qui bloquent l'administrateur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { setAdminPassword } from "../src/session-store.js";
import { getTrustProxy } from "../src/config.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv({ SWITCHY_TRUST_PROXY: "1" });
  setAdminPassword("mot-de-passe-admin");
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

/** Cookie + jeton CSRF nécessaires au double-submit du login. */
async function csrf() {
  const state = await request(env.app).get("/api/session");
  const cookies = (state.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]);
  return { cookie: cookies.join("; "), token: state.body.csrfToken as string };
}

function login(password: string, ip: string, c: { cookie: string; token: string }) {
  return request(env.app)
    .post("/api/session/login")
    .set("X-Forwarded-For", ip)
    .set("Cookie", c.cookie)
    .set("X-CSRF-Token", c.token)
    .send({ password });
}

describe("[4] trust proxy configurable", () => {
  it("valeur par défaut et analyse de SWITCHY_TRUST_PROXY", () => {
    delete process.env.SWITCHY_TRUST_PROXY;
    expect(getTrustProxy()).toBe(1);
    process.env.SWITCHY_TRUST_PROXY = "false";
    expect(getTrustProxy()).toBe(false);
    process.env.SWITCHY_TRUST_PROXY = "2";
    expect(getTrustProxy()).toBe(2);
    process.env.SWITCHY_TRUST_PROXY = "loopback";
    expect(getTrustProxy()).toBe("loopback");
    process.env.SWITCHY_TRUST_PROXY = "1";
  });

  it("épuiser le quota depuis une IP ne bloque pas l'admin depuis une autre", async () => {
    const c = await csrf();

    // 5 échecs depuis l'IP de l'attaquant.
    for (let i = 0; i < 5; i++) {
      const res = await login("mauvais", "198.51.100.1", c);
      expect(res.status).toBe(401);
    }
    // L'attaquant est bien bloqué…
    expect((await login("mauvais", "198.51.100.1", c)).status).toBe(429);
    // …mais l'ADMIN, depuis sa propre IP, se connecte normalement.
    const ok = await login("mot-de-passe-admin", "203.0.113.9", c);
    expect(ok.status).toBe(200);
    expect(ok.body.authenticated).toBe(true);
  });
});
