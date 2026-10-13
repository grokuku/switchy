/**
 * Découverte des MODÈLES d'un fournisseur — pour la liste déroulante du
 * formulaire de service (et les capacités d'un modèle à la sélection).
 *
 * Deux sources, selon le fournisseur :
 *   - **Ollama natif** (`type: "ollama-native"` OU `nativeUrl` renseigné) :
 *       GET  {nativeUrl}/api/tags  → { models: [{ name, model, size, details }] }
 *       POST {nativeUrl}/api/show  → { capabilities, model_info, … }
 *     C'est la source la PLUS RICHE (capacités + taille de contexte).
 *   - **OpenAI-compatible** (tout le reste) :
 *       GET  {baseUrl}/models      → { data: [{ id, … }] }
 *     L'API `/models` n'expose PAS les capacités : on le dit clairement et
 *     l'utilisateur les saisit à la main.
 *
 * ⚠️ SÉCURITÉ : l'appel transite par le FOURNISSEUR avec SA clé (jamais celle
 * du client, qui ne sort jamais). Aucun secret n'est renvoyé dans la réponse.
 * ⚠️ CACHE COURT (pour ne pas interroger le fournisseur à chaque frappe) ;
 * `refresh: true` le contourne (bouton « rafraîchir » de l'interface).
 */
import { getProvider, type ProviderRecord, type ReasoningLevel } from "../catalog-store.js";
import { ApiError } from "../utils/api-error.js";
import { normalizeReasoningLevel, STANDARD_REASONING_LEVELS } from "./reasoning.js";
import { nativeBaseUrl } from "../routes/native.js";

export type ModelSource = "ollama-native" | "openai-compatible";

/** Source de découverte appropriée au fournisseur. */
export function modelSourceFor(provider: ProviderRecord): ModelSource {
  return provider.type === "ollama-native" || Boolean(provider.nativeUrl) ? "ollama-native" : "openai-compatible";
}

export interface ProviderModel {
  id: string;
  label?: string;
  size?: number;
  modifiedAt?: string;
}

export interface ProviderCapabilities {
  completion: boolean;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
}

export interface ProviderModelDetails {
  model: string;
  providerId: string;
  source: ModelSource;
  /** `true` si le fournisseur a réellement exposé des capacités. */
  detected: boolean;
  capabilities?: ProviderCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Niveaux de réflexion RÉELLEMENT supportés (détectés), sinon standard. */
  reasoningLevels: ReasoningLevel[];
  /** Niveau par défaut du modèle quand le fournisseur le déclare. */
  reasoningDefault?: ReasoningLevel;
  /** Explication affichée dans l'interface quand rien n'a été détecté. */
  note?: string;
}

// ── En-têtes d'authentification du FOURNISSEUR (jamais le client) ──

function authHeaders(provider: ProviderRecord): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (provider.apiKey) {
    if (provider.type === "anthropic") headers["x-api-key"] = provider.apiKey;
    else if (provider.type === "google") headers["x-goog-api-key"] = provider.apiKey;
    else headers["authorization"] = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

/** Message clair pour un échec HTTP amont (401/403 = clé, le reste = erreur). */
function upstreamError(provider: ProviderRecord, action: string, status: number): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      "PROVIDER_AUTH_ERROR",
      `provider "${provider.id}": authentication failed (HTTP ${status}) while ${action}. Check the provider API key.`,
    );
  }
  if (status === 404) {
    return new ApiError(404, "MODEL_NOT_FOUND", `provider "${provider.id}": not found (HTTP 404) while ${action}.`);
  }
  return new ApiError(502, "PROVIDER_ERROR", `provider "${provider.id}": upstream error (HTTP ${status}) while ${action}.`);
}

/** Encapsule un `fetch` réseau : échec = message clair, jamais une exception brute. */
async function safeFetch(provider: ProviderRecord, url: string, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(502, "PROVIDER_UNREACHABLE", `provider "${provider.id}" is unreachable while ${action}: ${reason}`);
  }
}

function joinBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// ── Cache court ──

const CACHE_TTL_MS = 30_000;
interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}
const modelsCache = new Map<string, CacheEntry<ProviderModel[]>>();
const detailsCache = new Map<string, CacheEntry<ProviderModelDetails>>();

function cacheKey(provider: ProviderRecord, extra = ""): string {
  return `${provider.id}|${modelSourceFor(provider)}|${provider.baseUrl}|${provider.nativeUrl ?? ""}|${extra}`;
}

/** Vide le cache (outil de test). */
export function resetModelCatalogCache(): void {
  modelsCache.clear();
  detailsCache.clear();
}

// ── Liste des modèles ──

/**
 * Liste les modèles exposés par le fournisseur (avec sa clé). Lève une
 * `ApiError` claire si le fournisseur est absent, désactivé, injoignable ou
 * refuse l'authentification.
 */
