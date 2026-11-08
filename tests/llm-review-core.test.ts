/**
 * Revue du cœur LLM — verrous des correctifs de la revue :
 *
 *   [01] RÉGRESSION PERF : `logCall` ne compacte QUE sur franchissement de la
 *        borne par NOMBRE. La purge d'ÂGE (7 j par défaut) ne doit jamais
 *        réécrire le journal à chaque tentative — elle appartient au timer.
 *        Le mode `off` continue d'appliquer la borne.
 *   [02] TAUX DE RÉUSSITE : le « dernier essai » d'un appel se choisit parmi les
 *        tentatives RÉELLEMENT exécutées. Une entrée `skipped` de rang supérieur
 *        (repli désactivé / fournisseur absent) n'écrase plus le `ok` du
 *        principal → plus de 0 % de réussite affiché à tort.
 *   [03] SLOT PERDU : un slot expiré portant un `onExpire` finit par être
 *        RÉCUPÉRÉ à la 2ᵉ visite du watchdog (l'appel orphelin ne rend jamais
 *        sa place) ; le `release()` tardif reste un no-op.
 *   [04] DÉCOUVERTE GARDÉE : `safeFetch` porte un `AbortSignal` (timeout court)
 *        — un fournisseur muet ne fige plus la requête HTTP.
 *   [05] TOKENS DE RÉFLEXION : `completion_tokens_details.reasoning_tokens`
 *        PRIME, `reasoning_tokens` à plat sert de second recours.
 *   [10] RÉPONSE ILLISIBLE : un corps NON VIDE non-JSON devient 502
 *        `PROVIDER_BAD_RESPONSE` (jamais « aucun modèle ») ; un corps vide reste
 *        toléré.
 *   [07] COUPE EXPLIQUÉE : une tentative interrompue porte sa CAUSE
 *        (`watchdog` ou `client_disconnect`) — plus de `result: "aborted"` muet.
 *   [08] CLASSIFICATION BORNÉE : seuls les 2048 premiers octets d'un corps
 *        d'erreur sont convertis puis classés.
 *   [11] CACHE DE DÉCOUVERTE : la clé du fournisseur (empreinte courte
 *        non réversible) entre dans la clé de cache, et les entrées expirées
 *        sont purgées à l'insertion.
 *   [12] ROLLING SANS DOUBLON : les étapes écartées définitivement (fournisseur
 *        absent/désactivé) ne sont plus re-journalisées à la 2ᵉ passe.
 *
 * AUCUN réseau : `globalThis.fetch` est mocké.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  waitFor,
  TEST_API_KEY,
  type TestEnv,
} from "./helpers.js";
import { compactCallsLog, logCall, resetCallsLogState, summarizeActivity } from "../src/llm/calls-log.js";
import { ProviderSlotQueue, llmSlots, type SlotRequest } from "../src/llm/slot-queue.js";
import { normalizeUsage } from "../src/llm/relay.js";
import { modelCatalogCacheSizes } from "../src/llm/model-catalog.js";
import type { CallLogEntry } from "../src/llm/calls-log.js";

let env: TestEnv;
let mock: ReturnType<typeof installMockFetch> | null = null;

beforeEach(() => {
  env = makeTestEnv();
  mock = null;
});

afterEach(() => {
  mock?.restore();
  env.cleanup();
});

function logFile(): string {
  return join(env.dir, "calls.jsonl");
}

function writeLines(entries: Array<Record<string, unknown>>): void {
  writeFileSync(logFile(), entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
}

function readLines(): Array<Record<string, unknown>> {
  if (!existsSync(logFile())) return [];
  return readFileSync(logFile(), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    ts: new Date().toISOString(),
    service: "chat",
    attempt: 0,
    provider: "p1",
    model: "m",
    result: "ok",
    durationMs: 10,
    ...overrides,
  };
}

/** Fournisseurs p1 (principal) + p2 (repli) ; `fallbackEnabled: false` éteint le repli. */
async function seedChat(fallbackEnabled = true): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Principal",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
    apiKey: "sk-P1",
  });
  await seedProvider(env.app, {
    id: "p2",
    label: "Repli",
    type: "openai-compatible",
    baseUrl: "https://p2.example/v1",
    apiKey: "sk-P2",
  });
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: step("p1", "model-a"),
    fallbacks: [{ ...step("p2", "model-b"), enabled: fallbackEnabled }],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
  });
}

