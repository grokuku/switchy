/**
 * Magasin de réglages de Switchy — fichier `$SWITCHY_DATA_DIR/config.json`.
 *
 * Modèle de résolution appliqué à TOUS les réglages exposés :
 *
 *     env ?? fichier ?? défaut
 *
 * — l'environnement reste PRIORITAIRE (un réglage fourni par l'env n'est jamais
 *   écrasé par le fichier et n'est pas éditable depuis l'UI) ;
 * — le fichier est le repli « à chaud » : comme les getters de `config.ts`
 *   relisent l'environnement à chaque appel, une valeur écrite ici est prise en
 *   compte sans redémarrage (sauf réglages dits « redémarrage requis ») ;
 * — le défaut est le dernier recours.
 *
 * Sécurité : `config.json` peut contenir des secrets (clé d'API des outils de
 * Switchy). Il est écrit en ATOMIQUE (tmp + rename) avec les permissions 0600,
 * et son répertoire est ramené en 0700 — même pattern que `switchy-auth.ts`.
 *
 * Les valeurs sont TOUJOURS stockées sous forme de chaînes (comme l'env) : les
 * getters appelants restent responsables de l'analyse (nombre, booléen, liste).
 *
 * ⚠️ Ce fichier ne contient QUE des réglages SCALAIRES. Les collections
 * (fournisseurs, services) vivent dans leur propre fichier — voir
 * `catalog-store.ts` : ce n'est PAS un réglage, c'est une collection versionnable.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from "fs";
import path from "path";

// ── Emplacement (résolu depuis l'environnement SEUL) ──

/**
 * Répertoire de données, lu depuis l'environnement UNIQUEMENT. `SWITCHY_DATA_DIR`
 * ne peut pas être fourni par `config.json` (qui vit précisément dans ce
 * répertoire) : c'est un réglage « envOnly » + « redémarrage requis ».
 */
function envDataDir(): string {
  const raw = process.env.SWITCHY_DATA_DIR;
  return path.resolve(raw !== undefined && raw.trim() !== "" ? raw.trim() : "/app/data");
}

/** Chemin absolu du fichier de réglages. */
export function settingsFilePath(): string {
  return path.join(envDataDir(), "config.json");
}

// ── Lecture (mise en cache par mtime) ──

type SettingsObject = Record<string, string>;

