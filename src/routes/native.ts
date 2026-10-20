/**
 * Relais de l'API NATIVE d'un fournisseur — passthrough `nativeUrl`.
 *
 * L'API native d'Ollama (`/api/tags`, `/api/show`, capacités des modèles) est
 * DISTINCTE de l'API OpenAI-compatible `/v1` : un relais qui ne relaierait que
 * `/v1` casserait la découverte des modèles côté Pi-Web. Cette route relaie
 * donc fidèlement toute méthode et tout chemin vers `nativeUrl` :
 *
 *   GET  /api/native/:providerId/api/tags
 *   POST /api/native/:providerId/api/show
 *
 * `nativeUrl` fait foi quand il est configuré ; sinon il est DÉRIVÉ de
 * `baseUrl` en retirant un suffixe `/v1` (ex. `https://ollama.com/v1` →
 * `https://ollama.com`). L'authentification est celle du FOURNISSEUR
 * (Bearer) : la clé du client ne sort jamais.
 */
import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getProvider, type ProviderRecord } from "../catalog-store.js";
import { logCall } from "../llm/calls-log.js";
import { filterResponseHeaders, instrumentStream } from "../llm/relay.js";
import { llmSlots, QueueFullError, QueueTimeoutError } from "../llm/slot-queue.js";
import { getConcurrency } from "../config.js";
import { ApiError, errorBody } from "../utils/api-error.js";
import { requestKeyName } from "../middleware/api-auth.js";
import { beginCall, endCall } from "../llm/inflight-by-key.js";

/** Base de l'API native : `nativeUrl` sinon `baseUrl` privée d'un suffixe `/v1`. */
export function nativeBaseUrl(provider: ProviderRecord): string | null {
  if (provider.nativeUrl) return provider.nativeUrl.replace(/\/+$/, "");
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) return base.slice(0, -3);
  return base;
}

function hasRequestBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

const router = Router();

// Toute méthode, tout chemin sous /api/native/:providerId/* → nativeUrl/<chemin>
router.all("/:provider/*", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const providerId = String(req.params.provider);
  // Nom de la clé appelante (jamais un secret) : journal + compteur en vol.
  const keyName = requestKeyName(req);
  beginCall(keyName);
  let counted = false;
  const finishCount = (): void => {
    if (counted) return;
    counted = true;
    endCall(keyName);
  };
  const controller = new AbortController();
  let slotKey: string | undefined;
  const release = (): void => {
    if (slotKey) llmSlots.release(slotKey);
    slotKey = undefined;
  };
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const provider = getProvider(providerId);
    if (!provider) throw ApiError.notFound(`provider "${providerId}" not found`);
    if (!provider.enabled) throw new ApiError(503, "PROVIDER_DISABLED", `provider "${providerId}" is disabled`);

    const base = nativeBaseUrl(provider);
    if (!base) throw new ApiError(503, "NO_NATIVE_URL", `provider "${providerId}": no native URL configured`);

    const rest = String((req.params as Record<string, unknown>)[0] ?? "");
    if (rest.split("/").some((segment) => segment === "..")) {
      throw ApiError.validation(["path: must not contain '..'"]);
    }
    const queryIndex = req.originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";

    const headers: Record<string, string> = { accept: req.get("accept") ?? "*/*" };
    if (hasRequestBody(req.method)) headers["content-type"] = "application/json";
    if (provider.apiKey) headers["authorization"] = `Bearer ${provider.apiKey}`;

    slotKey = await llmSlots.acquire({
      service: `native:${provider.id}`,
      provider: provider.id,
      limit: provider.maxConcurrency ?? getConcurrency(),
      prioritaire: false,
      signal: controller.signal,
      onExpire: () => controller.abort(new DOMException("LLM slot watchdog expired", "AbortError")),
    });
    controller.signal.throwIfAborted();
    const upstream = await fetch(`${base}/${rest}${query}`, {
      method: req.method,
      headers,
      body: hasRequestBody(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });

    const finish = (aborted: boolean, error?: string): void => {
      logCall({
        service: `native:${provider.id}`,
        keyName,
        attempt: 0,
        provider: provider.id,
        model: "-",
        result: aborted ? "aborted" : upstream.ok && !error ? "ok" : "error",
        ...(error ? { error, reason: "upstream_error" as const } : {}),
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        endpoint: `${req.method} /api/native/:provider/*`,
        providerType: provider.type,
      });
      release();
    };

    res.status(upstream.status);
    for (const [name, value] of Object.entries(filterResponseHeaders(upstream.headers))) {
      res.setHeader(name, value);
    }
    if (upstream.body) {
      const payload = instrumentStream(upstream.body, () => controller.signal.aborted,
        (report) => finish(report.aborted, report.error), controller.signal);
      const nodeStream = Readable.fromWeb(payload as unknown as WebReadableStream<Uint8Array>);
      res.once("close", () => nodeStream.destroy());
      nodeStream.on("error", () => {
        if (!res.writableEnded) res.destroy();
      });
      nodeStream.pipe(res);
    } else {
      finish(false);
      res.end();
    }
  } catch (err) {
    if (slotKey) {
      logCall({
        service: `native:${providerId}`, keyName, provider: providerId, model: "-", attempt: 0,
        result: controller.signal.aborted ? "aborted" : "error",
        ...(controller.signal.aborted ? {} : { reason: "network_error", error: err instanceof Error ? err.message : String(err) }),
        durationMs: Date.now() - startedAt,
      });
    }
    release();
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof QueueFullError || err instanceof QueueTimeoutError) {
      const retryAfterMs = err instanceof QueueFullError ? err.retryAfterMs : 5000;
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({ error: err.message, code: err instanceof QueueFullError ? "QUEUE_FULL" : "QUEUE_TIMEOUT", retryAfterMs });
      return;
    }
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  } finally {
    // Le décrément suit la réponse relayée (flux compris) — jamais de fuite.
    if (res.headersSent && !res.writableFinished) {
      res.once("finish", finishCount);
      res.once("close", finishCount);
    } else {
      finishCount();
    }
  }
});

export default router;
