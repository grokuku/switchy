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
import { AsyncMutex } from "./utils/async-mutex.js";

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
        negativeCache.clear();
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
  // Le mtime que NOUS venons d'écrire est mémorisé : sans cela, la prochaine
  // `loadKeys` croirait à une modification externe et viderait le cache de
  // validation (⇒ un scryptSync par clé au premier appel suivant).
  try {
    keysFileMtimeMs = statSync(keysFile).mtimeMs;
  } catch {}
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
  negativeCache.clear();
  return { key: toPublicKey(record), secret };
}

/**
 * File d'écriture du fichier de clés : création et révocation sont sérialisées
 * (« lire → modifier → écrire »), pour qu'un `recordUsage` (qui réécrit tout le
 * fichier) ne puisse jamais réécrire une version antérieure et perdre une clé
 * fraîchement créée.
 */
const keysMutex = new AsyncMutex();

/** Exécute une mutation du fichier de clés en série (voir `utils/async-mutex.ts`). */
export function runKeysMutation<T>(fn: () => T | Promise<T>): Promise<T> {
  return keysMutex.run(fn);
}

/** Révoque (supprime) une clé par son identifiant NON secret. */
export function revokeKey(id: string): boolean {
  const keys = loadKeys();
  const filtered = keys.filter((k) => k.id !== id);
  if (filtered.length === keys.length) return false;
  saveKeys(filtered);
  validationCache.clear();
  negativeCache.clear();
  return true;
}

// ── Validation ──

/**
 * Cache mémo (mémoire vive uniquement) : identité validée d'un candidat.
 *
 * ⚠️ L'INDEX est l'empreinte SHA-256 du candidat — un identifiant NON SECRET et
 * non réversible — jamais le secret en clair : une carte mémoire (core dump,
 * inspection de tas) ne doit jamais révéler de secret utilisable.
 *
 * ⚠️ Pourquoi pas l'`id` de la clé en index : le but du cache est précisément
 * d'éviter `loadKeys()` + `scryptSync` (~100 ms) ; or l'`id` n'est connu qu'APRÈS
 * cette vérification. L'empreinte est donc le seul identifiant non secret
 * disponible AVANT le lookup. L'identité (id + nom) reste portée par la valeur.
 *
 * Éviction LRU (et non `clear()` global) : au-delà du plafond, seule l'entrée la
 * moins récemment utilisée est jetée. Un `clear()` faisait retomber la prochaine
 * rafale de requêtes sur `#clés × ~100 ms` de `scryptSync` synchrone.
 */
const validationCache = new Map<string, ResolvedIdentity>();
const VALIDATION_CACHE_MAX = 500;

/** Plafond EFFECTIF du cache positif (abaissé par les tests seulement). */
let validationCacheMax = VALIDATION_CACHE_MAX;

/**
 * Cache NÉGATIF borné des candidats REFUSÉS.
 *
 * ⚠️ Sans lui, un candidat invalide repartait dans `matchFileKey` à CHAQUE
 * essai, soit un `scryptSync` (~100 ms, SYNCHRONE, thread principal) par clé
 * stockée : un anonyme envoyant `Bearer x` en boucle gelait toute la passerelle
 * (HTTP comme WebSocket).
 *
 * La clé du cache est, comme pour le cache positif depuis le constat [17],
 * l'empreinte SHA-256 du candidat — un hash NON réversible, jamais le secret.
 * TTL court (10 s) et taille plafonnée : une clé créée entre-temps est vue au
 * plus tard après expiration, et la mémoire reste bornée.
 */
const negativeCache = new Map<string, number>();
const NEGATIVE_CACHE_MAX = 500;
const NEGATIVE_CACHE_TTL_MS = 10_000;

/** Empreinte non réversible d'un candidat présenté. */
function fingerprint(candidate: string): string {
  return crypto.createHash("sha256").update(candidate, "utf-8").digest("hex");
}

function isNegativelyCached(fp: string): boolean {
  const expiresAt = negativeCache.get(fp);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    negativeCache.delete(fp);
    return false;
  }
  return true;
}

function rememberNegative(fp: string): void {
  if (negativeCache.size >= NEGATIVE_CACHE_MAX) {
    const now = Date.now();
    for (const [key, expiresAt] of negativeCache) if (expiresAt <= now) negativeCache.delete(key);
    // Toujours plein : éviction de l'entrée la plus ancienne (Map = ordre d'insertion).
    if (negativeCache.size >= NEGATIVE_CACHE_MAX) {
      const oldest = negativeCache.keys().next();
      if (!oldest.done) negativeCache.delete(oldest.value);
    }
  }
  negativeCache.set(fp, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

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

/**
 * Résout un candidat en identité EN PASSANT PAR LES CACHES (positif puis
 * négatif) : un candidat déjà validé ne repaie JAMAIS les ~100 ms de scrypt,
 * et un candidat déjà refusé non plus (pendant le TTL du cache négatif).
 *
 * C'est cette fonction que doit utiliser tout appelant ayant besoin de
 * l'identité (nom de clé, horodatage d'usage) : appeler `validateKey` PUIS
 * `resolveIdentity` repayait un scrypt complet à chaque requête relayée.
 */
export function resolveKeyIdentity(candidate: string): ResolvedIdentity | null {
  const fp = fingerprint(candidate);
  // 1. cache positif (empreinte non secrète) — LRU : une lecture réinsère l'entrée.
  const cached = validationCache.get(fp);
  if (cached) {
    validationCache.delete(fp);
    validationCache.set(fp, cached);
    return cached;
  }
  // 2. cache négatif (empreinte, TTL court)
  if (isNegativelyCached(fp)) return null;
  // 3. vérification réelle (scrypt)
  const identity = resolveIdentity(candidate);
  if (!identity) {
    rememberNegative(fp);
    return null;
  }
  // 4. mémorisation bornée : éviction de l'entrée la MOINS récemment utilisée
  //    (Map = ordre d'insertion) — jamais un `clear()` global.
  while (validationCache.size >= validationCacheMax) {
    const oldest = validationCache.keys().next();
    if (oldest.done) break;
    validationCache.delete(oldest.value);
  }
  validationCache.set(fp, identity);
  return identity;
}

/** Abaisse le plafond du cache positif (outil de test) ; `null` rétablit le défaut. */
export function setValidationCacheMaxForTests(max: number | null): void {
  validationCacheMax = max === null ? VALIDATION_CACHE_MAX : Math.max(1, Math.floor(max));
}

/** Empreintes actuellement en cache positif (outil de test — jamais des secrets). */
export function positiveCacheKeysForTests(): string[] {
  return [...validationCache.keys()];
}

/** Valide une clé API présentée (true si connue et active). */
export function validateKey(key: string): boolean {
  return resolveKeyIdentity(key) !== null;
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
  validationCacheMax = VALIDATION_CACHE_MAX;
  validationCache.clear();
  negativeCache.clear();
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
