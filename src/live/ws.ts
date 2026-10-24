/**
 * Transport WebSocket du DIRECT de l'onglet « Activité » — `/ws/activity`.
 *
 * ⚠️ DÉCISION : AUCUNE dépendance ajoutée. `ws` n'était pas au `package.json`
 * et le besoin est minuscule : le serveur n'envoie que de petites frames JSON
 * et n'accepte AUCUNE commande entrante (le client ne fait qu'écouter). On
 * implémente donc le strict nécessaire de la RFC 6455 (handshake + frames
 * texte non fragmentées, ping/pong, close) en ~150 lignes, plutôt que de
 * grossir la surface de dépendances. Limites assumées :

 *   - pas d'extension (permessage-deflate) ni de sous-protocole ;
 *   - les frames ENTRANTES ne sont pas interprétées (ping/pong/close seuls) :
 *     cette socket est un canal de lecture, jamais un canal de commande ;
 *   - `Sec-WebSocket-Version` 13 uniquement (tous les navigateurs actuels).
 *
 * AUTHENTIFICATION — même règle que `requireApiAuth` : une SESSION admin
 * (cookie `switchy_session` signé) OU une CLÉ D'API valide (`Bearer` /
 * `X-API-Key`). Le handshake est vérifié AVANT la réponse 101 : sans identité,
 * la socket est refusée (401) — aucun trou d'authentification. Précisions :
 *
 *   - la connexion est en LECTURE seule (aucune mutation) → pas de CSRF ;
 *   - le rate-limit d'Express ne s'applique pas aux `upgrade` ; l'exposition est
 *     bornée par l'auth obligatoire et par le fait qu'un client ne reçoit que
 *     l'état déjà affiché par `GET /api/dashboard` (aucun secret, aucun prompt).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Request } from "express";
import { extractApiKeys, validateKey } from "../switchy-auth.js";
import { getSessionFromRequest } from "../session-store.js";
import { activityHub, type LiveSubscriber } from "./hub.js";

/** Chemin unique du direct (aucun autre endpoint WS n'est ouvert). */
export const ACTIVITY_WS_PATH = "/ws/activity";

/** Cadence du battement de cœur (ms). */
export const HEARTBEAT_MS = 30_000;

/** Silence maximal toléré avant de couper une socket morte (ms). */
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_MS * 3;

/** Taille maximale d'une frame entrante (aucune commande n'est attendue). */
const MAX_INBOUND_FRAME = 64 * 1024;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** En-tête `Sec-WebSocket-Accept` attendu pour une clé cliente donnée. */
export function websocketAccept(key: string): string {
  return createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");
}

/** Frame WebSocket non masquée (serveur → client). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Frame texte (opcode 0x1) — le seul type que ce serveur émet. */
export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

/** Requête « façon Express » reconstruite depuis une requête HTTP brute. */
function asExpressRequest(req: IncomingMessage, url: URL): Request {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return { headers: req.headers, query } as unknown as Request;
}

/**
 * L'appelant est-il autorisé à ouvrir le direct ? Même règle que
 * `requireApiAuth` : clé d'API valide OU session admin valide.
 * Exporté PUR (aucune socket) pour être testable sans réseau.
 */
export function isActivityConnectionAuthorized(req: IncomingMessage, url: URL): boolean {
  const expressReq = asExpressRequest(req, url);
  if (extractApiKeys(expressReq).some((candidate) => validateKey(candidate))) return true;
  return getSessionFromRequest(expressReq) !== null;
}

/** Réponse HTTP minimale puis fermeture (handshake refusé). */
function rejectUpgrade(socket: Duplex, status: number, reason: string, body: string): void {
  const payload = JSON.stringify({ error: reason, code: reason });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "Connection: close\r\n\r\n" +
      payload,
  );
  socket.destroy();
}

/** Une connexion du direct : envoi de frames + lecture des pings/close. */
class ActivityConnection {
  private readonly send: LiveSubscriber;
  private readonly detach: () => void;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private lastSeen = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(private readonly socket: Duplex) {
    this.send = (frame: string) => {
      if (this.closed) return;
      this.socket.write(encodeTextFrame(frame));
    };
    // Abonnement AU HUB : le hub envoie immédiatement le `snapshot`.
    this.detach = activityHub.attach(this.send);

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.terminate());
    socket.on("close", () => this.terminate());

    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.terminate();
        return;
      }
      if (!this.closed) this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
    }, HEARTBEAT_MS);
    (this.heartbeat as { unref?: () => void })?.unref?.();
  }

  /** Ferme proprement : désabonnement du hub PUIS fermeture du socket. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    // ⚠️ Nettoyage de l'abonné : pas de fuite de listener côté hub.
    this.detach();
    try {
      this.socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* socket déjà fermé */
    }
    this.socket.destroy();
  }

  /** Lecture incrémentale des frames : ping → pong, close → fermeture. */
  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_INBOUND_FRAME) {
        this.terminate();
        return;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }

      if (opcode === 0x8) {
        this.terminate();
        return;
      }
      if (opcode === 0x9 && !this.closed) {
        this.socket.write(encodeFrame(0x0a, Buffer.from(payload)));
      }
      // 0x1 / 0x2 / 0xa : le direct est un canal de LECTURE → ignorés.
    }
  }
}

/**
 * Branche le direct sur le serveur HTTP (`server.on("upgrade")`).
 * Retourne la fonction de débranchement (tests, arrêt propre).
 */
export function attachActivityWs(server: Server): () => void {
  const connections = new Set<ActivityConnection>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "BAD_REQUEST", "invalid url");
      return;
    }
    if (url.pathname !== ACTIVITY_WS_PATH) {
      rejectUpgrade(socket, 400, "BAD_REQUEST", "unknown websocket path");
      return;
    }

    // ── Authentification AVANT le 101 ──
    if (!isActivityConnectionAuthorized(req, url)) {
      rejectUpgrade(socket, 401, "UNAUTHORIZED", "authentication required");
      return;
    }

    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    if (typeof key !== "string" || key.trim() === "" || version !== "13") {
      rejectUpgrade(socket, 400, "BAD_REQUEST", "websocket handshake required");
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key.trim())}\r\n\r\n`,
    );
    (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    (socket as { setTimeout?: (ms: number) => void }).setTimeout?.(0);

    const connection = new ActivityConnection(socket);
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
  };

  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const connection of connections) connection.terminate();
    connections.clear();
  };
}
