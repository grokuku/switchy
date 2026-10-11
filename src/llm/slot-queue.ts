/**
 * Compteur GLOBAL de concurrence LLM de Switchy — la raison d'être du service.
 *
 * Un point unique qui connaît TOUS les appels en vol (toutes clés et tous
 * clients confondus) et applique :
 *
 *   1. la limite globale `SWITCHY_CONCURRENCY` (défaut 3 — abonnement Ollama
 *      Cloud Pro), relue À CHAUD à chaque admission ;
 *   2. une file d'attente BORNÉE (`SWITCHY_QUEUE_MAX`) : au-delà, rejet
 *      immédiat (`QueueFullError` → 429 + `Retry-After` côté route) ;
 *   3. des RÉSERVATIONS par service, par classe d'appel (« léger ≤
 *      reservations.light, lourd ≤ reservations.heavy ») : un service peut
 *      plafonner sa propre simultanéité pour ne pas saturer la limite globale
 *      et laisser de la place aux autres — c'est ainsi qu'« un léger n'attend
 *      pas derrière un lourd » ;
 *   4. une PRIORITÉ de file aux appels légers : lorsqu'un slot se libère, les
 *      `light` en attente passent avant les `heavy` ;
 *   5. un WATCHDOG qui libère de force un slot détenu anormalement longtemps
 *      (`SWITCHY_SLOT_WATCHDOG_MS`) : un client planté (abort non propagé,
 *      chemin de libération oublié) ne doit jamais figer la capacité ;
 *   6. un identifiant de slot UNIQUE par appel, généré ici
 *      (`llm:<uuid>`) — jamais une clé métier : deux appels indépendants ne
 *      doivent jamais partager un slot (leçon de réentrance, pi-sdk.md §6.1).
 *
 * Ce module ne connaît AUCUN mot produit : les services sont des noms du
 * catalogue, la classe d'appel est fournie par l'appelant. La libération est
 * idempotente (le watchdog peut avoir libéré le slot entre-temps).
 */
import { randomUUID } from "crypto";
import { getConcurrency, getQueueMax, getQueueTimeoutMs, getSlotWatchdogMs } from "../config.js";
import type { ServiceReservations } from "../catalog-store.js";

/** Classe d'un appel : « léger » (interactif, court) ou « lourd » (agent, long). */
export type SlotClass = "light" | "heavy";

export interface SlotRequest {
  /** Nom du service appelé (ou pseudo-service du relais natif). */
  service: string;
  /** Classe d'appel — détermine la priorité de file et le quota appliqué. */
  cls: SlotClass;
  /** Réservations du service (`{ light?, heavy? }`) — quota simultané par classe. */
  reservations?: ServiceReservations;
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
  cls: SlotClass;
  acquiredAt: number;
}

interface Waiter {
  slotKey: string;
  request: SlotRequest;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (slotKey: string) => void;
  reject: (err: Error) => void;
}

export interface SlotQueueStats {
  limit: number;
  active: number;
  queued: number;
  activeLight: number;
  activeHeavy: number;
  queuedLight: number;
  queuedHeavy: number;
}

export class GlobalSlotQueue {
  private readonly active = new Map<string, ActiveSlot>();
  /** Deux files FIFO : les `light` sont drainés AVANT les `heavy`. */
  private readonly lightQueue: Waiter[] = [];
  private readonly heavyQueue: Waiter[] = [];