// ── [01] Pas de compaction sur le chemin chaud ─────────────────────────────

describe("[01] logCall ne compacte pas à chaque écriture (purge d'âge au timer)", () => {
  it("une entrée HORS rétention survit à un logCall tant que la borne n'est pas franchie", () => {
    // Rétention 7 j (défaut) : la condition `retentionDays > 0` était toujours
    // vraie → compaction COMPLÈTE (parse + reserialize) à chaque tentative.
    const old = entry({ ts: new Date(Date.now() - 30 * 86_400_000).toISOString(), provider: "vieux" });
    writeLines([old]);
    resetCallsLogState();

    logCall(entry({ provider: "frais" }));

    const lines = readLines();
    expect(lines.map((l) => l.provider)).toEqual(["vieux", "frais"]);
  });

  it("le franchissement de la borne par NOMBRE compacte bien (comportement conservé)", () => {
    process.env.SWITCHY_CALLS_LOG_MAX_ENTRIES = "3";
    const existing = [0, 1, 2, 3].map((i) => entry({ provider: `p${i}` }));
    writeLines(existing);
    resetCallsLogState();

    logCall(entry({ provider: "nouveau" }));

    const lines = readLines();
    expect(lines.length).toBeLessThanOrEqual(3);
    // La dernière entrée écrite est toujours présente (on garde les plus récentes).
    expect(lines[lines.length - 1].provider).toBe("nouveau");
  });

  it("mode `off` : aucune entrée ajoutée, mais la borne par NOMBRE reste appliquée", () => {
    process.env.SWITCHY_CALLS_LOG_MODE = "off";
    process.env.SWITCHY_CALLS_LOG_MAX_ENTRIES = "2";
    writeLines([0, 1, 2, 3, 4].map((i) => entry({ provider: `p${i}` })));
    resetCallsLogState();

    logCall(entry({ provider: "jamais-ecrit" }));

    const lines = readLines();
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.some((l) => l.provider === "jamais-ecrit")).toBe(false);
  });

  it("compactCallsLog applique toujours la purge d'ÂGE (appelée par le timer)", () => {
    process.env.SWITCHY_CALLS_LOG_MAX_ENTRIES = "0";
    const old = entry({ ts: new Date(Date.now() - 30 * 86_400_000).toISOString(), provider: "vieux" });
    writeLines([old, entry({ provider: "frais" })]);
    resetCallsLogState();

    const result = compactCallsLog();
    expect(result.before).toBe(2);
    expect(readLines().map((l) => l.provider)).toEqual(["frais"]);
  });

  it("un journal sous la borne reste intact après un logCall (aucune réécriture)", () => {
    process.env.SWITCHY_CALLS_LOG_MAX_ENTRIES = "10000";
    const now = Date.now();
    writeLines(
      Array.from({ length: 1000 }, (_, i) =>
        entry({ ts: new Date(now - 1000 + i).toISOString(), provider: `p${i}` }),
      ),
    );
    resetCallsLogState();
    const before = readFileSync(logFile(), "utf-8");

    logCall(entry({ provider: "ajout" }));

    const after = readFileSync(logFile(), "utf-8");
    // Le fichier n'a fait que GROSSIR d'une ligne (append), il n'a pas été réécrit.
    expect(after.startsWith(before)).toBe(true);
    expect(readLines()).toHaveLength(1001);
  });

  it("régression intégrée : un appel réel ne réécrit pas le journal (rétention par défaut)", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const old = entry({ ts: new Date(Date.now() - 30 * 86_400_000).toISOString(), provider: "vieux" });
    writeLines([old]);
    resetCallsLogState();

    const res = await api(env.app).post("/v1/chat/completions").send({
      model: "chat",
      messages: [{ role: "user", content: "bonjour" }],
    });

    expect(res.status).toBe(200);
    // L'entrée hors rétention n'a PAS été purgée par le chemin d'écriture.
    expect(readLines()[0].provider).toBe("vieux");
  });
});

