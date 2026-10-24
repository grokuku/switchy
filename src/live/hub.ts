/**
 * Hub temps réel de l'onglet « Activité » — LA source unique du DIRECT.
 *
 * ⚠️ Doctrine : le temps réel ne remplace PAS tout. Deux natures de données :
 *
 *   DIRECT (poussé ici, WebSocket)          | AGRÉGATS (jamais recalculés ici)
 *   ----------------------------------------+--------------------------------------
 *   places occupées / en attente / plafond  | tokens par service et fournisseur
 *   par fournisseur                         | latence moyenne / max
 *   appels en vol par clé                   | % de réussite, replis, affinité
 *   chaque tentative qui vient de finir      | sauts pour charge (24 h)
 *
 * Les agrégats (24 h) restent servis par `GET /api/dashboard`, que l'interface
 * interroge à cadence LENTE (~30 s) : les recalculer à chaque token serait
 * absurde (24 h de journal × des centaines de tentatives).
 *
 * Deux natures de frames, donc, et deux cadences :
 *
 *   - `snapshot` : état direct complet, UNE fois à la connexion (reprise après
 *     reconnexion comprise) ;
 *   - `live`     : état direct, COALESCÉ — au plus une frame par
 *     `LIVE_COALESCE_MS` (300 ms). Un burst de 10 appels produit donc une seule
 *     frame, relue depuis les getters (`providerStates`, `inFlightByKey`) : on
 *     ne recompte jamais côté hub ;
 *   - `call`     : la ligne d'une tentative terminée, poussée immédiatement
 *     (une ligne = un fait, pas d'agrégat). Champs strictement filtrés :
 *     ⚠️ NI nom de clé, NI message d'erreur libre, NI prompt, jamais un secret.
 *
 * Aucune I/O, aucun réseau ici : le transport vit dans `live/ws.ts`. Le hub est
 * donc testable directement (coalescence, filtrage, nettoyage des abonnés).
 */
import { collectLiveProviders, collectLiveTotals } from "../llm/dashboard.js";
import { inFlightByKey } from "../llm/inflight-by-key.js";
import type { LiveCallEvent } from "./events.js";
import { onCallLogged, onLiveChange } from "./events.js";

/** Cadence maximale des frames `live` (ms) — un burst ⇒ une seule frame. */
export const LIVE_COALESCE_MS = 300;

/** Cadence suggérée côté client pour les AGRÉGATS (`GET /api/dashboard`). */
export const AGGREGATES_REFRESH_MS = 30_000;

/** Fournisseur dans le payload direct (champs courts, aucune donnée sensible). */
export interface LiveProviderPayload {
  id: string;
  active: number;
  queued: number;
  max: number;
}

export interface LivePayload {
  type: "snapshot" | "live";
  generatedAt: string;
  providers: LiveProviderPayload[];
  /** Appels en vol par NOM de clé (jamais un secret). */
  keys: { key: string; inFlight: number }[];
  totals: { active: number; queued: number };
}

export interface CallPayload {
  type: "call";
  call: LiveCallEvent;
}

export type LiveFrame = LivePayload | CallPayload;

/** Champs d'une ligne d'appel poussée en direct (liste blanche stricte). */
const CALL_FIELDS: (keyof LiveCallEvent)[] = [
  "ts",
  "callId",
  "attempt",
  "isFallback",
  "service",
  "provider",
  "model",
  "result",
  "status",
  "reason",
  "durationMs",
  "tokens",
  "charge",
  "affinity",
  "stream",
];

/**
 * Vue publique d'un événement d'appel : liste blanche. `keyName`, `error` et
 * tout champ inconnu sont écartés — le direct n'a besoin d'aucun d'eux.
 */
export function toCallPayload(entry: LiveCallEvent): CallPayload {
  const call: LiveCallEvent = {};
  for (const field of CALL_FIELDS) {
    const value = entry[field];
    if (value !== undefined) (call as Record<string, unknown>)[field] = value;
  }
  return { type: "call", call };
}

