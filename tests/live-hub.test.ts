/**
 * Temps réel de l'onglet « Activité » — logique du hub et du transport.
 *
 * AUCUN RÉSEAU, AUCUNE SOCKET : on teste la LOGIQUE (coalescence, filtrage des
 * champs, snapshot, nettoyage des abonnés, auth du handshake) et pas le
 * transport lui-même. `vi.useFakeTimers` pilote la fenêtre de coalescence.
 *
 * Ce que la suite verrouille :
 *   - un BURST de changements directs ⇒ UNE seule frame `live` (pas 10) ;
 *   - le `snapshot` envoyé à la connexion reprend l'état des getters existants
 *     (`providerStates`, `inFlightByKey`) ;
 *   - une frame `call` ne contient NI nom de clé, NI message d'erreur, NI prompt ;
 *   - la désinscription vide le hub et arrête le minuteur (pas de fuite) ;
 *   - l'émission est bien branchée sur le point existant (`logCall`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage } from "http";
import { makeTestEnv, seedProvider, type TestEnv } from "./helpers.js";
import { ActivityHub, buildLivePayload, toCallPayload, type LivePayload } from "../src/live/hub.js";
import { callListenerCount, liveListenerCount, notifyLiveChange } from "../src/live/events.js";
import { beginCall, endCall } from "../src/llm/inflight-by-key.js";
import { llmSlots } from "../src/llm/slot-queue.js";
import { logCall, type CallLogEntry } from "../src/llm/calls-log.js";
import {
  ACTIVITY_WS_PATH,
  encodeTextFrame,
  isActivityConnectionAuthorized,
  websocketAccept,
} from "../src/live/ws.js";

let env: TestEnv;
let hub: ActivityHub;

/** Abonné de test : collecte les frames JSON reçues. */
function collector(): { frames: LivePayload[]; send: (frame: string) => void } {
  const frames: LivePayload[] = [];
  return {
    frames,
    send: (frame: string) => {
      frames.push(JSON.parse(frame) as LivePayload);
    },
  };
}

beforeEach(() => {
  env = makeTestEnv();
  hub = new ActivityHub(300);
  vi.useFakeTimers();
});

afterEach(() => {
  hub.dispose();
  vi.useRealTimers();
  env.cleanup();
});

describe("hub — snapshot à la connexion", () => {
  it("reprend l'état des getters existants (places et appels en vol)", async () => {
    await seedProvider(env.app, {
      id: "ollama",
      label: "Ollama",
      type: "openai-compatible",
      baseUrl: "https://ollama.example/v1",
      maxConcurrency: 2,
    });
    const slot = llmSlots.tryAcquire({ service: "chat", provider: "ollama", limit: 2, prioritaire: false });
    beginCall("outil-a");

    const client = collector();
    // L'abonné reçoit un snapshot dès l'attache (reprise après reconnexion).
    hub.attach(client.send);
    const payload = client.frames[0];

    expect(payload.type).toBe("snapshot");
    expect(payload.providers).toEqual([{ id: "ollama", active: 1, queued: 0, max: 2 }]);
    expect(payload.keys).toEqual([{ key: "outil-a", inFlight: 1 }]);
    expect(payload.totals).toEqual({ active: 1, queued: 0 });

    // Et les getters d'origine reflètent le même état (aucune duplication).
    expect(buildLivePayload("live").providers).toEqual(payload.providers);

    endCall("outil-a");
    if (slot) llmSlots.release(slot);
  });

  it("ne divulgue aucune identité de clé dans les compteurs (nom seul)", () => {
    beginCall("cle-nommee");
    const payload = buildLivePayload("live");
    expect(payload.keys.map((k) => k.key)).toEqual(["cle-nommee"]);
    // Aucun champ de type secret (valeur, hash) n'existe dans le payload.
    expect(Object.keys(payload)).toEqual(["type", "generatedAt", "providers", "keys", "totals"]);
    endCall("cle-nommee");
  });
});

