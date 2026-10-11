/**
 * Sessions d'administration de Switchy, mot de passe admin et CSRF.
 *
 * Reprend le patron de Libry (`src/session-store.ts`). Toute la persistance
 * passe par `$SWITCHY_DATA_DIR/config.json` (écriture atomique 0600, déjà
 * garantie par `settings-store.ts`). Trois clés RÉSERVÉES y sont stockées,
 * HORS du catalogue `SETTINGS_SPEC` : elles ne sont donc ni listées ni
 * modifiables par `GET/POST /api/settings` :
 *
 *   - `SWITCHY_SESSION_SECRET`      : secret HMAC de signature des sessions,
 *                                     auto-généré au premier lancement ;
 *   - `SWITCHY_ADMIN_PASSWORD_HASH` : hash scrypt du mot de passe admin ;
 *   - `SWITCHY_SESSION_EPOCH`       : époque de mot de passe (incrémentée à
 *                                     chaque changement → invalide les sessions).
 *
 * Modèle de session :
 *   - cookie `switchy_session` HttpOnly / SameSite=Strict / Secure si HTTPS ;
 *   - payload `{sid, exp, ep}` signé HMAC-SHA256 (cf. utils/session-crypto.ts) ;
 *   - durée 12 h par défaut (`SWITCHY_SESSION_TTL_HOURS`) ;
 *   - mot de passe admin par défaut `admin` tant qu'aucun hash n'existe.
 *
 * ⚠️ DISTINCTION : la CONNEXION (mot de passe + session) est pour l'HUMAIN qui
 * configure depuis le navigateur. Les CLÉS D'API de `switchy-auth.ts` restent,
 * elles, destinées aux OUTILS (Pi-Web, Yuki, Kinoscribe…).
 */
import crypto from "crypto";
import { type Request } from "express";
import { readSettingsFile, writeSettings, resolveSetting } from "./settings-store.js";
import { hashSecret, verifySecretHash, safeEqualSecret } from "./utils/secret-hash.js";
import {
  signSession,
  verifySessionToken,
  deriveCsrfToken,
  parseCookies,
  serializeCookie,
  type SessionPayload,
  type CookieOptions,
} from "./utils/session-crypto.js";

// ── Clés internes réservées dans config.json ──

const KEY_SESSION_SECRET = "SWITCHY_SESSION_SECRET";
const KEY_PASSWORD_HASH = "SWITCHY_ADMIN_PASSWORD_HASH";
const KEY_SESSION_EPOCH = "SWITCHY_SESSION_EPOCH";

// ── Noms publics ──

export const SESSION_COOKIE = "switchy_session";
export const CSRF_COOKIE = "switchy_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** Mot de passe admin par défaut, accepté tant qu'aucun hash n'a été écrit. */
export const DEFAULT_ADMIN_PASSWORD = "admin";
/** Durée de session par défaut, en heures. */
export const DEFAULT_SESSION_TTL_HOURS = 12;

// ── Durée de session (réglable ; override de test) ──

let ttlOverrideSeconds: number | null = null;

/** Force la durée de session en secondes (outil de test) ; `null` rétablit le défaut. */
export function setSessionTtlForTests(seconds: number | null): void {
  ttlOverrideSeconds = seconds;
}

/** Durée de session effective en secondes (override de test, sinon env ?? fichier ?? 12 h). */
export function getSessionTtlSeconds(): number {
  if (ttlOverrideSeconds !== null) return Math.max(0, Math.floor(ttlOverrideSeconds));
  const raw = resolveSetting("SWITCHY_SESSION_TTL_HOURS", String(DEFAULT_SESSION_TTL_HOURS));
  const parsed = Number.parseFloat(raw);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_HOURS;
  const seconds = Math.floor(hours * 3600);
  return seconds > 0 ? seconds : DEFAULT_SESSION_TTL_HOURS * 3600;
}

/** Horodatage courant en secondes Unix (aligné sur `exp`). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Lecture des clés internes (fichier SEUL : jamais dérivées de l'environnement) ──

function internalSetting(key: string): string | null {
  const value = readSettingsFile()[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ── Secret de session (auto-généré, persistant, jamais exposé) ──

/** Secret HMAC de session ; généré et persisté à la volée au premier besoin. */
export function getSessionSecret(): string {
  const existing = internalSetting(KEY_SESSION_SECRET);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("hex");
  writeSettings({ [KEY_SESSION_SECRET]: generated });
  return internalSetting(KEY_SESSION_SECRET) ?? generated;
}

// ── Époque de mot de passe ──

