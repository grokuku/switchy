/**
 * [1] Seau anti-abus du handshake WebSocket `/ws/activity`.
 *
 * ⚠️ Les requêtes `upgrade` ne traversent JAMAIS la pile HTTP d'Express : le
 * `rateLimit` d'`index.ts` ne les voit pas. Sans seau dédié, un anonyme pouvait
 * boucler des handshakes (chacun déclenchant une validation de clé, donc
 * potentiellement un `scryptSync` par clé stockée) sans aucun quota.
 *
 * Ces tests utilisent un faux `Server` et une fausse socket : aucun réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  ACTIVITY_WS_PATH,
  WS_UPGRADE_RATE_LIMIT,
  attachActivityWs,
  resetUpgradeRateLimit,
} from "../src/live/ws.js";

interface Harness {
  attempt: (ip: string) => string;
  detach: () => void;
  requests: IncomingMessage[];
}

function makeHarness(): Harness {
  const handlers: ((req: IncomingMessage, socket: Duplex) => void)[] = [];
  const server = {
    on: (_event: string, fn: (req: IncomingMessage, socket: Duplex) => void) => {
      handlers.push(fn);
    },
    off: () => {},
  } as unknown as Server;
  const detach = attachActivityWs(server);
  const requests: IncomingMessage[] = [];

  const attempt = (ip: string): string => {
    const writes: string[] = [];
    const socket = {
      write: (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      },
      destroy: () => {},
      on: () => {},
      setNoDelay: () => {},
      setTimeout: () => {},
    } as unknown as Duplex;
    const req = {
      url: ACTIVITY_WS_PATH,
      headers: {},
      socket: { remoteAddress: ip },
    } as unknown as IncomingMessage;
    requests.push(req);
    for (const handler of handlers) handler(req, socket);
    return writes.join("");
  };

  return { attempt, detach, requests };
}

describe("[1] quota du handshake WebSocket", () => {
  beforeEach(() => resetUpgradeRateLimit());
  afterEach(() => resetUpgradeRateLimit());

  it(`au plus ${WS_UPGRADE_RATE_LIMIT} handshakes par minute et par IP`, () => {
    const { attempt, detach } = makeHarness();
    try {
      // Les tentatives sous le quota sont traitées normalement (401 : pas d'auth).
      for (let i = 0; i < WS_UPGRADE_RATE_LIMIT; i++) {
        expect(attempt("203.0.113.7")).toContain("401");
      }
      // Au-delà : refus AVANT même l'authentification.
      const blocked = attempt("203.0.113.7");
      expect(blocked).toContain("429");
      expect(blocked).toContain("RATE_LIMITED");
      expect(blocked).not.toContain("401");
    } finally {
      detach();
    }
  });

  it("le quota est PAR IP : une IP épuisée ne bloque pas les autres", () => {
    const { attempt, detach } = makeHarness();
    try {
      for (let i = 0; i < WS_UPGRADE_RATE_LIMIT + 5; i++) attempt("198.51.100.1");
      expect(attempt("198.51.100.2")).toContain("401");
    } finally {
      detach();
    }
  });
});
