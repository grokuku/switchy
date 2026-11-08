/**
 * Coût CPU de l'authentification — [1] cache négatif + [3] identité depuis le
 * cache.
 *
 * ⚠️ Chaque vérification de clé paie un `scryptSync` (~100 ms, SYNCHRONE) PAR
 * CLÉ STOCKÉE. Ces tests comptent les appels à `verifySecretHash` (seul point
 * d'entrée du scrypt) :
 *   - un candidat INVALIDE répété ne doit en relancer qu'UN SEUL (cache négatif);
 *   - une requête relayée authentifiée ne doit en payer qu'un, puis ZÉRO
 *     (l'identité vient du cache au lieu d'un second `resolveIdentity`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/utils/secret-hash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/secret-hash.js")>();
  return { ...actual, verifySecretHash: vi.fn(actual.verifySecretHash) };
});

import request from "supertest";
import { makeTestEnv, createApiKey, type TestEnv } from "./helpers.js";
import {
  validateKey,
  resetAuthCaches,
  setValidationCacheMaxForTests,
  positiveCacheKeysForTests,
} from "../src/switchy-auth.js";
import { verifySecretHash } from "../src/utils/secret-hash.js";

const verify = verifySecretHash as unknown as ReturnType<typeof vi.fn>;

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => {
  env.cleanup();
  vi.clearAllMocks();
});

describe("[1] cache négatif borné", () => {
  it("un candidat invalide répété ne relance PAS de scrypt", () => {
    // Deux clés stockées ⇒ 2 scrypt pour un premier essai infructueux.
    createApiKey(env.app, "pi-web");
    createApiKey(env.app, "yuki");
    resetAuthCaches();
    verify.mockClear();

    const bogus = "switchy_" + "0".repeat(32);
    for (let i = 0; i < 5; i++) expect(validateKey(bogus)).toBe(false);

    // Sans cache négatif : 5 essais × 2 clés = 10 scrypt (~1 s de gel).
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("le cache négatif ne mémorise pas le candidat en clair (hash non réversible)", async () => {
    const { readFileSync } = await import("fs");
    // Le cache est en mémoire vive : on vérifie simplement qu'aucune écriture
    // disque ne contient le candidat refusé.
    const bogus = "switchy_" + "f".repeat(32);
    expect(validateKey(bogus)).toBe(false);
    const keysFile = `${env.dir}/switchy-keys.json`;
    let content = "";
    try {
      content = readFileSync(keysFile, "utf-8");
    } catch {
      content = "";
    }
    expect(content).not.toContain(bogus);
  });
});

describe("[3] identité depuis le cache (aucun second scrypt)", () => {
  it("deux requêtes authentifiées ne paient qu'un scrypt au total", async () => {
    const key = await createApiKey(env.app, "pi-web");
    resetAuthCaches();
    verify.mockClear();

    const first = await request(env.app).get("/api/services").set("X-API-Key", key);
    expect(first.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);

    const second = await request(env.app).get("/api/services").set("X-API-Key", key);
    expect(second.status).toBe(200);
    // Sans correctif : `resolveIdentity` était rappelé hors cache à chaque
    // requête ⇒ 2 scrypt (~200 ms de gel) pour deux requêtes.
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Constat [17] — le cache POSITIF est indexé par un identifiant NON SECRET
// (empreinte SHA-256) et évincé en LRU, jamais vidé d'un coup au plafond.
// ────────────────────────────────────────────────────────────────────────────
describe("[17] cache positif : index non secret + éviction LRU", () => {
  it("l'index du cache positif est l'empreinte SHA-256, jamais le secret", async () => {
    const { createHash } = await import("crypto");
    const secret = await createApiKey(env.app, "pi-web");
    resetAuthCaches();
    expect(validateKey(secret)).toBe(true);

    const keys = positiveCacheKeysForTests();
    expect(keys).toHaveLength(1);
    // Ni le secret, ni un préfixe du secret : uniquement son empreinte.
    expect(keys[0]).not.toBe(secret);
    expect(keys[0]).not.toContain(secret);
    expect(keys[0]).toBe(createHash("sha256").update(secret, "utf-8").digest("hex"));
  });

  it("au plafond, seule l'entrée la moins récemment utilisée est évincée (pas de clear global)", async () => {
    const a = await createApiKey(env.app, "a");
    const b = await createApiKey(env.app, "b");
    const c = await createApiKey(env.app, "c");
    resetAuthCaches();
    setValidationCacheMaxForTests(2);
    verify.mockClear();

    expect(validateKey(a)).toBe(true);
    expect(validateKey(b)).toBe(true);
    // A redevient la plus récemment utilisée.
    expect(validateKey(a)).toBe(true);

    verify.mockClear();
    expect(validateKey(c)).toBe(true); // remplit → évince B (LRU)
    verify.mockClear();

    // A survit : avec l'ancien `clear()` global, il repaierait un scrypt.
    expect(validateKey(a)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(0);

    // B a bien été évincé (il repaie ses scrypt).
    verify.mockClear();
    expect(validateKey(b)).toBe(true);
    expect(verify.mock.calls.length).toBeGreaterThan(0);
  });
});