// ── [02] Taux de réussite ─────────────────────────────────────────────────

describe("[02] le dernier essai se choisit parmi les tentatives exécutées", () => {
  it("principal OK puis repli `skipped` → successRate = 1 (et non 0)", () => {
    // Chemin exact de production : `logCall(skipped, attempt:1)` AVANT
    // `logCall(ok, attempt:0)` → l'entrée `skipped` est la dernière du journal.
    const entries: CallLogEntry[] = [
      entry({ ts: new Date().toISOString(), callId: "c1", attempt: 1, provider: "p2", result: "skipped", reason: "step_disabled", isFallback: true }),
      entry({ ts: new Date().toISOString(), callId: "c1", attempt: 0, provider: "p1", result: "ok", durationMs: 120 }),
    ];

    const summary = summarizeActivity(entries, 24, Date.now());
    expect(summary.calls).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.successRate).toBe(1);
    // Les entrées `skipped` ne comptent ni comme tentative ni comme repli exécuté.
    expect(summary.attempts).toBe(1);
    expect(summary.fallbackAttempts).toBe(0);
  });

  it("un échec RÉEL après un succès reste un échec (pas de complaisance)", () => {
    const entries: CallLogEntry[] = [
      entry({ ts: new Date().toISOString(), callId: "c2", attempt: 0, provider: "p1", result: "ok" }),
      entry({ ts: new Date().toISOString(), callId: "c2", attempt: 1, provider: "p2", result: "error", isFallback: true }),
    ];
    const summary = summarizeActivity(entries, 24, Date.now());
    expect(summary.successRate).toBe(0);
  });

  it("seule une entrée `skipped` → l'appel n'est pas compté comme réussi", () => {
    const summary = summarizeActivity(
      [entry({ ts: new Date().toISOString(), callId: "c3", result: "skipped", reason: "step_disabled" })],
      24,
      Date.now(),
    );
    expect(summary.calls).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.attempts).toBe(0);
  });

  it("intégration : [principal OK, repli désactivé] → l'onglet Activité affiche 100 %", async () => {
    // Repli p2 DÉSACTIVÉ (bouton de la ligne) : il est journalisé `skipped` au
    // rang 1, JAMAIS appelé.
    await seedChat(false);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send({
      model: "chat",
      messages: [{ role: "user", content: "bonjour" }],
    });
    expect(res.status).toBe(200);

    const dash = await api(env.app).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.activity.calls).toBe(1);
    expect(dash.body.activity.succeeded).toBe(1);
    expect(dash.body.activity.successRate).toBe(1);
  });
});

// ── [03] Slot expiré récupéré ─────────────────────────────────────────────

describe("[03] un slot expiré avec onExpire est récupéré à la 2ᵉ visite", () => {
  const request = (onExpire?: () => void): SlotRequest => ({
    service: "chat",
    provider: "p1",
    limit: 1,
    prioritaire: false,
    ...(onExpire ? { onExpire } : {}),
  });

  it("1ʳᵉ visite : onExpire appelé, place encore occupée — 2ᵉ visite : place reprise", async () => {
    process.env.SWITCHY_SLOT_WATCHDOG_MS = "1000";
    const queue = new ProviderSlotQueue(() => 1);
    let expires = 0;
    const slot = await queue.acquire(request(() => (expires += 1)));
    const future = Date.now() + 60_000;

    const first = queue.forceReleaseStale(future);
    expect(first).toEqual([slot]);
    expect(expires).toBe(1);
    expect(queue.getStats().active).toBe(1); // l'appel est interrompu, pas encore terminé

    const second = queue.forceReleaseStale(future);
    expect(second).toEqual([slot]);
    expect(expires).toBe(1); // onExpire n'est PAS rejoué
    expect(queue.getStats().active).toBe(0); // la place est RENDUE

    // L'appel orphelin finira par libérer : no-op idempotent.
    queue.release(slot);
    expect(queue.getStats().active).toBe(0);

    // La place est réellement réutilisable.
    const again = await queue.acquire(request());
    expect(typeof again).toBe("string");
  });

  it("la place reprise est drainée vers un appel en attente", async () => {
    process.env.SWITCHY_SLOT_WATCHDOG_MS = "1000";
    const queue = new ProviderSlotQueue(() => 1);
    const slot = await queue.acquire(request(() => {}));
    const future = Date.now() + 60_000;
    const pending = queue.acquire(request());

    queue.forceReleaseStale(future); // 1ʳᵉ visite : marque seulement
    expect(queue.getStats().queued).toBe(1);

    queue.forceReleaseStale(future); // 2ᵉ visite : récupère + draine
    const queuedSlot = await pending;
    expect(typeof queuedSlot).toBe("string");
    expect(queue.getStats().active).toBe(1);
    queue.release(queuedSlot);
    queue.release(slot);
  });
});

