/**
 * Authentification de Switchy — clés d'API nommées, hachées (scrypt), révocables.
 *
 * Reprend le patron de Libry (`src/libry-auth.ts`) et de Pi-Web. Différences :
 *   - secrets préfixés « switchy_ » + 32 hex ; identifiant NON secret
 *     préfixé « switchyk_ » ;
 *   - ces CLÉS D'API servent aux OUTILS (Pi-Web, Yuki, Kinoscribe…) : elles
 *     s'ajoutent à la SESSION d'administration du navigateur (voir
 *     `session-store.ts`), elles ne la remplacent pas.
 *
 * ⚠️ Plus de MODE AMORÇAGE : l'API n'est jamais ouverte. La toute première clé
 * se crée depuis l'interface APRÈS connexion (mot de passe admin), une fois le
 * mot de passe par défaut changé — voir `middleware/api-auth.ts`.
 *
 * Le fichier de clés et son répertoire sont créés avec des permissions
 * restrictives (respectivement 0600 et 0700). Le secret n'existe en clair qu'au
 * moment de la création (affiché une seule fois).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";
import crypto from "crypto";
import { type Request } from "express";
import { hashSecret, verifySecretHash, safeEqualSecret } from "./utils/secret-hash.js";
import { getKeysFile, getApiKey } from "./config.js";

// ── Types ──

export interface ApiKeyRecord {
  /** Identifiant NON secret et stable (exposé par l'API, utilisé pour la révocation). */
  id: string;
  name: string;
  createdAt: string;
  /** Aperçu non secret du secret (préfixe + « … »), figé à la création. */
  keyPreview: string;
  /** Hash scrypt du secret. Le secret en clair n'est JAMAIS persisté. */
  keyHash: string;
  /** Dernière utilisation réussie (horodatage ISO), si connue. */
  lastUsedAt?: string;
}

/** Identité résolue d'un secret présenté (sans exposer le secret lui-même). */
export interface ResolvedIdentity {
  id: string;
  name: string;
}

/** Vue NON secrète d'une clé (jamais de hash ni de secret). */
export interface PublicApiKey {
  id: string;
  name: string;
  createdAt: string;
  keyPreview: string;
  lastUsedAt?: string;
}

// ── Persistence ──

