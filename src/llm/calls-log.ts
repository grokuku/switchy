/**
 * Journal d'appels de Switchy — fichier JSONL `$SWITCHY_DATA_DIR/calls.jsonl`.
 *
 * ⚠️ OBLIGATOIRE : chaque TENTATIVE de relais est journalisée (un repli
 * silencieux est un changement de qualité invisible). Une tentative = un
 * appel à UN fournisseur avec UN modèle : le principal (rang `attempt: 0`)
 * puis chaque repli (`attempt: 1..n`), qu'il ait abouti, échoué ou été
 * ignoré (fournisseur absent/désactivé).
 *
 * ⚠️ SÉCURITÉ : le journal ne contient JAMAIS de clé d'API ni de contenu de
 * prompt — uniquement des métadonnées techniques (horodatage, identifiant
 * d'appel `callId`, service, fournisseur, modèle, résultat, code HTTP, motif
 * CATÉGORISÉ `reason` (liste blanche), durée, tokens si le fournisseur les
 * fournit, rang du repli). Les messages d'erreur stockés sont ceux des échecs
 * RÉSEAU, tronqués — jamais le corps d'une réponse fournisseur.
 *
 * Stockage BORNÉ :
 *   - `SWITCHY_CALLS_LOG_MODE`            : `off` | `summary` (défaut) | `full` ;
 *   - `SWITCHY_CALLS_LOG_MAX_ENTRIES`    : compaction par NOMBRE (0 = illimité) ;
 *   - `SWITCHY_CALLS_LOG_RETENTION_DAYS` : purge par ÂGE (0 = jamais).
 * La compaction est synchrone et déclenchée par l'écriture (ou périodiquement
 * pour la seule purge d'âge) ; le fichier ne dépasse jamais `max + 1` entrées
 * (compaction immédiate au franchissement).
 *
 * Écriture en AJOUT (`append`), fichier 0600, répertoire 0700, réécriture de
 * compaction via tmp + rename — même pattern que les autres magasins.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import { getCallsLogFile, getCallsLogMaxEntries, getCallsLogMode, getCallsLogRetentionDays } from "../config.js";

export interface CallLogTokens {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * Tokens de RÉFLEXION (reasoning), quand le fournisseur les expose
   * (`completion_tokens_details.reasoning_tokens`). Absent = le fournisseur ne
   * les détaille pas : l'interface affiche « — », jamais un 0 trompeur.
   */
  reasoningTokens?: number;
}

/** Résultat d'une tentative de relais. */
export type CallResult = "ok" | "error" | "aborted" | "skipped";

/**
 * Motif CATÉGORISÉ d'un échec — liste blanche FERMÉE. C'est le SEUL niveau de
 * détail toléré sur la cause : jamais le corps, jamais la clé, jamais le prompt.
 *   - `quota`         : quota/limite d'usage épuisé (ex. Ollama « weekly usage limit ») ;
 *   - `rate_limit`    : 429 de débit (trop de requêtes), sans motif de quota ;
 *   - `overloaded`    : 503 (service momentanément indisponible) ;
 *   - `auth_error`    : 401/403 (clé invalide/expirée ou droits insuffisants) ;
 *   - `network_error` : échec réseau (aucune réponse HTTP) ;
 *   - `upstream_error`: tout autre code / erreur amont ;
 *   - `saturated`     : AUCUNE place libre chez le fournisseur. Ce n'est PAS une
 *                       erreur du fournisseur mais une bascule pour CHARGE
 *                       (mode rolling) : jamais comptée comme échec fournisseur.
 */
export const CALL_REASONS = [
  "quota",
  "rate_limit",
  "overloaded",
  "auth_error",
  "network_error",
  "upstream_error",
  "saturated",
] as const;
export type CallReason = (typeof CALL_REASONS)[number];

/**
 * Identifiant d'un APPEL LOGIQUE, commun à TOUTES ses tentatives (principal +
 * replis). Permet de constater un repli sans corréler à la main horodatage et
 * service : deux lignes partageant le même `callId` = un seul appel replié.
 * Court (12 caractères hexadécimaux) pour rester lisible dans le journal.
 */