// ── [04] Découverte : timeout ─────────────────────────────────────────────

describe("[04] la découverte de modèles porte un signal d'abandon", () => {
  it("le fetch de découverte reçoit un AbortSignal (timeout court)", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ data: [{ id: "gpt-x" }] }));

    const res = await api(env.app).get("/api/providers/p1/models");
    expect(res.status).toBe(200);
    expect(mock.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("un timeout fournisseur → 504 PROVIDER_TIMEOUT (jamais une exception brute)", async () => {
    await seedChat();
    mock = installMockFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const res = await api(env.app).get("/api/providers/p1/models");
    expect(res.status).toBe(504);
    expect(res.body.code).toBe("PROVIDER_TIMEOUT");
  });
});

// ── [05] Tokens de réflexion ──────────────────────────────────────────────

describe("[05] tokens de réflexion : détail prioritaire, à-plat en second recours", () => {
  it("`reasoning_tokens` à plat est pris quand le détail est absent", () => {
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 7 })).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      reasoningTokens: 7,
    });
  });

  it("le détail PRIME sur la valeur à plat", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 1,
        completion_tokens: 2,
        reasoning_tokens: 99,
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toMatchObject({ reasoningTokens: 5 });
  });

  it("détail sans `reasoning_tokens` → second recours appliqué", () => {
    expect(
      normalizeUsage({ prompt_tokens: 1, reasoning_tokens: 4, completion_tokens_details: {} }),
    ).toMatchObject({ reasoningTokens: 4 });
  });

  it("aucune information → champ absent (« — » à l'écran)", () => {
    expect(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 })).toEqual({ promptTokens: 1, completionTokens: 2 });
  });
});

// ── [10] Réponse illisible ────────────────────────────────────────────────

describe("[10] une réponse non-JSON est une erreur, pas une liste vide", () => {
  it("200 avec une page HTML → 502 PROVIDER_BAD_RESPONSE", async () => {
    await seedChat();
    mock = installMockFetch(
      () => new Response("<html><body>portail captif</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const res = await api(env.app).get("/api/providers/p1/models");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PROVIDER_BAD_RESPONSE");
  });

  it("corps VIDE toléré (200 sans corps → liste vide, pas une erreur)", async () => {
    await seedChat();
    mock = installMockFetch(() => new Response("", { status: 200 }));

    const res = await api(env.app).get("/api/providers/p1/models");
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("JSON valide → aucune régression", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ data: [{ id: "gpt-x" }] }));

    const res = await api(env.app).get("/api/providers/p1/models");
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(["gpt-x"]);
  });
});

// ── [07] Cause d'une coupure de flux ──────────────────────────────────────

