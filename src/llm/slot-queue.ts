/**
 * Compteur de concurrence LLM de Switchy — PAR FOURNISSEUR.
 *
 * La limite appartient au COMPTE du fournisseur (ex. Ollama Cloud Pro autorise
 * 3 requêtes simultanées par compte, toutes clés et tous clients confondus).
 * Chaque fournisseur a donc son PROPRE « seau » de places : deux fournisseurs
 * différents ne se limitent JAMAIS mutuellement (c'est le cœur de la
 * correction par rapport à l'ancien compteur global unique).
 *
 * Un point unique qui connaît tous les appels en vol et applique :
 *
 *   1. le plafond `ProviderRecord.maxConcurrency` (absent = défaut global
 *      `SWITCHY_CONCURRENCY`), relu à chaud à chaque admission — la borne est
 *      au moins 1 : `0` est interdit à la saisie ;
 *   2. une file d'attente BORNÉE (`SWITCHY_QUEUE_MAX`, tous fournisseurs
 *      confondus) : au-delà, rejet immédiat (`QueueFullError` → 429 +
 *      `Retry-After` côté route) ;
 *   3. une PRIORITÉ INTRINSÈQUE au service : quand une place se libère chez un
 *      fournisseur, les appels des services marqués `prioritaire` passent
 *      AVANT les autres — c'est ainsi qu'« un léger n'attend pas derrière un
 *      lourd », SANS en-tête client. Le client n'a rien à savoir ni à envoyer ;
 *   4. un WATCHDOG qui libère de force un slot détenu anormalement longtemps
 *      (`SWITCHY_SLOT_WATCHDOG_MS`) : un client planté (abort non propagé,
 *      chemin de libération oublié) ne doit jamais figer la capacité ;
 *   5. un identifiant de slot UNIQUE par appel, généré ici (`llm:<uuid>`) —
 *      jamais une clé métier : deux appels indépendants ne doivent jamais
 *      partager un slot (leçon de réentrance, pi-sdk.md §6.1).
 *
 * La libération est idempotente (le watchdog peut avoir libéré le slot
 * entre-temps).
 */
import { randomUUID } from "crypto";
import { getQueueMax, getQueueTimeoutMs, getSlotWatchdogMs } from "../config.js";

export interface SlotRequest {
  /** Nom du service appelé (ou pseudo-service du relais natif). */
  service: string;
  /** Fournisseur visé : c'est SA limite de compte qui s'applique. */
  provider: string;
  /** Plafond effectif du fournisseur (≥ 1) — `maxConcurrency` ou défaut global. */
  limit: number;
  /** Priorité intrinsèque du service : ses appels passent avant les autres. */
  prioritaire: boolean;
}

/** File pleine : la route répond 429 + `Retry-After` (patron Libry). */
export class QueueFullError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("LLM concurrency queue is full");
    this.name = "QueueFullError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Attente expirée dans la file : la route répond 429 + `Retry-After`. */
export class QueueTimeoutError extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super("LLM concurrency queue wait timed out");
    this.name = "QueueTimeoutError";
    this.waitedMs = waitedMs;
  }
}

/** Estimation du délai avant libération d'un slot, pour `Retry-After`. */
const RETRY_AFTER_MS = 5000;

interface ActiveSlot {
  slotKey: string;
  service: string;
  provider: string;
  prioritaire: boolean;
  acquiredAt: number;
}

interface ProviderQueue {
  /** Appels prioritaires (services `prioritaire`) : drainés en premier. */
  priority: Waiter[];
  /** Appels ordinaires. */
  normal: Waiter[];
}

interface Waiter {
  slotKey: string;
  request: SlotRequest;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (slotKey: string) => void;
  reject: (err: Error) => void;
}

export interface ProviderSlotStats {
  limit: number | null;
  active: number;
  queued: number;
}

export interface SlotQueueStats {
  /** Nombre d'appels en vol, tous fournisseurs confondus. */
  active: number;
  /** Nombre d'appels en attente, tous fournisseurs confondus. */
  queued: number;
  activePriority: number;
  activeNormal: number;
  queuedPriority: number;
  queuedNormal: number;
  /** Détail par fournisseur (diagnostic, tableau de bord). */
  providers: Record<string, ProviderSlotStats>;
}

export class ProviderSlotQueue {
  private readonly active = new Map<string, ActiveSlot>();
  /** Une file par fournisseur, chacune scindée prioritaire / ordinaire. */
  private readonly queues = new Map<string, ProviderQueue>();