/**
 * Photographie de l'état direct : relit les getters existants, ne recompte
 * rien. `type` distingue la reprise à la connexion (`snapshot`) d'une mise à
 * jour (`live`) — le client s'en sert pour vider « Derniers appels » une seule
 * fois, à la (re)connexion.
 */
export function buildLivePayload(type: LivePayload["type"], now: number = Date.now()): LivePayload {
  const providers = collectLiveProviders();
  const totals = collectLiveTotals(providers);
  const keys = Object.entries(inFlightByKey())
    .filter(([, count]) => count > 0)
    .map(([key, inFlight]) => ({ key, inFlight }))
    .sort((a, b) => b.inFlight - a.inFlight || a.key.localeCompare(b.key, "fr"));

  return {
    type,
    generatedAt: new Date(now).toISOString(),
    providers: providers.map((provider) => ({
      id: provider.id,
      active: provider.active,
      queued: provider.queued,
      max: provider.limit,
    })),
    keys,
    totals,
  };
}

/** Destinataire d'une frame : le transport (WebSocket) fournit `send`. */
export type LiveSubscriber = (frame: string) => void;

/**
 * Hub : abonnés + coalescence. UN abonné par connexion (le transport s'inscrit
 * à l'ouverture, se retire à la fermeture — aucune fuite de listener).
 */
export class ActivityHub {
  private readonly subscribers = new Set<LiveSubscriber>();
  private readonly unsubscribers: (() => void)[] = [];
  /** Au moins un changement direct attend d'être poussé. */
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly coalesceMs: number = LIVE_COALESCE_MS) {
    // Branchement sur les points d'émission existants (aucune duplication de
    // logique métier : on ne fait que réagir à leurs notifications).
    this.unsubscribers.push(onLiveChange(() => this.markDirty()));
    this.unsubscribers.push(onCallLogged((entry) => this.broadcastCall(entry)));
  }

  /** Débranche le hub du bus (arrêt propre, tests) : plus aucun abonné au bus. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.subscribers.clear();
    this.cancelTimer();
  }

  /** Nombre d'abonnés (outil de test : vérifie le nettoyage). */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Inscrit un abonné et lui envoie AUSSITÔT le `snapshot` (reprise propre
   * après une reconnexion). Retourne la fonction de désinscription — à appeler
   * dans le `finally` de la fermeture de la connexion.
   */
  attach(send: LiveSubscriber): () => void {
    this.subscribers.add(send);
    try {
      send(JSON.stringify(buildLivePayload("snapshot")));
    } catch (err) {
      // Un socket déjà mort ne doit pas empêcher les autres de s'abonner.
      console.error("[live] snapshot failed:", err);
      this.subscribers.delete(send);
    }
    return () => {
      this.detach(send);
    };
  }

  /** Désinscrit un abonné ; le minuteur s'arrête quand plus personne n'écoute. */
  detach(send: LiveSubscriber): void {
    this.subscribers.delete(send);
    if (this.subscribers.size === 0) this.cancelTimer();
  }

  /** État direct modifié : émission coalescée (jamais plus d'une par fenêtre). */
  markDirty(): void {
    if (this.subscribers.size === 0) return;
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.broadcast(JSON.stringify(buildLivePayload("live")));
    }, this.coalesceMs);
    // Ne jamais retenir le process (arrêt propre, tests vitest).
    (this.timer as { unref?: () => void })?.unref?.();
  }

  /** Tentative terminée : poussée immédiate, une frame par ligne. */
  broadcastCall(entry: LiveCallEvent): void {
    if (this.subscribers.size === 0) return;
    this.broadcast(JSON.stringify(toCallPayload(entry)));
  }

  /** Pousse une frame brute à tous les abonnés (un mort n'arrête pas les autres). */
  private broadcast(frame: string): void {
    for (const send of this.subscribers) {
      try {
        send(frame);
      } catch (err) {
        console.error("[live] send failed:", err);
        this.subscribers.delete(send);
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }
}

/** Instance unique du process (les émissions métier alimentent ce hub). */
export const activityHub = new ActivityHub();