/** Flux SSE ouvert que rien ne termine (sauf coupure) : `content-type` SSE. */
function endlessSseResponse(init: { signal?: AbortSignal }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: début\n\n"));
      init.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {}
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatBody(): Record<string, unknown> {
  return { model: "chat", messages: [{ role: "user", content: "bonjour" }], stream: true };
}

describe("[07] une tentative interrompue porte sa CAUSE dans le journal", () => {
  it("déconnexion du CLIENT → reason: client_disconnect", async () => {
    await seedChat();
    mock = installMockFetch((_url, init) => endlessSseResponse(init));

    const server = env.app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
          },
          (res) => {
            res.once("data", () => {
              req.destroy(); // le client coupe pendant le flux
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.write(JSON.stringify(chatBody()));
        req.end();
      });
    } finally {
      server.close();
    }

    await waitFor(() => readLines().some((e) => e.result === "aborted"), 3000);
    const aborted = readLines().find((e) => e.result === "aborted");
    // Une coupure CLIENT ne dit rien du fournisseur : motif dédié, jamais vide.
    expect(aborted).toMatchObject({ result: "aborted", reason: "client_disconnect" });
  });

  it("dépassement du WATCHDOG de slot → reason: watchdog", async () => {
    // Watchdog très court : le flux restant ouvert est coupé par Switchy.
    process.env.SWITCHY_SLOT_WATCHDOG_MS = "60";
    await seedChat();
    mock = installMockFetch((_url, init) => endlessSseResponse(init));

    const server = env.app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
      });
      req.on("error", () => {});
      req.write(JSON.stringify(chatBody()));
      req.end();

      // La place est prise : on laisse passer la borne, puis on déclenche le
      // tick du watchdog (60 s en production, jamais attendu dans un test).
      await waitFor(() => llmSlots.getStats().active >= 1, 3000);
      await new Promise((resolve) => setTimeout(resolve, 120));
      llmSlots.forceReleaseStale();

      await waitFor(() => readLines().some((e) => e.result === "aborted"), 3000);
      req.destroy();
    } finally {
      server.close();
    }

    const aborted = readLines().find((e) => e.result === "aborted");
    // ⚠️ Le motif distingue la COUPE de Switchy (appel anormalement long) d'une
    // simple déconnexion : sans lui, les deux étaient indiscernables.
    expect(aborted).toMatchObject({ result: "aborted", reason: "watchdog" });
  });
});

// ── [08] Classification bornée du corps d'erreur ──────────────────────────

describe("[08] seuls les 2048 premiers octets d'un corps d'erreur sont classés", () => {
  it("un « quota » situé au-delà de 2048 octets n'est pas examiné → rate_limit", async () => {
    await seedChat(false);
    const body = `${"x".repeat(3000)} quota exceeded`;
    mock = installMockFetch(() => new Response(body, { status: 429, headers: { "content-type": "text/plain" } }));

    const res = await api(env.app).post("/v1/chat/completions").send({ model: "chat", messages: [] });
    expect(res.status).toBe(429);

    const failed = readLines().find((e) => e.result === "error");
    // Que dalle au-delà de la fenêtre : le motif reste un débit dépassé.
    expect(failed).toMatchObject({ status: 429, reason: "rate_limit" });
  });

  it("un « quota » dans la fenêtre reste détecté (aucune régression)", async () => {
    await seedChat(false);
    mock = installMockFetch(
      () => new Response('{"error":"usage limit reached"}', { status: 429, headers: { "content-type": "application/json" } }),
    );

    await api(env.app).post("/v1/chat/completions").send({ model: "chat", messages: [] });
    expect(readLines().find((e) => e.result === "error")).toMatchObject({ reason: "quota" });
  });
});

// ── [11] Clé de cache de découverte ───────────────────────────────────────