export function newCallId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Catégorise un échec fournisseur en motif court (voir `CallReason`).
 * `bodyText` sert UNIQUEMENT à distinguer un quota épuisé d'un simple débit
 * dépassé : il n'est JAMAIS journalisé (il peut contenir du contexte compte).
 */
export function classifyReason(status: number | undefined, bodyText?: string): CallReason {
  if (status === undefined) return "network_error";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) {
    const hay = (bodyText ?? "").toLowerCase();
    if (hay.includes("quota") || hay.includes("usage limit")) return "quota";
    if (hay.includes("limit") && !hay.includes("rate limit")) return "quota";
    return "rate_limit";
  }
  if (status === 503) return "overloaded";
  return "upstream_error";
}

export interface CallLogEntry {
  /** Horodatage ISO 8601 de la FIN de la tentative. */
  ts: string;
  /** Identifiant de l'appel logique, commun à toutes ses tentatives (facultatif : entrées antérieures). */
  callId?: string;
  /** Service du catalogue (ou `native:<providerId>` pour le relais natif). */
  service: string;
  /**
   * NOM de la clé d'API qui a déclenché l'appel (`"session"` pour l'interface
   * web, `"inconnu"` si indéterminé). ⚠️ JAMAIS la valeur de la clé ni son
   * hash : le nom suffit à attribuer l'appel. Absent des entrées antérieures
   * au champ → comptées sous « inconnu » par le tableau de bord.
   */
  keyName?: string;
  /** Rang dans la chaîne : 0 = principal, 1.. = repli n° (repli ⇔ attempt > 0). */
  attempt: number;
  /** Repli ? Explicité (= `attempt > 0`) pour une lecture immédiate, sans calcul. */
  isFallback?: boolean;
  /** Fournisseur visé. */
  provider: string;
  /** Modèle demandé au fournisseur. */
  model: string;
  result: CallResult;
  /** Code HTTP de la réponse fournisseur (absent si échec réseau). */
  status?: number;
  /** Motif CATÉGORISÉ de l'échec (liste blanche) — jamais le corps ni un secret. */
  reason?: CallReason;
  /** Message court d'un échec réseau (jamais le corps du fournisseur). */
  error?: string;
  durationMs: number;
  /** Consommation rapportée par le fournisseur, si disponible. */
  tokens?: CallLogTokens;
  /**
   * BASCULE POUR CHARGE : au moins une étape avait été écartée faute de place
   * (mode rolling) avant cette tentative. Permet de distinguer une bascule pour
   * charge d'une bascule pour ERREUR (`reason`). Additif — absent des entrées
   * antérieures.
   */
  charge?: boolean;
  /**
   * AFFINITÉ APPLIQUÉE : cette tentative est celle du fournisseur repris parce
   * qu'il est le dernier à avoir répondu pour cette clé (cache chaud). Additif.
   */
  affinity?: boolean;
  // ── Mode « full » uniquement ──
  /** Le service appelé était-il prioritaire ? (priorité intrinsèque, sans en-tête) */
  prioritaire?: boolean;
  stream?: boolean;
  endpoint?: string;
  providerType?: string;
}

export type CallLogInput = Omit<CallLogEntry, "ts"> & { ts?: string };

/** Champs essentiels conservés en mode « summary ». */
const ESSENTIAL: (keyof CallLogEntry)[] = [
  "ts",
  "callId",
  "service",
  "keyName",
  "attempt",
  "isFallback",
  "provider",
  "model",
  "result",
  "status",
  "reason",
  "error",
  "durationMs",
  "tokens",
  "stream",
  "charge",
  "affinity",
];

/** Longueur maximale d'un message d'erreur réseau journalisé. */
const MAX_ERROR_CHARS = 300;

/** Champs exposés par la route de consultation (whitelist : un fichier modifié à la main ne peut rien injecter). */
const READ_FIELDS: (keyof CallLogEntry)[] = [...ESSENTIAL, "prioritaire", "endpoint", "providerType"];

