/**
 * Places par fournisseur — `tryAcquire` (mode rolling).
 *
 * `tryAcquire` est l'acquisition NON BLOQUANTE : elle rend un slot ou `null`,
 * sans jamais mettre l'appel en file. On verrouille ici :
 *   - place disponible → slot rendu, compté ;
 *   - seau plein → `null`, AUCUNE mise en file (le quota `SWITCHY_QUEUE_MAX`
 *     n'est pas consommé, la file du fournisseur reste vide) ;
 *   - libération UNIQUE (le second `release` est un no-op) ;
 *   - non-régression d'`acquire` : la file d'attente fonctionne toujours ;
 *   - signal déjà annulé → `null` (rien à libérer).
 *
 * Aucun réseau, aucun catalogue : l'instance est créée avec un plafond injecté.
 */
import { describe, it, expect } from "vitest";
import { ProviderSlotQueue, type SlotRequest } from "../src/llm/slot-queue.js";

function makeQueue(limit = 1): ProviderSlotQueue {
  return new ProviderSlotQueue(() => limit);
}

function req(overrides: Partial<SlotRequest> = {}): SlotRequest {
  return { service: "chat", provider: "p1", limit: 1, prioritaire: false, ...overrides };
}

describe("tryAcquire — acquisition immédiate", () => {
  it("rend un slot quand une place est libre et le compte comme actif", () => {
    const queue = makeQueue(1);
    const slot = queue.tryAcquire(req());
    expect(slot).toBeTruthy();
    expect(queue.getStats().active).toBe(1);
    expect(queue.getStats().queued).toBe(0);
    queue.release(slot as string);
    expect(queue.getStats().active).toBe(0);
  });

  it("rend null quand le seau est plein, SANS mettre l'appel en file", () => {
    const queue = makeQueue(1);
    const slot = queue.tryAcquire(req());
    expect(slot).toBeTruthy();

    expect(queue.tryAcquire(req())).toBeNull();
    // Aucune mise en file : la file reste vide (aucune attente invisible).
    expect(queue.getStats().queued).toBe(0);
    expect(queue.getStats().queuedPriority + queue.getStats().queuedNormal).toBe(0);

    queue.release(slot as string);
    expect(queue.getStats().active).toBe(0);
  });

  it("deux fournisseurs différents ne se limitent JAMAIS (un seau chacun)", () => {
    const queue = makeQueue(1);
    const a = queue.tryAcquire(req({ provider: "p1" }));
    const b = queue.tryAcquire(req({ provider: "p2" }));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    queue.release(a as string);
    queue.release(b as string);
  });

  it("libération UNIQUE : un second release est un no-op (idempotent)", () => {
    const queue = makeQueue(1);
    const slot = queue.tryAcquire(req()) as string;
    queue.release(slot);
    expect(queue.getStats().active).toBe(0);

    queue.release(slot); // déjà libéré (patron du watchdog) : ne casse rien
    expect(queue.getStats().active).toBe(0);

    // La place est bien réutilisable une seule fois.
    const next = queue.tryAcquire(req());
    expect(next).toBeTruthy();
    expect(queue.tryAcquire(req())).toBeNull();
    queue.release(next as string);
  });

  it("un signal déjà annulé rend null (aucune place acquise)", () => {
    const queue = makeQueue(1);
    const controller = new AbortController();
    controller.abort();
    expect(queue.tryAcquire(req({ signal: controller.signal }))).toBeNull();
    expect(queue.getStats().active).toBe(0);
  });

  it("non-régression d'`acquire` : seau plein → attente, servie à la libération", async () => {
    const queue = makeQueue(1);
    const held = queue.tryAcquire(req()) as string;

    const pending = queue.acquire(req());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.getStats().queued).toBe(1);

    queue.release(held);
    const waited = await pending;
    expect(waited).toBeTruthy();
    expect(queue.getStats().active).toBe(1);
    expect(queue.getStats().queued).toBe(0);
    queue.release(waited);
  });

  it("providerStates reflète les slots pris par tryAcquire", () => {
    const queue = makeQueue(2);
    const a = queue.tryAcquire(req()) as string;
    const states = queue.providerStates(["p1", "p2"]);
    expect(states.p1.active).toBe(1);
    expect(states.p2.active).toBe(0);
    queue.release(a);
  });
});