describe("[11] la découverte ne sert pas des données obtenues avec l'ANCIENNE clé", () => {
  it("rotation de la clé d'API → nouvelle découverte (et non le cache de 30 s)", async () => {
    await seedChat();
    let call = 0;
    mock = installMockFetch(() => {
      call += 1;
      return jsonResponse({ data: [{ id: call === 1 ? "modele-ancienne-cle" : "modele-nouvelle-cle" }] });
    });

    const first = await api(env.app).get("/api/providers/p1/models");
    expect(first.body.models.map((m: { id: string }) => m.id)).toEqual(["modele-ancienne-cle"]);

    // Rotation de la clé du fournisseur.
    const rotated = await api(env.app).put("/api/providers/p1").send({ apiKey: "sk-ROTATED_KEY" });
    expect(rotated.status).toBe(200);

    const second = await api(env.app).get("/api/providers/p1/models");
    expect(second.body.models.map((m: { id: string }) => m.id)).toEqual(["modele-nouvelle-cle"]);
    expect(mock.calls).toHaveLength(2);
    // ⚠️ Ni la clé ni son empreinte ne sortent de la découverte.
    expect(JSON.stringify(second.body)).not.toContain("sk-ROTATED_KEY");
  });

  it("les entrées expirées sont purgées à l'insertion (mémoire bornée)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await seedChat();
      mock = installMockFetch(() => jsonResponse({ data: [{ id: "m" }] }));

      await api(env.app).get("/api/providers/p1/models");
      expect(modelCatalogCacheSizes().models).toBe(1);

      // 30 s + 1 : l'entrée de p1 est périmée quand p2 s'insère.
      vi.setSystemTime(new Date(Date.now() + 31_000));
      await api(env.app).get("/api/providers/p2/models");
      // Sans purge, la table garderait les deux (croissance sans limite).
      expect(modelCatalogCacheSizes().models).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── [12] Journal dupliqué en mode rolling ─────────────────────────────────

describe("[12] la 2ᵉ passe du rolling ne re-journalise pas les étapes écartées", () => {
  function readLog(): Array<Record<string, unknown>> {
    return readLines();
  }
  const occupy = (provider: string): string => {
    const slot = llmSlots.tryAcquire({ service: "autre", provider, limit: 1, prioritaire: false });
    if (!slot) throw new Error(`occupy(${provider}) failed`);
    return slot;
  };

  it("un fournisseur DÉSACTIVÉ n'est journalisé qu'une fois (pas de ligne dupliquée)", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "Principal",
      type: "openai-compatible",
      baseUrl: "https://p1.example/v1",
      apiKey: "sk-P1",
      maxConcurrency: 1,
    });
    await seedProvider(env.app, {
      id: "p2",
      label: "Repli",
      type: "openai-compatible",
      baseUrl: "https://p2.example/v1",
      apiKey: "sk-P2",
      maxConcurrency: 1,
    });
    await seedProvider(env.app, {
      id: "p3",
      label: "Éteint",
      type: "openai-compatible",
      baseUrl: "https://p3.example/v1",
      apiKey: "sk-P3",
      maxConcurrency: 1,
    });
    await api(env.app).put("/api/providers/p3").send({ enabled: false });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: step("p1", "model-p1"),
      fallbacks: [step("p2", "model-p2"), step("p3", "model-p3")],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      rolling: true,
      enabled: true,
    });
    // Les deux étapes utilisables échouent (repli autorisé) : la 2ᵉ passe doit
    // donc parcourir TOUT l'ordre, y compris l'étape écartée définitivement.
    mock = installMockFetch(() => new Response('{"error":"boom"}', { status: 500 }));

    const p1Slot = occupy("p1");
    const p2Slot = occupy("p2");
    const pending = api(env.app)
      .post("/v1/chat/completions")
      .send({ model: "chat", messages: [{ role: "user", content: "bonjour" }] })
      .then((r) => r);

    await waitFor(() => readLog().filter((e) => e.reason === "saturated").length === 2, 3000);
    // 2ᵉ passe (attente) : p1 puis p2 échouent, on atteint l'étape désactivée.
    llmSlots.release(p1Slot);
    await waitFor(() => readLog().filter((e) => e.result === "error").length === 1, 3000);
    llmSlots.release(p2Slot);
    const res = await pending;
    expect(res.status).toBe(500);

    const disabledLines = readLog().filter((e) => e.error === "provider_disabled");
    // ⚠️ Une seule ligne : la 2ᵉ passe exclut l'étape écartée définitivement.
    expect(disabledLines).toHaveLength(1);
    expect(disabledLines[0]).toMatchObject({ attempt: 2, result: "skipped" });
  });
});