// ── État mémoire (un seul process) ──

let lineCount: number | null = null;
let dirEnsured: string | null = null;

function ensureLogDir(): void {
  const dir = path.dirname(getCallsLogFile());
  if (dirEnsured === dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  dirEnsured = dir;
}

function countLines(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    const text = readFileSync(file, "utf-8");
    let n = 0;
    for (const line of text.split("\n")) if (line.trim() !== "") n++;
    return n;
  } catch {
    return 0;
  }
}

function parseLine(line: string): CallLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const raw = JSON.parse(trimmed) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as CallLogEntry;
  } catch {
    return null;
  }
}

function truncateError(message: unknown): string | undefined {
  if (typeof message !== "string" || message === "") return undefined;
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/**
 * Journalise une tentative (append JSONL). No-op en mode `off`. Ne lève
 * JAMAIS : le journal ne doit pas faire échouer un appel LLM.
 */
export function logCall(input: CallLogInput): void {
  try {
    if (getCallsLogMode() === "off") return;
    const entry: CallLogEntry = {
      ...input,
      ts: input.ts ?? new Date().toISOString(),
      // Un repli est une tentative de rang > 0 : on l'EXPLICITE pour que le
      // journal se lise sans recalcul (les entrées antérieures restent lisibles).
      isFallback: input.isFallback ?? (typeof input.attempt === "number" && input.attempt > 0),
      error: truncateError(input.error),
    };
    if (getCallsLogMode() !== "full") {
      const summary: Partial<CallLogEntry> = {};
      for (const field of ESSENTIAL) {
        if (entry[field] !== undefined) (summary as Record<string, unknown>)[field] = entry[field];
      }
      ensureLogDir();
      appendFileSync(getCallsLogFile(), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    } else {
      ensureLogDir();
      appendFileSync(getCallsLogFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }

    if (lineCount === null) lineCount = countLines(getCallsLogFile());
    else lineCount += 1;

    const max = getCallsLogMaxEntries();
    if (max > 0 && lineCount > max) compactCallsLog();
  } catch (err) {
    console.error("[calls-log] Failed to append entry:", err);
  }
}

export interface CompactResult {
  before: number;
  after: number;
  removed: number;
}

/**
 * Compacte le journal : purge les entrées plus vieilles que la rétention et ne
 * garde que les dernières (marge interne de 5 % pour ne pas réécrire à chaque
 * écriture). Réécriture atomique. Appelée par `logCall` au franchissement de la
 * borne, par le timer de rétention, et directement par les tests.
 */
export function compactCallsLog(now: number = Date.now()): CompactResult {
  const file = getCallsLogFile();
  try {
    if (!existsSync(file)) {
      lineCount = 0;
      return { before: 0, after: 0, removed: 0 };
    }
    const lines = readFileSync(file, "utf-8").split("\n");
    const entries: { line: string; ts: number }[] = [];
    for (const line of lines) {
      const entry = parseLine(line);
      if (!entry) continue;
      const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
      entries.push({ line: JSON.stringify(entry), ts });
    }

    const retentionDays = getCallsLogRetentionDays();
    const cutoff = retentionDays > 0 ? now - retentionDays * 86_400_000 : Number.NEGATIVE_INFINITY;
    let kept = entries.filter((e) => Number.isFinite(e.ts) && e.ts >= cutoff);

    const max = getCallsLogMaxEntries();
    if (max > 0 && kept.length > max) {
      const step = Math.max(1, Math.floor(max / 20));
      kept = kept.slice(-(max - step));
    }

    if (kept.length !== entries.length) {
      ensureLogDir();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, kept.length > 0 ? `${kept.map((e) => e.line).join("\n")}\n` : "", { mode: 0o600 });
      renameSync(tmp, file);
    }
    lineCount = kept.length;
    return { before: entries.length, after: kept.length, removed: entries.length - kept.length };
  } catch (err) {
    console.error("[calls-log] Failed to compact:", err);
    lineCount = null;
    return { before: 0, after: 0, removed: 0 };
  }
}

export interface CallsLogQuery {
  limit?: number;
  offset?: number;
  service?: string;
  result?: string;
}

/**
 * Bilan des replis, calculé sur le journal (indépendamment des filtres de la
 * page). Objectif : l'utilisateur VOIT que son repli payant a été sollicité, et
 * combien de fois. Les répartitions portent sur la fenêtre (`windowHours`).
 */
export interface FallbackStats {
  /** Taille de la fenêtre des répartitions, en heures. */
  windowHours: number;
  /** Nombre total de tentatives de repli journalisées (tout le journal). */
  total: number;
  /** Nombre de tentatives de repli dans la fenêtre. */
  last24h: number;
  /** Tentatives de repli de la fenêtre, par service appelé. */
  byService: Record<string, number>;
  /** Tentatives de repli de la fenêtre, par fournisseur de repli sollicité. */
  byFallbackProvider: Record<string, number>;
  /** Tentatives de repli de la fenêtre, par motif catégorisé. */
  reasons: Record<string, number>;
}

/** Ramasse les tentatives de repli et leurs répartitions sur `windowHours`. */
export function summarizeFallbacks(
  entries: CallLogEntry[],
  windowHours = 24,
  now: number = Date.now(),
): FallbackStats {
  const cutoff = now - Math.max(0, windowHours) * 3_600_000;
  const stats: FallbackStats = {
    windowHours,
    total: 0,
    last24h: 0,
    byService: {},
    byFallbackProvider: {},
    reasons: {},
  };
  const bump = (bucket: Record<string, number>, key: string): void => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const entry of entries) {
    const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
    const inWindow = Number.isFinite(ts) ? ts >= cutoff : true;
    // Un repli est une tentative de rang > 0 (isFallback explicite ou ancien journal).
    const isFallback = entry.isFallback === true || (typeof entry.attempt === "number" && entry.attempt > 0);
    if (isFallback) {
      stats.total += 1;
      if (inWindow) {
        stats.last24h += 1;
        bump(stats.byService, String(entry.service ?? "?"));
        bump(stats.byFallbackProvider, String(entry.provider ?? "?"));
      }
    }
    // Motifs d'échec de la fenêtre — TOUS rangs confondus : c'est la raison de
    // l'échec du principal (429 quota, 503…) qui explique le repli.
    if (typeof entry.reason === "string" && inWindow) bump(stats.reasons, entry.reason);
  }
  return stats;
}

export interface CallsLogPage {
  entries: CallLogEntry[];
  total: number;
  limit: number;
  offset: number;
  /** Bilan des replis (global, non filtré) — voir `FallbackStats`. */
  summary: FallbackStats;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// ── Agrégations du tableau de bord (fenêtre 24 h) ──
//
// Tout est calculé à la lecture depuis le journal : AUCUN cumul persistant.
// Les appels sont regroupés par `callId` (appel LOGIQUE) afin de ne pas
// compter un repli comme un appel supplémentaire.

/** Latence (ms) des tentatives RÉUSSIES de la fenêtre. */
export interface LatencyStats {
  avgMs: number | null;
  maxMs: number | null;
  /** Nombre de tentatives ayant servi au calcul (0 = « — »). */
  samples: number;
}

/** Bilan « 24 h » de l'onglet Activité. */
export interface ActivitySummary {
  windowHours: number;
  /** Appels LOGIQUES (identifiants `callId` distincts) dans la fenêtre. */
  calls: number;
  /** Tentatives journalisées (principal + replis). */
  attempts: number;
  /** Appels logiques terminés par un succès (dernière tentative `ok`). */
  succeeded: number;
  /** Appels logiques terminés par un échec/abandon. */
  failed: number;
  /** `succeeded / calls`, ou `null` si aucun appel. */
  successRate: number | null;
  /** Appels logiques ayant utilisé AU MOINS un repli. */
  fallbacks: number;
  /** Tentatives de repli (pour information). */
  fallbackAttempts: number;
  /** `fallbacks / calls`, ou `null` si aucun appel. */
  fallbackRate: number | null;
  /**
   * Tentatives ÉCARTÉES faute de place (bascule pour CHARGE, mode rolling).
   * Distinctes des replis pour ERREUR : jamais des échecs fournisseur.
   */
  loadFallbacks: number;
  /** Tentatives servies par AFFINITÉ de cache (fournisseur repris pour cette clé). */
  affinityHits: number;
  latency: LatencyStats;
}

/** Totaux de tokens d'un groupe (total, service ou fournisseur). */
export interface TokenTotals {
  /** Tentatives de la fenêtre ayant rapporté un `usage` dans ce groupe. */
  calls: number;
  /** Tokens d'entrée — `null` si AUCUNE tentative du groupe ne les expose. */
  prompt: number | null;
  /** Tokens de sortie — `null` si inconnu. */
  completion: number | null;
  /** Tokens de réflexion — `null` si le fournisseur ne les expose pas. */
  reasoning: number | null;
}

/** Consommation de tokens : total, puis par service et par fournisseur. */
export interface TokenBreakdown {
  total: TokenTotals;
  byService: Record<string, TokenTotals>;
  byProvider: Record<string, TokenTotals>;
}

/** Vrai si l'horodatage tombe dans la fenêtre (horodatage illisible = inclus). */
function withinWindow(ts: unknown, cutoff: number): boolean {
  const parsed = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(parsed) ? parsed >= cutoff : true;
}

interface CallGroup {
  last: CallLogEntry;
  lastAttempt: number;
  hasFallback: boolean;
}

/**
 * Résumé « 24 h » : appels, réussite, replis et latence. Les appels sont
 * regroupés par `callId` (un repli n'est PAS un appel de plus) ; les entrées
 * sans `callId` (journal antérieur) comptent individuellement. La latence ne
 * porte que sur les tentatives RÉUSSIES (un échec immédiat ne reflète pas la
 * latence de service).
 */
export function summarizeActivity(
  entries: CallLogEntry[],
  windowHours = 24,
  now: number = Date.now(),
): ActivitySummary {
  const cutoff = now - Math.max(0, windowHours) * 3_600_000;
  const groups = new Map<string, CallGroup>();
  let attempts = 0;
  let fallbackAttempts = 0;
  let loadFallbacks = 0;
  let affinityHits = 0;
  let latencySum = 0;
  let latencyMax: number | null = null;
  let latencySamples = 0;

  entries.forEach((entry, index) => {
    if (!withinWindow(entry.ts, cutoff)) return;
    attempts += 1;
    if (entry.reason === "saturated") loadFallbacks += 1;
    if (entry.affinity === true) affinityHits += 1;
    const attempt = typeof entry.attempt === "number" ? entry.attempt : 0;
    const isFallback = entry.isFallback === true || attempt > 0;
    if (isFallback) fallbackAttempts += 1;

    const key = typeof entry.callId === "string" && entry.callId !== "" ? entry.callId : `__${index}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { last: entry, lastAttempt: attempt, hasFallback: isFallback });
    } else {
      if (attempt >= group.lastAttempt) {
        group.last = entry;
        group.lastAttempt = attempt;
      }
      if (isFallback) group.hasFallback = true;
    }

    const ms = entry.durationMs;
    if (entry.result === "ok" && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
      latencySum += ms;
      latencySamples += 1;
      if (latencyMax === null || ms > latencyMax) latencyMax = ms;
    }
  });

  let succeeded = 0;
  let fallbacks = 0;
  for (const group of groups.values()) {
    if (group.last.result === "ok") succeeded += 1;
    if (group.hasFallback) fallbacks += 1;
  }
  const calls = groups.size;
  return {
    windowHours,
    calls,
    attempts,
    succeeded,
    failed: calls - succeeded,
    successRate: calls > 0 ? succeeded / calls : null,
    fallbacks,
    fallbackAttempts,
    fallbackRate: calls > 0 ? fallbacks / calls : null,
    loadFallbacks,
    affinityHits,
    latency: {
      avgMs: latencySamples > 0 ? Math.round(latencySum / latencySamples) : null,
      maxMs: latencyMax,
      samples: latencySamples,
    },
  };
}

function emptyTokenTotals(): TokenTotals {
  return { calls: 0, prompt: null, completion: null, reasoning: null };
}

/** Additionne les tokens d'une entrée dans un accumulateur (champ par champ). */
function addTokens(target: TokenTotals, entry: CallLogEntry): void {
  const tokens = entry.tokens;
  if (!tokens) return;
  target.calls += 1;
  if (typeof tokens.promptTokens === "number") target.prompt = (target.prompt ?? 0) + tokens.promptTokens;
  if (typeof tokens.completionTokens === "number") target.completion = (target.completion ?? 0) + tokens.completionTokens;
  if (typeof tokens.reasoningTokens === "number") target.reasoning = (target.reasoning ?? 0) + tokens.reasoningTokens;
}

/**
 * Agrège les tokens de la fenêtre : total, par service et par fournisseur.
 * Chaque champ (entrée/sortie/réflexion) reste `null` tant qu'AUCUNE tentative
 * du groupe ne l'expose → l'interface affiche « — » (jamais un 0 trompeur).
 * Les groupes sans aucun `usage` rapporté ne créent pas de ligne.
 */
export function summarizeTokens(
  entries: CallLogEntry[],
  windowHours = 24,
  now: number = Date.now(),
): TokenBreakdown {
  const cutoff = now - Math.max(0, windowHours) * 3_600_000;
  const total = emptyTokenTotals();
  const byService: Record<string, TokenTotals> = {};
  const byProvider: Record<string, TokenTotals> = {};
  for (const entry of entries) {
    if (!entry.tokens || !withinWindow(entry.ts, cutoff)) continue;
    addTokens(total, entry);
    addTokens((byService[String(entry.service ?? "?")] ??= emptyTokenTotals()), entry);
    addTokens((byProvider[String(entry.provider ?? "?")] ??= emptyTokenTotals()), entry);
  }
  return { total, byService, byProvider };
}

/** Activité agrégée d'UNE clé d'API (nom, jamais un secret). */
export interface KeyActivity {
  keyName: string;
  /** Appels LOGIQUES (identifiants `callId` distincts) de la fenêtre. */
  calls: number;
  /** Tentatives journalisées (principal + replis). */
  attempts: number;
  successRate: number | null;
  /** Appels logiques ayant utilisé AU MOINS un repli. */
  fallbacks: number;
  latency: LatencyStats;
  /** Tokens de la clé (champs `null` si le fournisseur ne les expose pas). */
  tokens: TokenTotals;
}

/** Nom affiché pour une entrée dont la clé n'est pas connue. */
export const UNKNOWN_KEY_NAME = "inconnu";

/**
 * Agrège l'activité PAR CLÉ D'API (nom de clé) sur la fenêtre :
 * appels, réussite, replis, latence et tokens. Comptage identique à
 * `summarizeActivity` (regroupement par `callId`), appliqué à chaque clé.
 *
 * `knownKeys` (facultatif) force la présence de lignes à zéro pour les clés
 * configurées mais inactives : l'addition des lignes couvre alors tout le
 * total. Les entrées sans `keyName` (journal antérieur) sont comptées sous
 * « inconnu » — jamais dans une clé arbitraire.
 */
export function summarizeByKey(
  entries: CallLogEntry[],
  options: { windowHours?: number; now?: number; knownKeys?: Iterable<string> } = {},
): KeyActivity[] {
  const windowHours = options.windowHours ?? 24;
  const now = options.now ?? Date.now();
  const cutoff = now - Math.max(0, windowHours) * 3_600_000;

  const buckets = new Map<string, CallLogEntry[]>();
  const bucketFor = (name: string): CallLogEntry[] => {
    let list = buckets.get(name);
    if (!list) {
      list = [];
      buckets.set(name, list);
    }
    return list;
  };
  for (const key of options.knownKeys ?? []) {
    const name = typeof key === "string" ? key.trim() : "";
    if (name !== "") bucketFor(name);
  }
  for (const entry of entries) {
    if (!withinWindow(entry.ts, cutoff)) continue;
    const raw = typeof entry.keyName === "string" ? entry.keyName.trim() : "";
    bucketFor(raw === "" ? UNKNOWN_KEY_NAME : raw).push(entry);
  }

  const rows: KeyActivity[] = [];
  for (const [keyName, list] of buckets) {
    const activity = summarizeActivity(list, windowHours, now);
    const tokens = summarizeTokens(list, windowHours, now).total;
    rows.push({
      keyName,
      calls: activity.calls,
      attempts: activity.attempts,
      successRate: activity.successRate,
      fallbacks: activity.fallbacks,
      latency: activity.latency,
      tokens,
    });
  }
  // Les clés les plus actives d'abord ; à égalité, ordre alphabétique stable.
  rows.sort((a, b) => b.calls - a.calls || a.keyName.localeCompare(b.keyName, "fr"));
  return rows;
}

/** Vue publique d'une entrée : whitelist stricte des champs (fichier non fiable). */
function toPublicEntry(raw: CallLogEntry): CallLogEntry {
  const out: Partial<CallLogEntry> = {};
  for (const field of READ_FIELDS) {
    if (raw[field] !== undefined) (out as Record<string, unknown>)[field] = raw[field];
  }
  // Toujours un `ts` et un `result` pour l'affichage — jamais `undefined`.
  if (typeof out.ts !== "string") out.ts = new Date(0).toISOString();
  if (typeof out.result !== "string") out.result = "error";
  return out as CallLogEntry;
}

/**
 * Lit TOUTES les entrées publiques du journal (ordre chronologique croissant,
 * whitelist appliquée). Base commune de la pagination et des agrégations.
 */
function readPublicEntries(): CallLogEntry[] {
  const file = getCallsLogFile();
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .map(parseLine)
      .filter((e): e is CallLogEntry => e !== null)
      .map(toPublicEntry);
  } catch (err) {
    console.error("[calls-log] Failed to read:", err);
    return [];
  }
}

/**
 * Toutes les entrées du journal (pour les agrégations du tableau de bord).
 * Le fichier est borné par la compaction : une lecture complète reste
 * raisonnable.
 */
export function readAllCallsLog(): CallLogEntry[] {
  return readPublicEntries();
}

/**
 * Lit le journal, du PLUS RÉCENT au plus ancien, avec pagination et filtres
 * facultatifs (`service`, `result`). Le fichier est borné par la compaction :
 * une lecture complète reste raisonnable.
 */
export function readCallsLog(query: CallsLogQuery = {}): CallsLogPage {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  let entries = readPublicEntries();

  // Le bilan des replis porte sur TOUT le journal (non filtré) : c'est un
  // compteur de référence, pas une vue de la page courante.
  const summary = summarizeFallbacks(entries);

  if (query.service) entries = entries.filter((e) => e.service === query.service);
  if (query.result) entries = entries.filter((e) => e.result === query.result);

  const total = entries.length;
  // Le plus récent d'abord : l'ordre du fichier est chronologique croissant.
  const page = entries.reverse().slice(offset, offset + limit);
  return { entries: page, total, limit, offset, summary };
}

// ── Purge périodique de la rétention (le nombre est géré à l'écriture) ──
const RETENTION_TICK_MS = 3_600_000;
const retentionTimer = setInterval(() => {
  try {
    const max = getCallsLogMaxEntries();
    const retentionDays = getCallsLogRetentionDays();
    if (retentionDays > 0 || (max > 0 && lineCount !== null && lineCount > max)) compactCallsLog();
  } catch {
    /* la purge ne doit jamais faire tomber le process */
  }
}, RETENTION_TICK_MS);
(retentionTimer as { unref?: () => void })?.unref?.();

/** Réinitialise les compteurs mémoire (outil de test). */
export function resetCallsLogState(): void {
  lineCount = null;
  dirEnsured = null;
}
