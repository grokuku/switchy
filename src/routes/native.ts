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
import { filterResponseHeaders } from "../llm/relay.js";
import { ApiError, errorBody } from "../utils/api-error.js";

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
  const controller = new AbortController();
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

    const upstream = await fetch(`${base}/${rest}${query}`, {
      method: req.method,
      headers,
      body: hasRequestBody(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });

    logCall({
      service: `native:${provider.id}`,
      attempt: 0,
      provider: provider.id,
      model: "-",
      result: upstream.ok ? "ok" : "error",
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      endpoint: `${req.method} /api/native/:provider/*`,
      providerType: provider.type,
    });

    res.status(upstream.status);
    for (const [name, value] of Object.entries(filterResponseHeaders(upstream.headers))) {
      res.setHeader(name, value);
    }
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
      nodeStream.on("error", () => {
        if (!res.writableEnded) res.destroy();
      });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

export default router;
