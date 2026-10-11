/**
 * Routes de relais LLM — le cœur de Switchy.
 *
 * Deux points d'entrée équivalents (même handler, même fidélité) :
 *
 *   POST /api/llm/:service       → nom de service dans l'URL (canonique)
 *   POST /v1/chat/completions    → compatible OpenAI, `model` = nom du service
 *
 * Les deux relaient le corps du client tel quel (seul `model` est remplacé par
 * le modèle de l'étape choisie dans le catalogue) vers le fournisseur du
 * principal, puis vers les replis en cas d'échec. Streaming SSE non tamponné,
 * tool-calling et canaux de réflexion passés tels quels, codes d'erreur du
 * fournisseur relayés tels quels.
 *
 * Concurrence : PAR FOURNISSEUR (`ProviderRecord.maxConcurrency`, sinon le
 * défaut global `SWITCHY_CONCURRENCY`). La priorité de file est INTRINSÈQUE au
 * service (`ServiceRecord.prioritaire`) : le client n'a AUCUN en-tête à envoyer.
 * Réponses de saturation : 429 + `Retry-After` (file pleine ou attente expirée).
 */
import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { relayServiceChat, UpstreamFailure, QueueFullError, QueueTimeoutError, type RelayOutput } from "../llm/relay.js";
import { ApiError, errorBody } from "../utils/api-error.js";

/** Estimation Retry-After (ms) quand la file d'attente est saturée. */
const RETRY_AFTER_FALLBACK_MS = 5000;

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Écrit la réponse du fournisseur telle quelle (flux ou corps complet). */
function sendRelay(res: Response, out: RelayOutput): void {
  res.status(out.status);
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  if (out.streaming && out.payload instanceof ReadableStream) {
    res.setHeader("x-accel-buffering", "no"); // jamais de tampon côté proxy
    res.flushHeaders();
    const nodeStream = Readable.fromWeb(out.payload as unknown as WebReadableStream<Uint8Array>);
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    nodeStream.pipe(res);
    return;
  }
  res.send(out.payload);
}

async function handleRelay(req: Request, res: Response, serviceName: string, endpoint: string): Promise<void> {
  // Déconnexion du client → interruption de l'appel amont et libération du slot.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const out = await relayServiceChat({
      serviceName,
      body: bodyRecord(req.body),
      headers: req.headers,
      signal: controller.signal,
      endpoint,
    });
    sendRelay(res, out);
  } catch (err) {
    if (err instanceof UpstreamFailure) {
      if (err.aborted) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      res.status(err.status);
      for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
      if (err.body) {
        res.send(err.body);
      } else {
        res.json({ error: err.message, code: "UPSTREAM_ERROR" });
      }
      return;
    }
    if (err instanceof QueueFullError || err instanceof QueueTimeoutError) {
      const retryAfterMs = err instanceof QueueFullError ? err.retryAfterMs : RETRY_AFTER_FALLBACK_MS;
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({
        error: err.message,
        code: err instanceof QueueFullError ? "QUEUE_FULL" : "QUEUE_TIMEOUT",
        retryAfterMs,
      });
      return;
    }
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
}

// ── POST /api/llm/:service — nom de service dans l'URL (canonique) ──

const llmRouter = Router();

llmRouter.post("/:service", (req: Request, res: Response) => {
  void handleRelay(req, res, String(req.params.service), "POST /api/llm/:service");
});

// ── POST /v1/chat/completions — compatible OpenAI (`model` = nom du service) ──

const openaiRouter = Router();

openaiRouter.post("/chat/completions", (req: Request, res: Response) => {
  const body = bodyRecord(req.body);
  const model = body.model;
  if (typeof model !== "string" || model.trim() === "") {
    const { status, body: error } = errorBody(
      new ApiError(400, "VALIDATION_ERROR", 'model: required, must be the name of a Switchy service', [
        "model: required — POST /v1/chat/completions expects the name of a service of the Switchy catalog",
      ]),
    );
    res.status(status).json(error);
    return;
  }
  void handleRelay(req, res, model.trim(), "POST /v1/chat/completions");
});

export { llmRouter, openaiRouter };
export default llmRouter;
