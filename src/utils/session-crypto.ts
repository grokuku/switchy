/**
 * Cryptographie PURE des sessions d'administration de Switchy — aucune I/O,
 * aucun accès Express. Tout ce qui touche au stockage (config.json) vit dans
 * `src/session-store.ts`. Reprend la brique de Libry (`src/utils/session-crypto.ts`).
 *
 * Modèle de jeton : `<payload base64url>.<signature base64url>`, où la signature
 * est un HMAC-SHA256 du payload encodé, calculé avec le secret de session. Le
 * payload est `{sid, exp, ep}` :
 *   - `sid` : identifiant aléatoire de la session (permet de dériver un jeton
 *     CSRF propre à la session) ;
 *   - `exp` : expiration, en SECONDES Unix ;
 *   - `ep`   : époque de mot de passe ; change à chaque changement de mot de
 *     passe → invalide d'un coup TOUTES les sessions émises avant.
 *
 * La vérification est à temps constant et rejette tout jeton malformé ou expiré.
 */
import crypto from "crypto";

export interface SessionPayload {
  sid: string;
  exp: number;
  ep: number;
}

/** Encodage base64url (RFC 4648 §5) sans remplissage, sûr en cookie. */
function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Décodage base64url tolérant (réintroduit le remplissage manquant). */
function base64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

/** HMAC-SHA256 de `data` avec `secret` (clé : secret de session). */
function hmac(data: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/**
 * Signe un payload de session. Le jeton retourné ne contient PAS le secret ;
 * il est vérifiable uniquement par qui possède le secret.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = base64urlEncode(hmac(body, secret));
  return `${body}.${signature}`;
}

/**
 * Vérifie un jeton de session : signature (temps constant), structure et
 * expiration. Retourne le payload si valide, `null` sinon.
 */
export function verifySessionToken(token: string, secret: string, nowMs: number = Date.now()): SessionPayload | null {
  if (typeof token !== "string" || token === "") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = base64urlEncode(hmac(body, secret));
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlDecode(body).toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const p = parsed as Record<string, unknown>;
  if (typeof p.sid !== "string" || p.sid === "") return null;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null;
  if (typeof p.ep !== "number" || !Number.isFinite(p.ep)) return null;
  if (p.exp <= Math.floor(nowMs / 1000)) return null; // expiré (comparaison en secondes)

  return { sid: p.sid, exp: p.exp, ep: p.ep };
}

/**
 * Jeton CSRF DÉTERMINISTE d'une session : HMAC(secret, "csrf:<sid>"). Lié au
 * `sid`, donc tourne à chaque reconnexion ; côté client il est renvoyé en
 * double-submit (cookie `switchy_csrf` + en-tête `X-CSRF-Token`).
 */
export function deriveCsrfToken(secret: string, sid: string): string {
  return hmac(`csrf:${sid}`, secret).toString("hex");
}

/** Analyse l'en-tête `Cookie` d'une requête en objet `{nom: valeur}`. */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export interface CookieOptions {
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  secure?: boolean;
}

/** Sérialise un cookie en en-tête `Set-Cookie` (sans dépendance). */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