let cache: { mtimeMs: number; data: SettingsObject } | null = null;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Ne conserve que les entrées non vides sous forme de chaîne (robustesse fichier). */
function sanitizeObject(raw: unknown): SettingsObject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SettingsObject = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** Contenu brut du fichier (objet plat, jamais `null`). Cache invalidé au mtime. */
export function readSettingsFile(): SettingsObject {
  const file = settingsFilePath();
  try {
    if (!existsSync(file)) {
      cache = null;
      return {};
    }
    const stat = statSync(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const data = sanitizeObject(JSON.parse(readFileSync(file, "utf-8")));
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (e) {
    console.error("[settings] Failed to load config.json:", e);
    return {};
  }
}

/** Réinitialise le cache (outil de test). */
export function resetSettingsCache(): void {
  cache = null;
}

// ── Réglages non fournissables par le fichier ──

/** Réglages dont la valeur ne peut venir QUE de l'environnement. */
const ENV_ONLY = new Set<string>(["SWITCHY_DATA_DIR"]);

function envValue(name: string): string | null {
  return nonEmptyString(process.env[name]);
}

// ── Résolution `env ?? fichier ?? défaut` ──

/** Valeur effective d'un réglage (chaîne), selon `env ?? fichier ?? défaut`. */
export function resolveSetting(name: string, defaultValue: string): string {
  const env = envValue(name);
  if (env !== null) return env;
  if (!ENV_ONLY.has(name)) {
    const fileValue = nonEmptyString(readSettingsFile()[name]);
    if (fileValue !== null) return fileValue;
  }
  return defaultValue;
}

/** Origine de la valeur effective, pour l'UI : « env », « fichier » ou « défaut ». */
export function getSettingSource(name: string): "env" | "file" | "default" {
  if (envValue(name) !== null) return "env";
  if (!ENV_ONLY.has(name) && nonEmptyString(readSettingsFile()[name]) !== null) return "file";
  return "default";
}

// ── Écriture atomique (tmp + rename), permissions restrictives ──

function ensureConfigDir(): string {
  const dir = path.dirname(settingsFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/**
 * Applique des mises à jour au fichier de réglages. `null` EFFACE l'entrée
 * (retour à l'env / au défaut) ; une chaîne la définit. Écriture atomique 0600.
 */
export function writeSettings(updates: Record<string, string | null>): SettingsObject {
  ensureConfigDir();
  const file = settingsFilePath();
  const next: SettingsObject = { ...readSettingsFile() };
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  const sorted: SettingsObject = {};
  for (const key of Object.keys(next).sort()) sorted[key] = next[key];
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  cache = null;
  return sorted;
}

// ── Catalogue déclaratif des réglages exposés ──

export type SettingType = "string" | "number" | "boolean" | "stringList" | "path" | "secret";

export interface SettingSpec {
  name: string;
  /** Groupe d'affichage dans l'UI. */
  group: string;
  type: SettingType;
  /** Défaut présenté (chaîne, comme l'env). */
  default: string;
  /** Lu une seule fois au démarrage → une modification prend effet au redémarrage. */
  restartRequired?: boolean;
  /** Ne peut être fourni QUE par l'environnement (jamais édité via le fichier). */
  envOnly?: boolean;
  /** Valeurs admises (type « string ») : l'UI propose un menu, la validation borne. */
  options?: readonly string[];
  /** Borne inférieure (type « number »). */
  min?: number;
  /** Borne supérieure (type « number »). */
  max?: number;
}

/**
 * Réglages exposés par l'API de configuration. Un réglage de type « secret »
 * n'est JAMAIS renvoyé en clair (voir `routes/settings.ts`).
 *
 * ⚠️ Les collections (fournisseurs, services) ne figurent PAS ici : chacune vit
 * dans son propre fichier (`catalog.json`) — un catalogue rigide ne peut pas
 * décrire une liste à taille variable (cf. `catalog-store.ts`).
 */
export const SETTINGS_SPEC: readonly SettingSpec[] = [
  // ── Serveur (redémarrage requis : lus au démarrage) ──
  { name: "SWITCHY_HOST", group: "server", type: "string", default: "0.0.0.0", restartRequired: true },
  { name: "SWITCHY_PORT", group: "server", type: "number", default: "3008", restartRequired: true, min: 1, max: 65535 },

  // ── Données (chemin du fichier de réglages et des collections) ──
  { name: "SWITCHY_DATA_DIR", group: "data", type: "path", default: "/app/data", restartRequired: true, envOnly: true },
  { name: "SWITCHY_CATALOG_FILE", group: "data", type: "path", default: "/app/data/catalog.json" },
  { name: "SWITCHY_KEYS_FILE", group: "data", type: "path", default: "/app/data/switchy-keys.json" },
  { name: "SWITCHY_CALLS_LOG_FILE", group: "data", type: "path", default: "/app/data/calls.jsonl" },

  // ── Runtime (appliqués à chaud) ──
  { name: "SWITCHY_LOG_LEVEL", group: "runtime", type: "string", default: "info", options: ["debug", "info", "warn", "error"] },
  {
    name: "SWITCHY_CONCURRENCY",
    group: "runtime",
    type: "number",
    default: "3",
    min: 1,
    max: 1000,
  },
  {
    name: "SWITCHY_QUEUE_MAX",
    group: "runtime",
    type: "number",
    default: "100",
    min: 0,
    max: 100_000,
  },
  {
    name: "SWITCHY_QUEUE_TIMEOUT_MS",
    group: "runtime",
    type: "number",
    default: "3600000",
    min: 0,
    max: 86_400_000,
  },
  {
    name: "SWITCHY_SLOT_WATCHDOG_MS",
    group: "runtime",
    type: "number",
    default: "1800000",
    min: 0,
    max: 86_400_000,
  },

  // ── Journal d'appels (Lot 3) ──
  {
    name: "SWITCHY_CALLS_LOG_MODE",
    group: "callsLog",
    type: "string",
    default: "summary",
    options: ["off", "summary", "full"],
  },
  {
    name: "SWITCHY_CALLS_LOG_RETENTION_DAYS",
    group: "callsLog",
    type: "number",
    default: "7",
    min: 0,
    max: 3650,
  },
  {
    name: "SWITCHY_CALLS_LOG_MAX_ENTRIES",
    group: "callsLog",
    type: "number",
    default: "10000",
    min: 0,
    max: 10_000_000,
  },

  // ── Sécurité / accès ──
  // Clé d'API optionnelle fournie par l'environnement, acceptée pour les OUTILS
  // (en plus des clés nommées créées depuis l'interface).
  { name: "SWITCHY_API_KEY", group: "security", type: "secret", default: "" },
  {
    name: "SWITCHY_SESSION_TTL_HOURS",
    group: "security",
    type: "number",
    default: "12",
    min: 1,
    max: 720,
  },
  { name: "SWITCHY_RATE_LIMIT_PER_MIN", group: "security", type: "number", default: "600", restartRequired: true, min: 1, max: 1_000_000 },
];

const SPEC_BY_NAME = new Map<string, SettingSpec>(SETTINGS_SPEC.map((s) => [s.name, s]));

/** Spécification d'un réglage exposé, ou `null` si le nom est inconnu. */
export function getSettingSpec(name: string): SettingSpec | null {
  return SPEC_BY_NAME.get(name) ?? null;
}

/** Vrai si le réglage est de type secret (jamais renvoyé en clair). */
export function isSecretSetting(spec: SettingSpec): boolean {
  return spec.type === "secret";
}

// ── Validation d'une valeur proposée ──

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string };

/** Normalise et valide une valeur selon le type déclaré du réglage. */
export function validateSettingValue(spec: SettingSpec, raw: unknown): ValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: `${spec.name}: value must be a string (or null to clear)` };
  }
  const trimmed = raw.trim();

  switch (spec.type) {
    case "number": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${spec.name}: expected an integer` };
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) return { ok: false, error: `${spec.name}: not a valid number` };
      if (spec.min !== undefined && parsed < spec.min) return { ok: false, error: `${spec.name}: must be >= ${spec.min}` };
      if (spec.max !== undefined && parsed > spec.max) return { ok: false, error: `${spec.name}: must be <= ${spec.max}` };
      return { ok: true, value: String(parsed) };
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") return { ok: false, error: `${spec.name}: expected true or false` };
      return { ok: true, value: lower };
    }
    case "stringList": {
      const items = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { ok: true, value: items.join(",") };
    }
    case "secret":
    case "path":
    case "string":
    default: {
      if (spec.options && !spec.options.includes(trimmed)) {
        return { ok: false, error: `${spec.name}: expected one of ${spec.options.join(", ")}` };
      }
      return { ok: true, value: trimmed };
    }
  }
}
