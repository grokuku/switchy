import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/index.js";
import { resetSettingsCache } from "../src/settings-store.js";
import { resetCatalogCache } from "../src/catalog-store.js";
import { resetAuthCaches, createKey } from "../src/switchy-auth.js";
import { resetLoginRateLimitForTests } from "../src/routes/session.js";
import { resetLlmSlots } from "../src/llm/slot-queue.js";
import { resetCallsLogState } from "../src/llm/calls-log.js";

export interface TestEnv {
  app: Express;
  dir: string;
  cleanup: () => void;
}

/**
 * Clé d'API d'OUTIL utilisée par défaut dans les suites de test (fournie par
 * l'environnement `SWITCHY_API_KEY`). Elle authentifie les appels scriptés
 * comme le ferait un outil réel (Pi-Web, Yuki…). Les suites d'authentification
 * la remplacent explicitement quand c'est leur sujet.
 */
export const TEST_API_KEY = "switchy_test_tool_key_0000000000000000";

/** Requête supertest pré-authentifiée avec la clé d'outil de test. */
export function api(app: Express) {
  const withKey = (test: request.Test): request.Test => test.set("X-API-Key", TEST_API_KEY);
  return {
    get: (url: string) => withKey(request(app).get(url)),
    post: (url: string) => withKey(request(app).post(url)),
    put: (url: string) => withKey(request(app).put(url)),
    patch: (url: string) => withKey(request(app).patch(url)),
    delete: (url: string) => withKey(request(app).delete(url)),
  };
}

/**
 * Prépare un environnement de test isolé : répertoire de données temporaire,
 * variables SWITCHY_* nettoyées (les défauts du service s'appliquent), caches
 * mémo réinitialisés.
 *
 * Le socle n'émet AUCUNE requête sortante : aucun mock réseau n'est nécessaire.
 */
export function makeTestEnv(overrides: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "switchy-test-"));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SWITCHY_")) delete process.env[key];
  }
  process.env.SWITCHY_DATA_DIR = dir;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  // Clé d'outil par défaut (sauf si la suite en fournit une explicite).
  if (!("SWITCHY_API_KEY" in overrides)) process.env.SWITCHY_API_KEY = TEST_API_KEY;

  resetSettingsCache();
  resetCatalogCache();
  resetAuthCaches();
  resetLlmSlots();
  resetCallsLogState();
  // Compteur anti-force brute du login : store module, réinitialisé par test.
  void resetLoginRateLimitForTests();

  return {
    app: createApp(),
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Crée une clé d'API (outil) et renvoie son secret, à présenter ensuite en
 * en-tête (`X-API-Key` / `Authorization: Bearer`).
 *
 * ⚠️ La clé est écrite DIRECTEMENT dans le fichier de clés du répertoire de test
 * (`createKey`) : l'API n'est jamais ouverte (plus de mode amorçage), et la
 * création HTTP exigerait une session dont le mot de passe par défaut a été
 * changé. Les suites qui testent le CHEMIN HTTP le font explicitement.
 */
export async function createApiKey(_app: Express, name = "test"): Promise<string> {
  return createKey(name).secret;
}

// ── Fixtures du Lot 3 (relais LLM) ──

/** Crée un fournisseur via l'API (authentifiée comme un outil) ; lève si la validation refuse. */
export async function seedProvider(app: Express, body: Record<string, unknown>): Promise<void> {
  const res = await api(app).post("/api/providers").send(body);
  if (res.status !== 201) throw new Error(`seedProvider failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Crée un service via l'API (authentifiée comme un outil) ; lève si la validation refuse. */
export async function seedService(app: Express, body: Record<string, unknown>): Promise<void> {
  const res = await api(app).post("/api/services").send(body);
  if (res.status !== 201) throw new Error(`seedService failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Étape de service pour les fixtures. */
export function step(providerId: string, model: string) {
  return { providerId, model, reasoning: "off" };
}

// ── Mock réseau (AUCUN test ne dépend du réseau) ──

export interface MockFetchCall {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

export type MockFetchHandler = (url: string, init: MockFetchCall["init"]) => Response | Promise<Response>;

/**
 * Remplace `globalThis.fetch` le temps d'un test et enregistre les appels.
 * Toujours restaurer (`afterEach(() => mock.restore())`).
 */
export function installMockFetch(handler: MockFetchHandler): { calls: MockFetchCall[]; restore: () => void } {
  const calls: MockFetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const normalized = (init ?? {}) as MockFetchCall["init"];
    calls.push({ url, init: normalized });
    return handler(url, normalized);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Réponse JSON factice d'un fournisseur OpenAI-compatible. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

/** Réponse SSE factice (streaming morceau par morceau). */
export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream", ...(init.headers as Record<string, string> | undefined) },
  });
}

/** Attend qu'une condition devienne vraie (polling court, tests de concurrence). */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
