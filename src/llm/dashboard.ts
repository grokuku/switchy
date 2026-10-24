/**
 * Tableau de bord d'activité de Switchy — agrège en UNE requête tout ce que
 * l'onglet « Activité » affiche :
 *
 *   1. « En ce moment »  : état de la concurrence par fournisseur (occupées /
 *      total / en attente) — l'information que le journal ne donne pas ;
 *   2. « 24 h »          : appels, réussite, replis, latence ;
 *   3. « Tokens (24 h) » : entrée / sortie / réflexion, par service ET par
 *      fournisseur, avec gestion honnête de l'inconnu (`null` → « — ») ;
 *   4. « Derniers appels » : les dernières tentatives, badge repli compris ;
 *   5. « Par clé d'API » : appels, réussite, replis, latence et tokens par NOM
 *      de clé, PLUS les appels EN VOL de chaque clé (mesure distincte des
 *      places par fournisseur).
 *
 * AUCUN cumul persistant : tout est recalculé depuis le journal borné à chaque
 * appel. Aucune donnée sensible (le journal n'en contient déjà aucune).
 */
import { getConcurrency } from "../config.js";
import { listProviders } from "../catalog-store.js";
import {
  readAllCallsLog,
  summarizeActivity,
  summarizeByKey,
  summarizeTokens,
  type ActivitySummary,
  type CallLogEntry,
  type LatencyStats,
  type TokenBreakdown,
  type TokenTotals,
} from "./calls-log.js";
import { llmSlots } from "./slot-queue.js";
import { inFlightByKey } from "./inflight-by-key.js";
import { listKeys } from "../switchy-auth.js";

/** Fenêtre d'analyse figée par la décision produit (pas de cumul journalier). */
export const DASHBOARD_WINDOW_HOURS = 24;

/** Nombre de tentatives récentes exposées par le tableau de bord. */
export const DASHBOARD_RECENT_LIMIT = 10;

/** État visuel d'un fournisseur (piloté par le remplissage de son seau). */
export type LiveState = "free" | "busy" | "saturated";

/** Occupation d'un fournisseur à l'instant du calcul. */
export interface LiveProvider {
  id: string;
  label: string;
  enabled: boolean;
  /** Plafond effectif du compte (`maxConcurrency` ou défaut global). */
  limit: number;
  /** Places occupées. */
  active: number;
  /** Appels en attente dans la file de CE fournisseur. */
  queued: number;
  state: LiveState;
}

/** Activité d'une clé d'API (nom lisible — aucun secret, aucun hash). */
export interface KeyRow {
  /** Nom de la clé (`"session"` = interface web, `"inconnu"` = indéterminé). */
  key: string;
  /** Appels EN VOL de cette clé à l'instant du calcul. */
  inFlight: number;
  /** Appels logiques (24 h). */
  calls: number;
  attempts: number;
  successRate: number | null;
  /** Appels logiques ayant utilisé au moins un repli. */
  fallbacks: number;
  latency: LatencyStats;
  tokens: TokenTotals;
}

export interface Dashboard {
  generatedAt: string;
  windowHours: number;
  live: {
    active: number;
    queued: number;
    providers: LiveProvider[];
  };
  activity: ActivitySummary;
  tokens: TokenBreakdown;
  /**
   * Statistiques PAR CLÉ (nom), triées par appels décroissants. Contient toutes
   * les clés configurées (même à zéro) et `"session"` / `"inconnu"` dès qu'ils
   * ont de l'activité (appel journalisé ou appel en vol).
   */
  byKey: KeyRow[];
  /** Dernières tentatives, la plus récente d'abord (plafonné). */
  recent: CallLogEntry[];
}

function liveState(active: number, limit: number): LiveState {
  if (active <= 0) return "free";
  return active >= limit ? "saturated" : "busy";
}

/**
 * Occupation de CHAQUE fournisseur configuré à l'instant présent (les
 * fournisseurs sans activité sont présents à zéro).
 *
 * SOURCE UNIQUE du bloc « En ce moment » : le tableau de bord complet
 * (`buildDashboard`) ET le direct WebSocket (`live/hub.ts`) l'appellent, pour
 * que les deux vues ne puissent jamais diverger.
 */
export function collectLiveProviders(): LiveProvider[] {
  const providers = listProviders();
  const states = llmSlots.providerStates(providers.map((provider) => provider.id));
  return providers.map((provider) => {
    const state = states[provider.id] ?? { limit: null, active: 0, queued: 0 };
    const limit = provider.maxConcurrency ?? getConcurrency();
    return {
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled !== false,
      limit,
      active: state.active,
      queued: state.queued,
      state: liveState(state.active, limit),
    };
  });
}

/** Totaux d'occupation (places actives / en attente, tous fournisseurs). */
export function collectLiveTotals(providers: LiveProvider[]): { active: number; queued: number } {
  return providers.reduce(
    (acc, provider) => ({ active: acc.active + provider.active, queued: acc.queued + provider.queued }),
    { active: 0, queued: 0 },
  );
}

/** Construit le tableau de bord complet (une seule lecture du journal). */
export function buildDashboard(now: number = Date.now()): Dashboard {
  const entries = readAllCallsLog();
  const liveProviders = collectLiveProviders();
  const live = collectLiveTotals(liveProviders);

  // ── Statistiques par clé d'API (nom lisible uniquement) ──
  const knownKeys = listKeys()
    .map((key) => key.name)
    .filter((name) => typeof name === "string" && name.trim() !== "");
  const inFlight = inFlightByKey();
  const rows = summarizeByKey(entries, {
    windowHours: DASHBOARD_WINDOW_HOURS,
    now,
    knownKeys,
  });
  const byKey: KeyRow[] = rows.map((row) => ({
    key: row.keyName,
    inFlight: inFlight[row.keyName] ?? 0,
    calls: row.calls,
    attempts: row.attempts,
    successRate: row.successRate,
    fallbacks: row.fallbacks,
    latency: row.latency,
    tokens: row.tokens,
  }));
  // Une clé peut avoir un appel EN VOL sans tentative encore journalisée :
  // on ajoute sa ligne (zéro appel) pour que le total reste cohérent.
  for (const [name, count] of Object.entries(inFlight)) {
    if (count <= 0 || byKey.some((row) => row.key === name)) continue;
    byKey.push({
      key: name,
      inFlight: count,
      calls: 0,
      attempts: 0,
      successRate: null,
      fallbacks: 0,
      latency: { avgMs: null, maxMs: null, samples: 0 },
      tokens: { calls: 0, prompt: null, completion: null, reasoning: null },
    });
  }
  byKey.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key, "fr"));

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: DASHBOARD_WINDOW_HOURS,
    live: { ...live, providers: liveProviders },
    activity: summarizeActivity(entries, DASHBOARD_WINDOW_HOURS, now),
    tokens: summarizeTokens(entries, DASHBOARD_WINDOW_HOURS, now),
    byKey,
    // Le journal est chronologique croissant : les dernières entrées sont en fin.
    recent: entries.slice(-DASHBOARD_RECENT_LIMIT).reverse(),
  };
}