/** Époque de mot de passe courante (0 si jamais changé). */
export function getSessionEpoch(): number {
  const raw = internalSetting(KEY_SESSION_EPOCH);
  const parsed = raw !== null ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// ── Mot de passe admin ──

let defaultCache: { hash: string; value: boolean } | null = null;

/** Hash scrypt du mot de passe admin, ou `null` (défaut `admin` en vigueur). */
export function getStoredPasswordHash(): string | null {
  return internalSetting(KEY_PASSWORD_HASH);
}

/** Vrai tant que le mot de passe admin est (encore) le défaut `admin`. */
export function isPasswordDefault(): boolean {
  const hash = getStoredPasswordHash();
  if (!hash) return true;
  if (defaultCache && defaultCache.hash === hash) return defaultCache.value;
  const value = verifySecretHash(DEFAULT_ADMIN_PASSWORD, hash);
  defaultCache = { hash, value };
  return value;
}

/** Vérifie un mot de passe admin candidat (défaut en clair, sinon hash scrypt). */
export function verifyAdminPassword(candidate: string): boolean {
  const hash = getStoredPasswordHash();
  if (!hash) return safeEqualSecret(candidate, DEFAULT_ADMIN_PASSWORD);
  return verifySecretHash(candidate, hash);
}

/**
 * Diagnostic NON secret de l'état du mot de passe (journal de démarrage).
 * Ne révèle jamais le mot de passe ni son hash : sert uniquement à rendre la
 * cause d'un échec de connexion visible dans les logs du conteneur.
 */
export function describeAdminPasswordState(): string {
  const hash = getStoredPasswordHash();
  if (!hash) return "default ('admin' accepted — no hash stored yet)";
  return isPasswordDefault()
    ? "default ('admin' still accepted — a hash of it is stored)"
    : "custom (a CHANGED password is stored in the data dir; 'admin' no longer works)";
}

/**
 * Change le mot de passe admin : écrit le nouveau hash ET incrémente l'époque,
 * ce qui invalide TOUTES les sessions déjà émises.
 */
export function setAdminPassword(next: string): void {
  const hash = hashSecret(next);
  writeSettings({ [KEY_PASSWORD_HASH]: hash, [KEY_SESSION_EPOCH]: String(getSessionEpoch() + 1) });
  defaultCache = null;
}

// ── Émission / vérification de session ──

export interface IssuedSession {
  token: string;
  payload: SessionPayload;
  csrfToken: string;
}

/** Émet une nouvelle session (identifiant aléatoire, expiration, époque courante). */
export function issueSession(): IssuedSession {
  const secret = getSessionSecret();
  const sid = crypto.randomBytes(16).toString("hex");
  const payload: SessionPayload = { sid, exp: nowSeconds() + getSessionTtlSeconds(), ep: getSessionEpoch() };
  return { token: signSession(payload, secret), payload, csrfToken: deriveCsrfToken(secret, sid) };
}

/** Lit un cookie nommé de la requête (null si absent). */
export function readCookie(req: Request, name: string): string | null {
  return parseCookies(req.headers.cookie)[name] ?? null;
}

/** Vrai si la requête porte un cookie de session (même invalide). */
export function hasSessionCookie(req: Request): boolean {
  return readCookie(req, SESSION_COOKIE) !== null;
}

/**
 * Session valide d'une requête : cookie présent, signature correcte ET époque
 * alignée. Un cookie falsifié, expiré, ou émis avant un changement de mot de
 * passe renvoie `null`.
 */
export function getSessionFromRequest(req: Request): SessionPayload | null {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const payload = verifySessionToken(token, getSessionSecret());
  if (!payload) return null;
  if (payload.ep !== getSessionEpoch()) return null;
  return payload;
}

// ── Cookies (attributs) ──

/** `Secure` seulement derrière HTTPS (direct ou via un proxy terminant TLS). */
function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === "string" && value.split(",")[0].trim().toLowerCase() === "https") return true;
  return req.secure === true;
}

function baseCookieOptions(req: Request): CookieOptions {
  return { path: "/", sameSite: "Strict", secure: isSecureRequest(req) };
}

/** En-tête `Set-Cookie` du cookie de session (HttpOnly, SameSite=Strict). */
export function sessionCookieHeader(req: Request, token: string, maxAgeSeconds: number): string {
  return serializeCookie(SESSION_COOKIE, token, { ...baseCookieOptions(req), httpOnly: true, maxAge: maxAgeSeconds });
}

/** En-tête `Set-Cookie` qui VIDE le cookie de session (déconnexion). */
export function clearSessionCookieHeader(req: Request): string {
  return serializeCookie(SESSION_COOKIE, "", { ...baseCookieOptions(req), httpOnly: true, maxAge: 0 });
}

/** En-tête `Set-Cookie` du cookie CSRF (NON HttpOnly : lisible par le JS du site). */
export function csrfCookieHeader(req: Request, token: string, maxAgeSeconds: number): string {
  return serializeCookie(CSRF_COOKIE, token, { ...baseCookieOptions(req), httpOnly: false, maxAge: maxAgeSeconds });
}

// ── CSRF (double-submit) ──

/**
 * Jeton CSRF à présenter au client pour la requête courante : dérivé du `sid`
 * si une session valide existe, sinon jeton aléatoire conservé dans le cookie
 * `switchy_csrf` (sert aussi à protéger `POST /login`).
 */
export function csrfTokenForRequest(req: Request): string {
  const session = getSessionFromRequest(req);
  if (session) return deriveCsrfToken(getSessionSecret(), session.sid);
  const existing = readCookie(req, CSRF_COOKIE);
  if (existing && existing.trim() !== "") return existing;
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Vérifie le double-submit : en-tête `X-CSRF-Token` == cookie `switchy_csrf`, et
 * — si une session valide est présente — égal au jeton dérivé du `sid`.
 */
export function verifyCsrfToken(req: Request): boolean {
  const header = req.headers[CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value === "") return false;
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!cookie || !safeEqualSecret(value, cookie)) return false;
  const session = getSessionFromRequest(req);
  if (session) return safeEqualSecret(value, deriveCsrfToken(getSessionSecret(), session.sid));
  return true;
}