export async function listProviderModels(providerId: string, opts: { refresh?: boolean } = {}): Promise<ProviderModel[]> {
  const provider = getProvider(providerId);
  if (!provider) throw ApiError.notFound(`provider "${providerId}" not found`);
  if (!provider.enabled) throw new ApiError(503, "PROVIDER_DISABLED", `provider "${providerId}" is disabled`);

  const key = cacheKey(provider);
  const cached = modelsCache.get(key);
  if (!opts.refresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const source = modelSourceFor(provider);
  let models: ProviderModel[];
  if (source === "ollama-native") {
    const base = nativeBaseUrl(provider);
    if (!base) throw new ApiError(503, "NO_NATIVE_URL", `provider "${providerId}": no native URL configured`);
    const res = await safeFetch(provider, `${base}/api/tags`, { headers: authHeaders(provider) }, "listing models");
    if (!res.ok) throw upstreamError(provider, "listing models", res.status);
    const data = (await parseJson(res)) as { models?: unknown };
    const raw = Array.isArray(data.models) ? data.models : [];
    models = raw
      .map((m) => {
        const obj = m as Record<string, unknown>;
        const id = typeof obj.name === "string" ? obj.name : typeof obj.model === "string" ? obj.model : "";
        return {
          id,
          label: id,
          ...(typeof obj.size === "number" ? { size: obj.size } : {}),
          ...(typeof obj.modified_at === "string" ? { modifiedAt: obj.modified_at } : {}),
        };
      })
      .filter((m) => m.id !== "");
  } else {
    const res = await safeFetch(
      provider,
      `${joinBase(provider.baseUrl)}/models`,
      { headers: authHeaders(provider) },
      "listing models",
    );
    if (!res.ok) throw upstreamError(provider, "listing models", res.status);
    const data = (await parseJson(res)) as { data?: unknown; models?: unknown };
    const raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    models = raw
      .map((m) => (typeof m === "string" ? m : (m as Record<string, unknown>)?.id))
      .filter((id): id is string => typeof id === "string" && id !== "")
      .map((id) => ({ id, label: id }));
  }

  modelsCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: models });
  return models;
}

// ── Capacités d'un modèle ──

/** Cherche une clé `*.context_length` dans `model_info` et renvoie sa valeur entière. */
export function extractContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== "object" || Array.isArray(modelInfo)) return undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
  }
  return undefined;
}

/** Capacités (liste Ollama) → objet booléen. */
export function capabilitiesFromList(list: unknown): ProviderCapabilities | undefined {
  if (!Array.isArray(list)) return undefined;
  const has = (name: string) => list.some((c) => typeof c === "string" && c.toLowerCase() === name);
  return { completion: has("completion"), tools: has("tools"), thinking: has("thinking"), vision: has("vision") };
}

/**
 * Niveaux de réflexion déduits des capacités — repli quand le fournisseur ne
 * déclare qu'une capacité « thinking » globale sans la liste exacte des niveaux.
 * `thinking` (bloc Ollama parsé) PRIME : il porte les niveaux réels.
 */
export function reasoningLevelsFor(
  caps: ProviderCapabilities | undefined,
  thinking?: ParsedThinking | null,
): ReasoningLevel[] {
  if (thinking) return thinking.levels;
  return caps && caps.thinking ? [...STANDARD_REASONING_LEVELS] : ["off"];
}

/** Bloc `thinking` d'Ollama (`POST /api/show`) : niveaux réels + défaut. */
export interface ParsedThinking {
  levels: ReasoningLevel[];
  default?: ReasoningLevel;
}

/**
 * Lit le bloc `thinking` d'Ollama (`POST /api/show`) — source AUTORITAIRE des
 * niveaux réellement supportés :
 *   thinking = { values: [false, "low", "high", "max"], default: "high" }
 * Le booléen `false` = extinction supportée → niveau interne `off` ; chaque
 * chaîne est un niveau wire conservé tel quel. Une valeur non reconnue est
 * IGNORÉE (jamais inventée). Renvoie `null` si le bloc est absent/invalide ou
 * sans valeur exploitable.
 */
export function parseOllamaThinking(thinking: unknown): ParsedThinking | null {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return null;
  const values = (thinking as { values?: unknown }).values;
  if (!Array.isArray(values)) return null;
  const levels: ReasoningLevel[] = [];
  let offSupported = false;
  for (const v of values) {
    if (v === false) {
      offSupported = true;
      continue;
    }
    const level = normalizeReasoningLevel(v);
    if (level && level !== "off" && !levels.includes(level)) levels.push(level);
  }
  const exposed: ReasoningLevel[] = offSupported ? ["off", ...levels] : [...levels];
  if (exposed.length === 0) return null;
  const def = normalizeReasoningLevel((thinking as { default?: unknown }).default);
  return { levels: exposed, ...(def && exposed.includes(def) ? { default: def } : {}) };
}

/**
 * Lit `effort.supported_levels` (DeepSeek et autres compatibles OpenAI qui
 * l'exposent, via `GET {baseUrl}/models`). Accepte aussi bien un tableau qu'un
 * objet `{ supported_levels | supportedLevels | levels }`. Renvoie `null` si
 * rien d'exploitable (le fournisseur n'expose pas de niveaux).
 */