  /**
   * Acquiert un slot pour un appel. Résout AVEC l'identifiant de slot généré
   * (à passer à `release`), ou rejette `QueueFullError` / `QueueTimeoutError`.
   * L'appelant DOIT toujours libérer le slot (`finally` ou fin de flux).
   */
  acquire(request: SlotRequest): Promise<string> {
    if (this.canRun(request)) {
      const slotKey = this.take(request);
      return Promise.resolve(slotKey);
    }

    const queue = this.queueFor(request.cls);
    if (this.waiterCount() >= Math.max(0, getQueueMax())) {
      return Promise.reject(new QueueFullError(RETRY_AFTER_MS));
    }

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
          const idx = this.indexOf(queue, waiter);
          if (idx >= 0) queue.splice(idx, 1);
          reject(new QueueTimeoutError(Date.now() - waiter.enqueuedAt));
        }, timeoutMs);
        // Ne jamais retenir le process (arrêt propre, tests vitest).
        (waiter.timer as { unref?: () => void })?.unref?.();
      }
      queue.push(waiter);
    });
  }

  /** Libère un slot (no-op idempotent si déjà libéré, ex. par le watchdog). */
  release(slotKey: string): void {
    if (!this.active.delete(slotKey)) return;
    this.drain();
  }

  /**
   * Libère de FORCE les slots détenus au-delà du seuil du watchdog. Retourne
   * les identifiants libérés (utile aux tests). Le détenteur qui libérera plus
   * tard devient un no-op idempotent.
   */
  forceReleaseStale(now: number = Date.now()): string[] {
    const threshold = getSlotWatchdogMs();
    if (threshold <= 0) return [];
    const stale: string[] = [];
    for (const slot of this.active.values()) {
      if (now - slot.acquiredAt > threshold) stale.push(slot.slotKey);
    }
    for (const slotKey of stale) {
      this.active.delete(slotKey);
      this.drain();
    }
    return stale;
  }

  /** Stats temps réel (diagnostic, tests ; le tableau de bord viendra au Lot 4). */
  getStats(): SlotQueueStats {
    let activeLight = 0;
    let activeHeavy = 0;
    for (const slot of this.active.values()) {
      if (slot.cls === "light") activeLight++;
      else activeHeavy++;
    }
    return {
      limit: getConcurrency(),
      active: this.active.size,
      queued: this.waiterCount(),
      activeLight,
      activeHeavy,
      queuedLight: this.lightQueue.length,
      queuedHeavy: this.heavyQueue.length,
    };
  }

  // ── Interne ──

  private queueFor(cls: SlotClass): Waiter[] {
    return cls === "light" ? this.lightQueue : this.heavyQueue;
  }

  private waiterCount(): number {
    return this.lightQueue.length + this.heavyQueue.length;
  }

  private indexOf(queue: Waiter[], waiter: Waiter): number {
    return queue.indexOf(waiter);
  }

  private take(request: SlotRequest): string {
    const slotKey = `llm:${randomUUID()}`;
    this.active.set(slotKey, {
      slotKey,
      service: request.service,
      cls: request.cls,
      acquiredAt: Date.now(),
    });
    return slotKey;
  }

  private countActive(service: string, cls: SlotClass): number {
    let n = 0;
    for (const slot of this.active.values()) {
      if (slot.service === service && slot.cls === cls) n++;
    }
    return n;
  }

  /** Quota simultané du service pour la classe demandée (`null` = aucun quota). */
  private quotaFor(request: SlotRequest): number | null {
    const reservations = request.reservations;
    if (!reservations) return null;
    const quota = request.cls === "light" ? reservations.light : reservations.heavy;
    return typeof quota === "number" ? quota : null;
  }

  private canRun(request: SlotRequest): boolean {
    if (this.active.size >= Math.max(1, getConcurrency())) return false;
    const quota = this.quotaFor(request);
    if (quota !== null && this.countActive(request.service, request.cls) >= quota) return false;
    return true;
  }

  /**
   * Sert les files tant que progresser est possible : un slot libre va d'abord
   * au premier `light` éligible (priorité), puis au premier `heavy` éligible.
   * Un premier waiteur bloqué par SON quota ne doit pas bloquer les suivants
   * (services différents) : on scanne la file.
   */
  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const queue of [this.lightQueue, this.heavyQueue]) {
        for (let i = 0; i < queue.length; i++) {
          const waiter = queue[i];
          if (!this.canRun(waiter.request)) continue;
          queue.splice(i, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.slotKey = this.take(waiter.request);
          waiter.resolve(waiter.slotKey);
          progressed = true;
          break;
        }
        if (this.active.size >= Math.max(1, getConcurrency())) return;
      }
    }
  }
}

/** Instance partagée du service (limites relues à chaud depuis la config). */
export const llmSlots = new GlobalSlotQueue();

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
  const stats = llmSlots as unknown as {
    active: Map<string, ActiveSlot>;
    lightQueue: Waiter[];
    heavyQueue: Waiter[];
  };
  for (const waiter of [...stats.lightQueue, ...stats.heavyQueue]) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(new QueueTimeoutError(0));
  }
  stats.lightQueue.length = 0;
  stats.heavyQueue.length = 0;
  stats.active.clear();
}