  /**
   * Acquiert un slot pour un appel sur le seau de SON fournisseur. Résout AVEC
   * l'identifiant de slot généré (à passer à `release`), ou rejette
   * `QueueFullError` / `QueueTimeoutError`. L'appelant DOIT toujours libérer
   * le slot (`finally` ou fin de flux).
   */
  acquire(request: SlotRequest): Promise<string> {
    if (this.canRun(request)) {
      return Promise.resolve(this.take(request));
    }

    if (this.waiterCount() >= Math.max(0, getQueueMax())) {
      return Promise.reject(new QueueFullError(RETRY_AFTER_MS));
    }

    const queue = this.queueFor(request.provider);
    const bucket = request.prioritaire ? queue.priority : queue.normal;

    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        slotKey: "",
        request,
        enqueuedAt: Date.now(),
        timer: null,
        resolve,
        reject,
      };
      const timeoutMs = getQueueTimeoutMs();
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = bucket.indexOf(waiter);
          if (idx >= 0) bucket.splice(idx, 1);
          reject(new QueueTimeoutError(Date.now() - waiter.enqueuedAt));
        }, timeoutMs);
        // Ne jamais retenir le process (arrêt propre, tests vitest).
        (waiter.timer as { unref?: () => void })?.unref?.();
      }
      bucket.push(waiter);
    });
  }

  /** Libère un slot (no-op idempotent si déjà libéré, ex. par le watchdog). */
  release(slotKey: string): void {
    const slot = this.active.get(slotKey);
    if (!slot) return;
    this.active.delete(slotKey);
    this.drain(slot.provider);
  }

  /**
   * Libère de FORCE les slots détenus au-delà du seuil du watchdog. Retourne
   * les identifiants libérés (utile aux tests). Le détenteur qui libérera plus
   * tard devient un no-op idempotent.
   */
  forceReleaseStale(now: number = Date.now()): string[] {
    const threshold = getSlotWatchdogMs();
    if (threshold <= 0) return [];
    const stale: ActiveSlot[] = [];
    for (const slot of this.active.values()) {
      if (now - slot.acquiredAt > threshold) stale.push(slot);
    }
    const freedProviders = new Set<string>();
    for (const slot of stale) {
      this.active.delete(slot.slotKey);
      freedProviders.add(slot.provider);
    }
    for (const provider of freedProviders) this.drain(provider);
    return stale.map((slot) => slot.slotKey);
  }

  /** Stats temps réel (diagnostic, tests). */
  getStats(): SlotQueueStats {
    let activePriority = 0;
    let activeNormal = 0;
    const providers: Record<string, ProviderSlotStats> = {};
    for (const slot of this.active.values()) {
      if (slot.prioritaire) activePriority++;
      else activeNormal++;
      const entry = (providers[slot.provider] ??= { limit: null, active: 0, queued: 0 });
      entry.active++;
    }

    let queuedPriority = 0;
    let queuedNormal = 0;
    for (const [provider, queue] of this.queues) {
      queuedPriority += queue.priority.length;
      queuedNormal += queue.normal.length;
      const entry = (providers[provider] ??= { limit: null, active: 0, queued: 0 });
      entry.queued = queue.priority.length + queue.normal.length;
    }

    return {
      active: this.active.size,
      queued: queuedPriority + queuedNormal,
      activePriority,
      activeNormal,
      queuedPriority,
      queuedNormal,
      providers,
    };
  }

  // ── Interne ──

  private queueFor(provider: string): ProviderQueue {
    let queue = this.queues.get(provider);
    if (!queue) {
      queue = { priority: [], normal: [] };
      this.queues.set(provider, queue);
    }
    return queue;
  }

  private waiterCount(): number {
    let n = 0;
    for (const queue of this.queues.values()) n += queue.priority.length + queue.normal.length;
    return n;
  }

  private countActiveFor(provider: string): number {
    let n = 0;
    for (const slot of this.active.values()) {
      if (slot.provider === provider) n++;
    }
    return n;
  }

  private take(request: SlotRequest): string {
    const slotKey = `llm:${randomUUID()}`;
    this.active.set(slotKey, {
      slotKey,
      service: request.service,
      provider: request.provider,
      prioritaire: request.prioritaire,
      acquiredAt: Date.now(),
    });
    return slotKey;
  }

  /** Le seau du fournisseur a-t-il encore une place libre ? (borne min 1) */
  private canRun(request: SlotRequest): boolean {
    return this.countActiveFor(request.provider) < Math.max(1, request.limit);
  }

  /**
   * Sert la file d'UN fournisseur tant que progresser est possible : une place
   * libre va d'abord au premier `prioritaire` éligible, puis au premier
   * ordinaire. Un waiteur bloqué ne doit pas bloquer les suivants.
   */
  private drain(provider: string): void {
    const queue = this.queues.get(provider);
    if (!queue) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const bucket of [queue.priority, queue.normal]) {
        for (let i = 0; i < bucket.length; i++) {
          const waiter = bucket[i];
          if (!this.canRun(waiter.request)) continue;
          bucket.splice(i, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.slotKey = this.take(waiter.request);
          waiter.resolve(waiter.slotKey);
          progressed = true;
          break;
        }
      }
    }
  }
}

/** Instance partagée du service (limites relues à chaud depuis le catalogue). */
export const llmSlots = new ProviderSlotQueue();

// Watchdog périodique : libère les slots détenus anormalement longtemps.
// `unref()` pour ne jamais retenir le process ; le seuil est relu à chaud.
const WATCHDOG_TICK_MS = 60_000;
const watchdogTimer = setInterval(() => {
  try {
    llmSlots.forceReleaseStale();
  } catch {
    /* le watchdog ne doit jamais faire tomber le process */
  }
}, WATCHDOG_TICK_MS);
(watchdogTimer as { unref?: () => void })?.unref?.();

/** Vide slots et files (outil de test : l'instance est partagée par process). */
export function resetLlmSlots(): void {
  const internals = llmSlots as unknown as {
    active: Map<string, ActiveSlot>;
    queues: Map<string, ProviderQueue>;
  };
  for (const queue of internals.queues.values()) {
    for (const waiter of [...queue.priority, ...queue.normal]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new QueueTimeoutError(0));
    }
    queue.priority.length = 0;
    queue.normal.length = 0;
  }
  internals.queues.clear();
  internals.active.clear();
}
