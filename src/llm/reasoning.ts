/**
 * Niveaux de réflexion — SOURCE UNIQUE du vocabulaire interne, de la
 * correspondance vers la valeur RÉELLEMENT acceptée par le fournisseur
 * (`reasoning_effort`) et de la petite compatibilité de rôle.
 *
 * Partagé par la validation du catalogue (`catalog-store.ts`), la découverte
 * des modèles (`model-catalog.ts`) et le relais (`relay.ts`) pour qu'aucune
 * définition ne diverge.
 *
 * ⚠️ Deux pièges (mesurés par Pi-Web, la référence) :
 *   - le NOM du champ wire est `reasoning_effort` (OpenAI-compatible) et « off »
 *     N'EST PAS une valeur valide — il faut la chaîne EXACTE `"none"`. Sans elle,
 *     Ollama RÉACTIVE la réflexion en silence (réglage « contrôle fantôme ») ;
 *   - un niveau accepté par l'API NATIVE Ollama (`think`/`thinking`) ne l'est pas
 *     forcément par `/v1/chat/completions`.
 */
import { REASONING_LEVELS, type ProviderRecord, type ReasoningLevel } from "../catalog-store.js";

/**
 * Liste STANDARD proposée quand le fournisseur n'expose RIEN (repli affiché
 * honnêtement dans l'interface, jamais présenté comme « détecté »).
 */
export const STANDARD_REASONING_LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high"];

/** Valeur `reasoning_effort` qui DÉSACTIVE réellement la réflexion. */
export const REASONING_OFF_VALUE = "none";

/** Synonymes (et valeurs non-string) considérés comme « extinction ». */
const OFF_ALIASES = new Set(["none", "off", "disabled", "disable", "false", "no", "0"]);

/** Normalise une valeur brute du fournisseur en niveau interne, sinon `null`. */
export function normalizeReasoningLevel(raw: unknown): ReasoningLevel | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (OFF_ALIASES.has(v)) return "off";
  return (REASONING_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : null;
}

/** Vrai si la valeur est un niveau interne exploitable. */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Fournisseur Ollama — API native (`type: "ollama-native"`) OU hôte `ollama.com`
 * / port local 11434. Même critère que la détection (`model-catalog.ts`) : une
 * seule définition, jamais deux critères divergents.
 */
export function isOllamaProvider(provider: {
  type?: string;
  baseUrl?: string;
  nativeUrl?: string;
}): boolean {
  if (provider.type === "ollama-native") return true;
  return /ollama\.com|:11434/i.test(`${provider.baseUrl ?? ""} ${provider.nativeUrl ?? ""}`);
}

/**
 * Correspondance niveau interne → valeur `reasoning_effort` d'Ollama.
 * Mesuré sur Ollama Cloud : `thinking = { values: [false, "low", "high", "max"] }`.
 * Les niveaux `minimal`/`medium`/`xhigh` ne sont PAS déclarés par ce modèle : ils
 * sont repliés sur le niveau déclaré le plus proche (jamais de valeur inventée),
 * et l'extinction passe par la chaîne exacte `"none"`.
 */
const OLLAMA_LEVEL_MAP: Record<ReasoningLevel, string> = {
  off: REASONING_OFF_VALUE,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};

/**
 * Valeur à écrire dans `reasoning_effort` pour un niveau interne.
 *   - `off` → `"none"` (sinon Ollama réactive la réflexion en silence) ;
 *   - Ollama → table explicite ci-dessus ;
 *   - OpenAI-compatible → identité (le niveau vient de la détection
 *     `effort.supported_levels` ou du standard : on n'invente rien).
 */
export function reasoningWireValue(level: ReasoningLevel, provider: ProviderRecord): string {
  if (level === "off") return REASONING_OFF_VALUE;
  if (isOllamaProvider(provider)) return OLLAMA_LEVEL_MAP[level] ?? REASONING_OFF_VALUE;
  return level;
}

/**
 * Neutralise le rôle `developer` pour un fournisseur Ollama, qui ne le connaît
 * pas et répondrait 400 (« Input tag 'developer' … expected tags: system, user,
 * assistant, tool »). Le SDK Pi-Web émet ce rôle pour les modèles raisonneurs
 * (`compat.supportsDeveloperRole: false`, cf. `ollamaCompatOptions`).
 * Renvoie une copie neuve des messages si un remplacement a eu lieu, sinon
 * `undefined` (aucune écriture inutile).
 */
export function normalizeMessagesForProvider(
  messages: unknown,
  provider: ProviderRecord,
): unknown[] | undefined {
  if (!isOllamaProvider(provider) || !Array.isArray(messages)) return undefined;
  let changed = false;
  const out = messages.map((m) => {
    if (m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>).role === "developer") {
      changed = true;
      return { ...(m as Record<string, unknown>), role: "system" };
    }
    return m;
  });
  return changed ? out : undefined;
}
