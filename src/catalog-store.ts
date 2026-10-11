/**
 * Magasin de la collection « fournisseurs + services » de Switchy —
 * fichier `$SWITCHY_DATA_DIR/catalog.json`.
 *
 * ┌─ Pourquoi un fichier à part de `settings-store.ts` ? ────────────────────┐
 * │ Fournisseurs et services sont des COLLECTIONS à taille variable : les     │
 * │ décrire dans le catalogue rigide des réglages scalaires (nom → valeur)    │
 * │ serait un contresens. Le fichier est la SOURCE DE VÉRITÉ (versionnable,   │
 * │ diffable) ; l'interface n'en est qu'une façade.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Écriture ATOMIQUE (tmp + rename), permissions 0600, répertoire 0700.
 *
 * ⚠️ SÉCURITÉ : la clé d'API d'un fournisseur est stockée en clair dans ce
 * fichier (elle doit être présentée telle quelle au fournisseur) mais n'est
 * JAMAIS renvoyée par l'API : la vue publique la remplace par
 * `{ configured, preview: "••••" }` (motif Libry). Champ vide = inchangé,
 * `null` = effacement (sentinelle explicite).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";
import { getCatalogFile } from "./config.js";
import { ApiError } from "./utils/api-error.js";

// ── Vocabulaires fermés ──

/** Types de fournisseurs admis. */
export const PROVIDER_TYPES = ["openai-compatible", "ollama-native", "anthropic", "google"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Niveaux de réflexion admis pour un modèle. */
export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Bornes numériques. */
export const LIMITS = {
  contextWindow: { min: 1, max: 100_000_000 },
  maxOutputTokens: { min: 1, max: 10_000_000 },
  /**
   * Plafond de simultanéité du COMPTE d'un fournisseur. La borne est au moins
   * 1 : `0` bloquerait toute la capacité (ancien piège des réservations).
   */
  maxConcurrency: { min: 1, max: 1000 },
  maxFallbacks: 16,
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;

// ── Types persistés ──

/** Étape d'appel : un fournisseur + un modèle + un niveau de réflexion. */
export interface ServiceStep {
  providerId: string;
  model: string;
  reasoning: ReasoningLevel;
}

export interface ProviderRecord {
  id: string;
  label: string;
  type: ProviderType;
  /** URL « OpenAI-compatible » (ex. `https://ollama.com/v1`). */
  baseUrl: string;
  /** URL de l'API NATIVE du fournisseur (ex. Ollama `/api/tags`) — optionnelle. */
  nativeUrl?: string;
  /**
   * Nombre d'appels SIMULTANÉS autorisés pour le COMPTE de ce fournisseur
   * (ex. 3 pour Ollama Cloud Pro, 500 pour un OpenRouter payant…). Absent =
   * valeur par défaut globale `SWITCHY_CONCURRENCY`. C'est LE bon endroit : la
   * limite appartient au fournisseur, pas au service. Chaque fournisseur a son
   * propre « seau » de places : deux fournisseurs ne se limitent JAMAIS
   * mutuellement.
   */
  maxConcurrency?: number;
  /** SECRET : clé du fournisseur. Jamais renvoyée par l'API. */
  apiKey?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRecord {
  name: string;
  description: string;
  principal: ServiceStep;
  fallbacks: ServiceStep[];
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  /**
   * Priorité de file INTRINSÈQUE au service : quand une place se libère chez un
   * fournisseur, les appels des services prioritaires passent avant les autres
   * (le « léger » n'attend pas derrière le « lourd »). Comme le service est
   * défini une fois dans le catalogue, le client n'a AUCUN en-tête à envoyer.
   */
  prioritaire: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Catalog {
  version: number;
  providers: ProviderRecord[];
  services: ServiceRecord[];
}

const CATALOG_VERSION = 1;
const EMPTY: Catalog = { version: CATALOG_VERSION, providers: [], services: [] };

// ── Lecture (cache par mtime) / écriture atomique ──

let cache: { mtimeMs: number; data: Catalog } | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Migration DOUCE à la lecture : un `catalog.json` d'une version antérieure
 * reste TOUJOURS lisible. Les champs disparus (ex. `reservations` d'un service)
 * sont simplement IGNORÉS ; les nouveaux champs prennent leur valeur par défaut
 * (`prioritaire: false`, `maxConcurrency` absent = défaut global). Aucun crash,
 * aucune réécriture forcée.
 */
function normalizeProvider(value: Record<string, unknown>): ProviderRecord {
  const provider = { ...value } as unknown as ProviderRecord;
  const mc = provider.maxConcurrency;
  if (mc !== undefined && (!Number.isInteger(mc) || mc < LIMITS.maxConcurrency.min)) {
    delete provider.maxConcurrency; // valeur illégale (ex. 0) → retombe sur le défaut global
  }
  return provider;
}

function normalizeService(value: Record<string, unknown>): ServiceRecord {
  // `reservations` (ancien champ de service) est explicitement écarté : sa
  // sémantique a migré vers `ProviderRecord.maxConcurrency`.
  const { reservations: _legacyReservations, ...rest } = value;
  const service = { ...rest } as unknown as ServiceRecord;
  service.prioritaire = service.prioritaire === true; // défaut `false` si absent
  return service;
}

/** Sanitise ce qui vient du disque : on ne fait jamais confiance au fichier. */
function sanitizeCatalog(raw: unknown): Catalog {
  const root = asRecord(raw);
  if (!root) return { ...EMPTY, providers: [], services: [] };
  const providers = Array.isArray(root.providers)
    ? root.providers
        .filter((p) => asRecord(p))
        .map((p) => normalizeProvider(asRecord(p) as Record<string, unknown>))
    : [];
  const services = Array.isArray(root.services)
    ? root.services
        .filter((s) => asRecord(s))
        .map((s) => normalizeService(asRecord(s) as Record<string, unknown>))
    : [];
  return { version: CATALOG_VERSION, providers, services };
}

/** Contenu du catalogue (jamais `null`). Cache invalidé au mtime du fichier. */
export function loadCatalog(): Catalog {
  const file = getCatalogFile();
  try {
    if (!existsSync(file)) {
      cache = null;
      return { ...EMPTY, providers: [], services: [] };
    }
    const stat = statSync(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const data = sanitizeCatalog(JSON.parse(readFileSync(file, "utf-8")));
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (e) {
    console.error("[catalog] Failed to load catalog.json:", e);
    return { ...EMPTY, providers: [], services: [] };
  }
}

/** Répertoire du catalogue (créé si absent, permissions 0700). */
function ensureCatalogDir(): string {
  const dir = path.dirname(getCatalogFile());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/** Écrit le catalogue en ATOMIQUE (tmp + rename), permissions 0600. */
export function saveCatalog(catalog: Catalog): void {
  ensureCatalogDir();
  const file = getCatalogFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(catalog, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
}

/** Réinitialise le cache (outil de test). */
export function resetCatalogCache(): void {
  cache = null;
}

/** Compteurs exposés par `GET /health` (nombre de fournisseurs et de services). */
export function catalogCounts(): { providers: number; services: number } {
  const catalog = loadCatalog();
  return { providers: catalog.providers.length, services: catalog.services.length };
}

// ── Validation (messages clairs, collecte exhaustive) ──

function requireString(value: unknown, field: string, errors: string[], max = 200): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field}: required, must be a non-empty string`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    errors.push(`${field}: must be at most ${max} characters`);
    return null;
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, errors: string[], max = 2000): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    errors.push(`${field}: must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    errors.push(`${field}: must be at most ${max} characters`);
    return undefined;
  }
  return trimmed;
}

function requireBoolean(value: unknown, field: string, errors: string[]): boolean | null {
  if (typeof value === "boolean") return value;
  errors.push(`${field}: required, must be a boolean`);
  return null;
}

function requireInteger(
  value: unknown,
  field: string,
  errors: string[],
  bounds: { min: number; max: number },
): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${field}: required, must be an integer`);
    return null;
  }
  if (value < bounds.min || value > bounds.max) {
    errors.push(`${field}: must be between ${bounds.min} and ${bounds.max}`);
    return null;
  }
  return value;
}

/**
 * Valide `maxConcurrency` (plafond de simultanéité du compte fournisseur).
 * `undefined`/`null`/chaîne vide = NON fourni (défaut global) ; sinon entier
 * ≥ 1. Le `0` est REFUSÉ avec un message explicite : il bloquerait toute la
 * capacité du fournisseur (ancien piège des réservations).
 */
function requireMaxConcurrency(value: unknown, field: string, errors: string[]): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${field}: must be an integer (simultaneous calls allowed for this provider account)`);
    return null;
  }
  if (value < LIMITS.maxConcurrency.min) {
    errors.push(`${field}: must be at least ${LIMITS.maxConcurrency.min} (0 would disable the provider entirely)`);
    return null;
  }
  if (value > LIMITS.maxConcurrency.max) {
    errors.push(`${field}: must be at most ${LIMITS.maxConcurrency.max}`);
    return null;
  }
  return value;
}

/** Interprète un `maxConcurrency` optionnel : vide → `undefined` (non fourni). */
function optionalMaxConcurrency(value: unknown, field: string, errors: string[]): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireMaxConcurrency(value, field, errors);
}

function requireEnum<T extends string>(
  value: unknown,
  field: string,
  errors: string[],
  allowed: readonly T[],
): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  errors.push(`${field}: must be one of ${allowed.join(", ")}`);
  return null;
}

function requireUrl(value: unknown, field: string, errors: string[]): string | null {
  const str = requireString(value, field, errors, 500);
  if (str === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(str);
  } catch {
    errors.push(`${field}: must be a valid absolute URL (e.g. https://provider.example/v1)`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`${field}: must use http or https`);
    return null;
  }
  return str;
}

/** Valide une étape (principal ou repli) : providerId existant + modèle + réflexion. */
function validateStep(
  value: unknown,
  field: string,
  errors: string[],
  providerIds: Set<string>,
): ServiceStep | null {
  const obj = asRecord(value);
  if (!obj) {
    errors.push(`${field}: required object { providerId, model, reasoning }`);
    return null;
  }
  const providerId = requireString(obj.providerId, `${field}.providerId`, errors, 64);
  if (providerId !== null && !providerIds.has(providerId)) {
    errors.push(`${field}.providerId: unknown provider "${providerId}"`);
  }
  const model = requireString(obj.model, `${field}.model`, errors, 200);
  const reasoning = requireEnum(obj.reasoning ?? "off", `${field}.reasoning`, errors, REASONING_LEVELS);
  if (providerId === null || model === null || reasoning === null) return null;
  return { providerId, model, reasoning };
}

/**
 * Applique la sémantique « keep-if-absent » du champ secret `apiKey` :
 *   - `undefined` ou chaîne vide  → INCHANGÉ ;
 *   - `null`                      → efface la clé (sentinelle explicite) ;
 *   - chaîne non vide             → remplace la clé.
 */
function applyApiKey(target: ProviderRecord, value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (value === null) {
    delete target.apiKey;
    return;
  }
  if (typeof value !== "string") {
    errors.push("apiKey: must be a string, null to clear");
    return;
  }
  const trimmed = value.trim();
  if (trimmed === "") return; // champ vide = inchangé
  if (trimmed.length > 4000) {
    errors.push("apiKey: must be at most 4000 characters");
    return;
  }
  target.apiKey = trimmed;
}

// ── Vue publique (jamais de secret en clair) ──

export type PublicProvider = Omit<ProviderRecord, "apiKey"> & {
  apiKey: { configured: boolean; preview: string };
};

/** Vue d'un fournisseur pour l'API : la clé devient `{ configured, preview }`. */
export function toPublicProvider(provider: ProviderRecord): PublicProvider {
  const { apiKey, ...rest } = provider;
  return { ...rest, apiKey: { configured: Boolean(apiKey), preview: "••••" } };
}

// ── Fournisseurs : CRUD ──

export function listProviders(): ProviderRecord[] {
  return loadCatalog().providers;
}

export function getProvider(id: string): ProviderRecord | null {
  return loadCatalog().providers.find((p) => p.id === id) ?? null;
}

export function createProvider(input: unknown): ProviderRecord {
  const body = asRecord(input);
  if (!body) throw ApiError.validation(["body must be a JSON object"]);

  const errors: string[] = [];
  const id = requireString(body.id, "id", errors, 64);
  if (id !== null && !ID_PATTERN.test(id)) {
    errors.push("id: must start with a letter/digit and contain only letters, digits, dot, underscore or dash");
  }
  const label = requireString(body.label, "label", errors);
  const type = requireEnum(body.type, "type", errors, PROVIDER_TYPES);
  const baseUrl = requireUrl(body.baseUrl, "baseUrl", errors);
  const nativeUrlRaw = optionalString(body.nativeUrl, "nativeUrl", errors, 500);
  let nativeUrl: string | undefined;
  if (nativeUrlRaw) {
    try {
      new URL(nativeUrlRaw);
      nativeUrl = nativeUrlRaw;
    } catch {
      errors.push("nativeUrl: must be a valid absolute URL");
    }
  }
  const enabled = body.enabled === undefined ? true : requireBoolean(body.enabled, "enabled", errors);
  const maxConcurrency = optionalMaxConcurrency(body.maxConcurrency, "maxConcurrency", errors);

  if (errors.length > 0) throw ApiError.validation(errors);

  const catalog = loadCatalog();
  if (catalog.providers.some((p) => p.id === id)) {
    throw ApiError.conflict(`provider "${id}" already exists`);
  }

  const now = new Date().toISOString();
  const record: ProviderRecord = {
    id: id as string,
    label: label as string,
    type: type as ProviderType,
    baseUrl: baseUrl as string,
    ...(nativeUrl ? { nativeUrl } : {}),
    ...(typeof maxConcurrency === "number" ? { maxConcurrency } : {}),
    enabled: enabled as boolean,
    createdAt: now,
    updatedAt: now,
  };
  applyApiKey(record, body.apiKey, errors);
  if (errors.length > 0) throw ApiError.validation(errors);

  catalog.providers.push(record);
  saveCatalog(catalog);
  return record;
}

export function updateProvider(id: string, input: unknown): ProviderRecord {
  const body = asRecord(input);
  if (!body) throw ApiError.validation(["body must be a JSON object"]);

  const catalog = loadCatalog();
  const idx = catalog.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw ApiError.notFound(`provider "${id}" not found`);

  const errors: string[] = [];
  if (body.id !== undefined && body.id !== id) {
    errors.push("id: cannot be changed (delete and recreate the provider instead)");
  }

  const current = catalog.providers[idx];
  const next: ProviderRecord = { ...current };

  if (body.label !== undefined) {
    const label = requireString(body.label, "label", errors);
    if (label !== null) next.label = label;
  }
  if (body.type !== undefined) {
    const type = requireEnum(body.type, "type", errors, PROVIDER_TYPES);
    if (type !== null) next.type = type;
  }
  if (body.baseUrl !== undefined) {
    const baseUrl = requireUrl(body.baseUrl, "baseUrl", errors);
    if (baseUrl !== null) next.baseUrl = baseUrl;
  }
  if (body.nativeUrl !== undefined) {
    const raw = optionalString(body.nativeUrl, "nativeUrl", errors, 500);
    if (raw === null || raw === "") delete next.nativeUrl;
    else if (raw !== undefined) {
      try {
        new URL(raw);
        next.nativeUrl = raw;
      } catch {
        errors.push("nativeUrl: must be a valid absolute URL");
      }
    }
  }
  if (body.maxConcurrency !== undefined) {
    if (body.maxConcurrency === null || body.maxConcurrency === "") {
      delete next.maxConcurrency; // null/"" = retour au défaut global
    } else {
      const mc = requireMaxConcurrency(body.maxConcurrency, "maxConcurrency", errors);
      if (mc !== null) next.maxConcurrency = mc;
    }
  }
  if (body.enabled !== undefined) {
    const enabled = requireBoolean(body.enabled, "enabled", errors);
    if (enabled !== null) next.enabled = enabled;
  }
  applyApiKey(next, body.apiKey, errors);

  if (errors.length > 0) throw ApiError.validation(errors);

  next.updatedAt = new Date().toISOString();
  catalog.providers[idx] = next;
  saveCatalog(catalog);
  return next;
}

export function deleteProvider(id: string): void {
  const catalog = loadCatalog();
  const idx = catalog.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw ApiError.notFound(`provider "${id}" not found`);

  const using = catalog.services.filter(
    (s) => s.principal.providerId === id || s.fallbacks.some((f) => f.providerId === id),
  );
  if (using.length > 0) {
    throw ApiError.conflict(
      `provider "${id}" is still used by service(s): ${using.map((s) => s.name).join(", ")}`,
    );
  }

  catalog.providers.splice(idx, 1);
  saveCatalog(catalog);
}

// ── Services : CRUD ──

export function listServices(): ServiceRecord[] {
  return loadCatalog().services;
}

export function getService(name: string): ServiceRecord | null {
  return loadCatalog().services.find((s) => s.name === name) ?? null;
}

/** Valide le corps commun d'un service ; `mustExist` = nom déjà pris interdit. */
function validateServiceBody(
  body: Record<string, unknown>,
  errors: string[],
  providerIds: Set<string>,
  mustExist: boolean,
  currentName: string,
): {
  name?: string;
  description?: string;
  principal?: ServiceStep;
  fallbacks?: ServiceStep[];
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  prioritaire?: boolean;
  enabled?: boolean;
} {
  const out: ReturnType<typeof validateServiceBody> = {};

  if (body.name !== undefined || mustExist) {
    const name = requireString(body.name ?? currentName, "name", errors, 63);
    if (name !== null) {
      if (!NAME_PATTERN.test(name)) {
        errors.push(
          "name: must start with a letter/digit and contain only letters, digits, dot, underscore, dash or space",
        );
      } else {
        out.name = name;
      }
    }
  }
  if (body.description !== undefined || mustExist) {
    const description = optionalString(body.description ?? "", "description", errors, 2000);
    if (typeof description === "string") out.description = description;
  }

  const principalRaw = mustExist ? body.principal : body.principal;
  if (principalRaw !== undefined) {
    const principal = validateStep(principalRaw, "principal", errors, providerIds);
    if (principal !== null) out.principal = principal;
  } else if (mustExist) {
    errors.push("principal: required");
  }

  if (body.fallbacks !== undefined) {
    if (!Array.isArray(body.fallbacks)) {
      errors.push("fallbacks: must be an array");
    } else if (body.fallbacks.length > LIMITS.maxFallbacks) {
      errors.push(`fallbacks: at most ${LIMITS.maxFallbacks} entries`);
    } else {
      const fallbacks: ServiceStep[] = [];
      body.fallbacks.forEach((raw, i) => {
        const step = validateStep(raw, `fallbacks[${i}]`, errors, providerIds);
        if (step !== null) fallbacks.push(step);
      });
      out.fallbacks = fallbacks;
    }
  }

  if (body.contextWindow !== undefined || mustExist) {
    const contextWindow = requireInteger(body.contextWindow, "contextWindow", errors, LIMITS.contextWindow);
    if (contextWindow !== null) out.contextWindow = contextWindow;
  }
  if (body.maxOutputTokens !== undefined || mustExist) {
    const maxOutputTokens = requireInteger(body.maxOutputTokens, "maxOutputTokens", errors, LIMITS.maxOutputTokens);
    if (maxOutputTokens !== null) out.maxOutputTokens = maxOutputTokens;
  }
  if (body.vision !== undefined || mustExist) {
    const vision = requireBoolean(body.vision ?? false, "vision", errors);
    if (vision !== null) out.vision = vision;
  }
  if (body.prioritaire !== undefined || mustExist) {
    const prioritaire = requireBoolean(body.prioritaire ?? false, "prioritaire", errors);
    if (prioritaire !== null) out.prioritaire = prioritaire;
  }
  if (body.enabled !== undefined || mustExist) {
    const enabled = requireBoolean(body.enabled ?? true, "enabled", errors);
    if (enabled !== null) out.enabled = enabled;
  }

  return out;
}

export function createService(input: unknown): ServiceRecord {
  const body = asRecord(input);
  if (!body) throw ApiError.validation(["body must be a JSON object"]);

  const catalog = loadCatalog();
  const providerIds = new Set(catalog.providers.map((p) => p.id));
  const errors: string[] = [];
  const parsed = validateServiceBody(body, errors, providerIds, true, "");
  if (errors.length > 0) throw ApiError.validation(errors);

  const name = parsed.name as string;
  if (catalog.services.some((s) => s.name === name)) {
    throw ApiError.conflict(`service "${name}" already exists`);
  }

  const now = new Date().toISOString();
  const record: ServiceRecord = {
    name,
    description: parsed.description ?? "",
    principal: parsed.principal as ServiceStep,
    fallbacks: parsed.fallbacks ?? [],
    contextWindow: parsed.contextWindow as number,
    maxOutputTokens: parsed.maxOutputTokens as number,
    vision: parsed.vision ?? false,
    prioritaire: parsed.prioritaire ?? false,
    enabled: parsed.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  catalog.services.push(record);
  saveCatalog(catalog);
  return record;
}

export function updateService(name: string, input: unknown): ServiceRecord {
  const body = asRecord(input);
  if (!body) throw ApiError.validation(["body must be a JSON object"]);

  const catalog = loadCatalog();
  const idx = catalog.services.findIndex((s) => s.name === name);
  if (idx < 0) throw ApiError.notFound(`service "${name}" not found`);

  const providerIds = new Set(catalog.providers.map((p) => p.id));
  const errors: string[] = [];
  const parsed = validateServiceBody(body, errors, providerIds, false, name);

  const current = catalog.services[idx];
  const next: ServiceRecord = { ...current };
  if (parsed.name !== undefined && parsed.name !== name) {
    if (catalog.services.some((s) => s.name === parsed.name)) {
      errors.push(`name: service "${parsed.name}" already exists`);
    }
  }
  if (errors.length > 0) throw ApiError.validation(errors);

  if (parsed.name !== undefined) next.name = parsed.name;
  if (parsed.description !== undefined) next.description = parsed.description;
  if (parsed.principal !== undefined) next.principal = parsed.principal;
  if (parsed.fallbacks !== undefined) next.fallbacks = parsed.fallbacks;
  if (parsed.contextWindow !== undefined) next.contextWindow = parsed.contextWindow;
  if (parsed.maxOutputTokens !== undefined) next.maxOutputTokens = parsed.maxOutputTokens;
  if (parsed.vision !== undefined) next.vision = parsed.vision;
  if (parsed.prioritaire !== undefined) next.prioritaire = parsed.prioritaire;
  if (parsed.enabled !== undefined) next.enabled = parsed.enabled;

  next.updatedAt = new Date().toISOString();
  catalog.services[idx] = next;
  saveCatalog(catalog);
  return next;
}

export function deleteService(name: string): void {
  const catalog = loadCatalog();
  const idx = catalog.services.findIndex((s) => s.name === name);
  if (idx < 0) throw ApiError.notFound(`service "${name}" not found`);
  catalog.services.splice(idx, 1);
  saveCatalog(catalog);
}
