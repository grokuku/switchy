/**
 * Hachage lent des secrets (clés API) — copie de Libry
 * (src/utils/secret-hash.ts, elle-même issue de Pi-Web).
 *
 * Objectif : ne JAMAIS stocker un secret en clair sur disque. On stocke un hash
 * scrypt (Node natif, sans dépendance) salé par clé, vérifié à temps constant.
 * Le secret n'existe en clair qu'au moment de la création (affiché une fois dans
 * l'UI) et pendant la validation en mémoire vive.
 */
import crypto from "crypto";

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/**
 * Hache un secret : "scrypt:<salt hex>:<hash hex>" (sel aléatoire par secret).
 * Coût ~100 ms/scryptSync : à n'utiliser qu'à la création, pas sur chaque requête
 * (cf. cache mémo des modules appelants).
 */
export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Vérifie un secret candidat contre un hash stocké (format hashSecret).
 * Comparaison à temps constant ; retourne false sur tout format invalide.
 */
export function verifySecretHash(candidate: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
  const actual = crypto.scryptSync(candidate, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return crypto.timingSafeEqual(actual, expected);
}

/** Comparaison à temps constant de deux secrets en clair. */
export function safeEqualSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