export function parseEffortLevels(effort: unknown): ReasoningLevel[] | null {
  let supported: unknown;
  if (Array.isArray(effort)) supported = effort;
  else if (effort && typeof effort === "object") {
    const obj = effort as Record<string, unknown>;
    supported = obj.supported_levels ?? obj.supportedLevels ?? obj.levels;
  }
  if (!Array.isArray(supported)) return null;
  const levels: ReasoningLevel[] = [];
  for (const raw of supported) {
    const level = normalizeReasoningLevel(raw);
    if (level && !levels.includes(level)) levels.push(level);
  }
  return levels.length > 0 ? levels : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function inputModalitiesIncludeImage(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.some((v) => typeof v === "string" && /image|vision/i.test(v));
}

/**
 * Interroge le fournisseur pour les capacités d'un modèle. Ollama natif expose
 * `capabilities` et `model_info` (taille de contexte) ; l'OpenAI-compatible ne
 * les expose pas → `detected: false` + note explicite (saisie manuelle).
 */
export async function describeProviderModel(
  providerId: string,
  model: string,
  opts: { refresh?: boolean } = {},
): Promise<ProviderModelDetails> {
  const provider = getProvider(providerId);
  if (!provider) throw ApiError.notFound(`provider "${providerId}" not found`);
  if (!provider.enabled) throw new ApiError(503, "PROVIDER_DISABLED", `provider "${providerId}" is disabled`);

  const source = modelSourceFor(provider);
  const key = cacheKey(provider, model);
  const cached = detailsCache.get(key);
  if (!opts.refresh && cached && cached.expiresAt > Date.now()) return cached.value;

  let details: ProviderModelDetails;
  if (source === "ollama-native") {
    const base = nativeBaseUrl(provider);
    if (!base) throw new ApiError(503, "NO_NATIVE_URL", `provider "${providerId}": no native URL configured`);
    const res = await safeFetch(
      provider,
      `${base}/api/show`,
      {
        method: "POST",
        headers: { ...authHeaders(provider), "content-type": "application/json" },
        body: JSON.stringify({ model }),
      },
      "reading model capabilities",
    );
    if (!res.ok) throw upstreamError(provider, "reading model capabilities", res.status);
    const data = (await parseJson(res)) as { capabilities?: unknown; model_info?: unknown; thinking?: unknown };
    const capabilities = capabilitiesFromList(data.capabilities);
    const contextWindow = extractContextLength(data.model_info);
    const thinking = parseOllamaThinking(data.thinking);
    details = {
      model,
      providerId,
      source,
      detected: capabilities !== undefined || thinking !== null,
      ...(capabilities ? { capabilities } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      reasoningLevels: reasoningLevelsFor(capabilities, thinking),
      ...(thinking?.default ? { reasoningDefault: thinking.default } : {}),
    };
  } else {
    // Beaucoup de fournisseurs OpenAI-compatible n'exposent RIEN d'utile : on
    // TENTE `GET {baseUrl}/models` (endpoint standard, quasi toujours présent)
    // et on lit, par modèle, `effort.supported_levels` (niveaux de réflexion
    // réels, ex. DeepSeek), `context_window`, `max_output_tokens` et
    // `input_modalities`. Rien trouvé → liste standard + `detected: false` et
    // note honnête : on n'invente JAMAIS de niveau.
    const res = await safeFetch(
      provider,
      `${joinBase(provider.baseUrl)}/models`,
      { headers: authHeaders(provider) },
      "reading model capabilities",
    );
    if (!res.ok) throw upstreamError(provider, "reading model capabilities", res.status);
    const data = (await parseJson(res)) as { data?: unknown; models?: unknown };
    const raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const entry = raw.find(
      (m): m is Record<string, unknown> =>
        Boolean(m) &&
        typeof m === "object" &&
        !Array.isArray(m) &&
        ((m as Record<string, unknown>).id === model || (m as Record<string, unknown>).model === model),
    );
    const effortLevels = entry ? parseEffortLevels(entry.effort) : null;
    const contextWindow = entry ? positiveNumber(entry.context_window ?? entry.context_length) : undefined;
    const maxOutputTokens = entry ? positiveNumber(entry.max_output_tokens) : undefined;
    const vision = entry ? inputModalitiesIncludeImage(entry.input_modalities) : undefined;
    const detected =
      Boolean(entry) &&
      (effortLevels !== null || contextWindow !== undefined || maxOutputTokens !== undefined || vision !== undefined);
    details = {
      model,
      providerId,
      source,
      detected,
      ...(detected && vision !== undefined
        ? { capabilities: { completion: true, tools: true, thinking: effortLevels !== null, vision } }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      reasoningLevels: effortLevels ?? [...STANDARD_REASONING_LEVELS],
      ...(detected
        ? {}
        : {
            note: "Capacités non exposées par ce fournisseur (API OpenAI-compatible) — liste standard proposée, renseignez à la main.",
          }),
    };
  }

  detailsCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: details });
  return details;
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await res.json()) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
