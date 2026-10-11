/**
 * Tableau de bord d'activité de Switchy — agrège en UNE requête tout ce que
 * l'onglet « Activité » affiche :
 *
 *   1. « En ce moment »  : état de la concurrence par fournisseur (occupées /
 *      total / en attente) — l'information que le journal ne donne pas ;
 *   2. « 24 h »          : appels, réussite, replis, latence ;
 *   3. « Tokens (24 h) » : entrée / sortie / réflexion, par service ET par
 *      fournisseur, avec gestion honnête de l'inconnu (`null` → « — ») ;
 *   4. « Derniers appels » : les dernières tentatives, badge repli compris.
 *
 * AUCUN cumul persistant : tout est recalculé depuis le journal borné à chaque
 * appel. Aucune donnée sensible (le journal n'en contient déjà aucune).
 */
import { getConcurrency } from "../config.js";
import { listProviders } from "../catalog-store.js";
import {
  readAllCallsLog,
  summarizeActivity,
  summarizeTokens,
  type ActivitySummary,
  type CallLogEntry,
  type TokenBreakdown,
} from "./calls-log.js";
import { llmSlots } from "./slot-queue.js";

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
  /** Dernières tentatives, la plus récente d'abord (plafonné). */
  recent: CallLogEntry[];
}

function liveState(active: number, limit: number): LiveState {
  if (active <= 0) return "free";
  return active >= limit ? "saturated" : "busy";
}

/** Construit le tableau de bord complet (une seule lecture du journal). */
export function buildDashboard(now: number = Date.now()): Dashboard {
  const entries = readAllCallsLog();
  const providers = listProviders();
  const states = llmSlots.providerStates(providers.map((provider) => provider.id));

  const liveProviders: LiveProvider[] = providers.map((provider) => {
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

  const live = liveProviders.reduce(
    (acc, provider) => ({ active: acc.active + provider.active, queued: acc.queued + provider.queued }),
    { active: 0, queued: 0 },
  );

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: DASHBOARD_WINDOW_HOURS,
    live: { ...live, providers: liveProviders },
    activity: summarizeActivity(entries, DASHBOARD_WINDOW_HOURS, now),
    tokens: summarizeTokens(entries, DASHBOARD_WINDOW_HOURS, now),
    // Le journal est chronologique croissant : les dernières entrées sont en fin.
    recent: entries.slice(-DASHBOARD_RECENT_LIMIT).reverse(),
  };
}