describe("hub — coalescence des frames live", () => {
  it("un burst de 10 changements produit UNE seule frame", () => {
    const client = collector();
    hub.attach(client.send);
    client.frames.length = 0; // on ignore le snapshot initial

    for (let i = 0; i < 10; i++) {
      beginCall("burst");
      endCall("burst");
      notifyLiveChange();
    }
    expect(client.frames).toHaveLength(0); // rien avant la fin de la fenêtre

    vi.advanceTimersByTime(299);
    expect(client.frames).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(client.frames).toHaveLength(1);
    expect(client.frames[0].type).toBe("live");

    // Fenêtre suivante : un nouveau changement ⇒ une nouvelle frame, pas plus.
    notifyLiveChange();
    vi.advanceTimersByTime(300);
    expect(client.frames).toHaveLength(2);
  });

  it("n'émet rien quand personne n'écoute (aucun minuteur armé)", () => {
    notifyLiveChange();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hub — frame « call »", () => {
  it("ne contient ni nom de clé, ni message d'erreur, ni prompt", () => {
    const entry = {
      ts: new Date().toISOString(),
      callId: "call-1",
      service: "chat",
      provider: "ollama",
      model: "gpt-test",
      attempt: 0,
      result: "ok" as const,
      durationMs: 42,
      keyName: "cle-tres-secrete",
      error: "upstream said: sk-ABC123",
      prompt: "bonjour, voici mon secret",
      tokens: { promptTokens: 3, completionTokens: 5 },
    };
    const frame = toCallPayload(entry);
    const json = JSON.stringify(frame);

    expect(frame.type).toBe("call");
    expect(json).not.toContain("cle-tres-secrete");
    expect(json).not.toContain("sk-ABC123");
    expect(json).not.toContain("bonjour");
    expect(Object.keys(frame.call)).not.toContain("keyName");
    expect(Object.keys(frame.call)).not.toContain("error");
    // Les champs utiles à l'affichage sont bien là.
    expect(frame.call.service).toBe("chat");
    expect(frame.call.result).toBe("ok");
    expect(frame.call.durationMs).toBe(42);
  });

  it("est poussée immédiatement (hors coalescence), une frame par ligne", () => {
    const client = collector();
    hub.attach(client.send);
    client.frames.length = 0;

    hub.broadcastCall({ ts: new Date().toISOString(), service: "a", result: "ok", durationMs: 5 });
    hub.broadcastCall({ ts: new Date().toISOString(), service: "b", result: "error", durationMs: 7 });

    expect(client.frames).toHaveLength(2);
    expect(client.frames.map((f) => f.type)).toEqual(["call", "call"]);
  });
});

describe("hub — nettoyage des abonnés", () => {
  it("la désinscription retire l'abonné et arrête le minuteur", () => {
    const client = collector();
    const detach = hub.attach(client.send);
    expect(hub.size).toBe(1);

    notifyLiveChange();
    expect(vi.getTimerCount()).toBe(1);

    detach();
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un abonné qui lève n'empêche pas les autres de recevoir (et est retiré)", () => {
    const good = collector();
    hub.attach(() => {
      throw new Error("socket morte");
    });
    hub.attach(good.send);
    good.frames.length = 0;

    hub.broadcastCall({ ts: new Date().toISOString(), service: "x", result: "ok" });

    expect(good.frames).toHaveLength(1);
    expect(hub.size).toBe(1);
  });

  it("dispose() débranche le hub du bus d'événements", () => {
    const before = { live: liveListenerCount(), call: callListenerCount() };
    hub.dispose();
    expect(liveListenerCount()).toBe(before.live - 1);
    expect(callListenerCount()).toBe(before.call - 1);
  });
});

describe("émission branchée sur le point existant", () => {
  it("logCall() pousse la ligne terminée au direct", () => {
    const client = collector();
    hub.attach(client.send);
    client.frames.length = 0;

    const entry: CallLogEntry = {
      ts: new Date().toISOString(),
      service: "chat",
      keyName: "outil-a",
      attempt: 1,
      provider: "ollama",
      model: "gpt-test",
      result: "error",
      status: 500,
      reason: "upstream_error",
      durationMs: 120,
    };
    logCall(entry);

    expect(client.frames).toHaveLength(1);
    expect(client.frames[0].type).toBe("call");
    expect(JSON.stringify(client.frames[0])).not.toContain("outil-a");
  });
});

describe("transport — handshake et authentification", () => {
  it("calcule la clé d'acceptation RFC 6455", () => {
    // Valeur d'exemple de la RFC : SHA-1(key + GUID) en base64.
    expect(websocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("encode une frame texte non masquée (opcode 0x1)", () => {
    const frame = encodeTextFrame("{}");
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(2);
    expect(frame.subarray(2).toString("utf8")).toBe("{}");

    const big = encodeTextFrame("x".repeat(200));
    expect(big[1]).toBe(126);
    expect(big.readUInt16BE(2)).toBe(200);
  });

  it("accepte une clé d'API valide et refuse sans identité", () => {
    const url = new URL(ACTIVITY_WS_PATH, "http://localhost");
    const withKey = { headers: { "x-api-key": process.env.SWITCHY_API_KEY } } as unknown as IncomingMessage;
    const anonymous = { headers: {} } as unknown as IncomingMessage;

    expect(isActivityConnectionAuthorized(withKey, url)).toBe(true);
    expect(isActivityConnectionAuthorized(anonymous, url)).toBe(false);
  });

  it("le chemin du direct est unique et stable", () => {
    expect(ACTIVITY_WS_PATH).toBe("/ws/activity");
  });
});