function ensureKeysDir(): string {
  const dir = path.dirname(getKeysFile());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

let keysFileMtimeMs = -1;

export function loadKeys(): ApiKeyRecord[] {
  try {
    ensureKeysDir();
    const keysFile = getKeysFile();
    if (existsSync(keysFile)) {
      const stat = statSync(keysFile);
      if (stat.mtimeMs !== keysFileMtimeMs) {
        validationCache.clear();
        keysFileMtimeMs = stat.mtimeMs;
      }
      const raw = JSON.parse(readFileSync(keysFile, "utf-8")) as unknown;
      return Array.isArray(raw) ? (raw.filter((k) => k && typeof k === "object") as ApiKeyRecord[]) : [];
    }
  } catch (e) {
    console.error("[switchy-auth] Failed to load keys:", e);
  }
  return [];
}

/** Écriture atomique (tmp + rename), permissions 0600. */
export function saveKeys(keys: ApiKeyRecord[]): void {
  ensureKeysDir();
  const keysFile = getKeysFile();
  const tmpFile = `${keysFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmpFile, keysFile);
}

/** Nouvelle clé API : « switchy_ » + 32 caractères hexadécimaux. */
function generateKeyString(): string {
  return "switchy_" + crypto.randomBytes(16).toString("hex");
}

/** Préfixe d'identifiant NON secret des clés Switchy. */
const ID_PREFIX = "switchyk_";

/** Masque un secret pour l'affichage (préserve le préfixe lisible). */
export function maskSecret(secret: string): string {
  return secret.slice(0, 12) + "…";
}

/** Vue NON secrète d'une clé (jamais le hash). */
export function toPublicKey(key: ApiKeyRecord): PublicApiKey {
  return {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    keyPreview: key.keyPreview,
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
  };
}

export function listKeys(): PublicApiKey[] {
  return loadKeys().map(toPublicKey);
}

/** Crée et persiste une nouvelle clé. Retourne le secret complet (affiché une fois). */
export function createKey(name: string): { key: PublicApiKey; secret: string } {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") throw new Error("name is required");
  if (trimmed.length > 200) throw new Error("name must be at most 200 characters");

  const keys = loadKeys();
  const secret = generateKeyString();
  const record: ApiKeyRecord = {
    id: ID_PREFIX + crypto.randomBytes(6).toString("hex"),
    keyHash: hashSecret(secret), // le secret en clair n'est JAMAIS persisté
    keyPreview: maskSecret(secret),
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  keys.push(record);
  saveKeys(keys);
  validationCache.clear();
  return { key: toPublicKey(record), secret };
}

/** Révoque (supprime) une clé par son identifiant NON secret. */
export function revokeKey(id: string): boolean {
  const keys = loadKeys();
  const filtered = keys.filter((k) => k.id !== id);
  if (filtered.length === keys.length) return false;
  saveKeys(filtered);
  validationCache.clear();
  return true;
}

// ── Validation ──

/** Cache mémo (mémoire vive uniquement) : secret présenté → identité validée. */
const validationCache = new Map<string, ResolvedIdentity>();
const VALIDATION_CACHE_MAX = 500;

function matchFileKey(secret: string, keys: ApiKeyRecord[]): ApiKeyRecord | null {
  for (const k of keys) {
    if (typeof k.keyHash === "string" && verifySecretHash(secret, k.keyHash)) return k;
  }
  return null;
}

/**
 * Résout un secret présenté en identité : clé du fichier OU clé fournie par
 * l'environnement/le fichier de réglages (SWITCHY_API_KEY), pour les outils.
 */
export function resolveIdentity(secret: string): ResolvedIdentity | null {
  const found = matchFileKey(secret, loadKeys());
  if (found) return { id: found.id, name: found.name };

  const bootstrap = getApiKey();
  if (bootstrap !== "" && safeEqualSecret(secret, bootstrap)) {
    return { id: "switchyk_env", name: "env-bootstrap" };
  }
  return null;
}

/** Valide une clé API présentée (true si connue et active). */
export function validateKey(key: string): boolean {
  if (validationCache.has(key)) return true;
  const identity = resolveIdentity(key);
  if (!identity) return false;
  if (validationCache.size >= VALIDATION_CACHE_MAX) validationCache.clear();
  validationCache.set(key, identity);
  return true;
}

// ── Horodatage d'usage (lastUsedAt), écrit au plus une fois par minute ──

const lastTouchMs = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;

/** Enregistre la dernière utilisation d'une clé du fichier (throttlé à 1/min). */
export function recordUsage(id: string): void {
  if (id === "switchyk_env") return; // pas de fiche pour la clé d'amorçage
  const now = Date.now();
  const prev = lastTouchMs.get(id) ?? 0;
  if (now - prev < TOUCH_INTERVAL_MS) return;
  lastTouchMs.set(id, now);
  const keys = loadKeys();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx < 0) return;
  keys[idx].lastUsedAt = new Date(now).toISOString();
  saveKeys(keys);
}

// ── Caches ──

/** Réinitialise les caches mémo (outil de test). */
export function resetAuthCaches(): void {
  validationCache.clear();
  lastTouchMs.clear();
  keysFileMtimeMs = -1;
}

// ── Extraction de clé présentée ──

/**
 * Extrait TOUTES les clés candidates présentées par une requête, dans l'ordre :
 * `Authorization: Bearer <clé>` puis `X-API-Key: <clé>`. Un appelant est accepté
 * dès qu'AU MOINS UNE candidate est valide (un Bearer inconnu ne doit pas
 * bloquer une `X-API-Key` valide — convention holaf reprise de Libry).
 */
export function extractApiKeys(req: Request): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const authorization = req.headers["authorization"];
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) push(match[1]);
  }

  push(req.headers["x-api-key"]);
  return candidates;
}
