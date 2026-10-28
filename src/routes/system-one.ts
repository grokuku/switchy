/**
 * Route de l'API « System One » — second type d'API de la passerelle, géré
 * NATIVEMENT (voir `src/llm/system-one.ts` pour le contrat vérifié).
 *
 * Deux points d'entrée, même handler, même fidélité :
 *
 *   POST /api/system/:service   → nom de service dans l'URL (canonique, comme
 *                                 `/api/llm/:service` pour le chat) ;
 *   POST /v1/systemone          → CHEMIN DU FOURNISSEUR lui-même (`model` = nom
 *                                 du service). Un client qui pointe son `baseUrl`
 *                                 sur Switchy appelle donc `/v1/systemone`
 *                                 exactement comme il appellerait ollama.com —
 *                                 aucun code client spécifique à Switchy.
 *
 * Le corps (`model` / `state` / `questions`, plus `images` / `keep_alive`
 * éventuels) est relayé TEL QUEL : seul `model` est remplacé par le modèle réel
 * de l'étape du service. Aucune conversion vers un format chat, à l'aller comme
 * au retour.
 *
 * Réutilise intégralement l'infrastructure du relais chat : concurrence PAR
 * FOURNISSEUR (`slot-queue`), journal d'appels (`calls-log`, jamais le `state`
 * ni les `questions`), replis et motifs catégorisés, affinité de cache, mode
 * rolling, authentification de Switchy et `keyName`. Les compteurs du tableau de
 * bord (service / fournisseur / clé / durée / statut / tokens) fonctionnent donc
 * sans aucune adaptation.
 *
 * ⚠️ PAS de streaming : la doc Ollama est explicite (« Returns one JSON
 * response; streaming, video, tools, and generation controls are not
 * supported »). La réponse du fournisseur est relayée en un seul corps JSON.
 */
import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { relaySystemOne } from "../llm/system-one.js";
import {
  QueueFullError,
  QueueTimeoutError,
  UpstreamFailure,
  type RelayOutput,
} from "../llm/relay.js";
import { ApiError, errorBody } from "../utils/api-error.js";
import { requestKeyName } from "../middleware/api-auth.js";
import { beginCall, endCall } from "../llm/inflight-by-key.js";

/** Estimation Retry-After (ms) quand la file d'attente est saturée. */
const RETRY_AFTER_FALLBACK_MS = 5000;

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Écrit la réponse du fournisseur telle quelle (System One n'est pas streamé). */
function sendRelay(res: Response, out: RelayOutput): void {
  res.status(out.status);
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  if (out.streaming && out.payload instanceof ReadableStream) {
    // Chemin théorique : la doc exclut le streaming, mais si un fournisseur en
    // émettait un, il serait relayé sans tampon plutôt que cassé.
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    const nodeStream = Readable.fromWeb(out.payload as unknown as WebReadableStream<Uint8Array>);
    res.once("close", () => nodeStream.destroy());
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    nodeStream.pipe(res);
    return;
  }
  res.send(out.payload);
}

/**
 * Handler commun aux deux points d'entrée.
 * `serviceName` vient de l'URL ou de `body.model` ; `endpoint` n'est qu'une
 * étiquette de provenance pour le journal (mode `full`).
 */
async function handleSystemOne(req: Request, res: Response, serviceName: string, endpoint: string): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const keyName = requestKeyName(req);
  beginCall(keyName);
  let streaming = false;
  let counted = false;
  const finishCount = (): void => {
    if (counted) return;
    counted = true;
    endCall(keyName);
  };

  try {
    const out = await relaySystemOne({
      serviceName,
      body: bodyRecord(req.body),
      headers: req.headers,
      signal: controller.signal,
      endpoint,
      keyName,
    });
    streaming = out.streaming === true;
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
  } finally {
    if (streaming && !res.writableFinished) {
      res.once("finish", finishCount);
      res.once("close", finishCount);
    } else {
      finishCount();
    }
  }
}

// ── POST /api/system/:service — nom de service dans l'URL (canonique) ──

const systemOneRouter = Router();

systemOneRouter.post("/:service", (req: Request, res: Response) => {
  void handleSystemOne(req, res, String(req.params.service), "POST /api/system/:service");
});

// ── POST /v1/systemone — même chemin que le fournisseur (`model` = service) ──

const systemOneRootRouter = Router();

systemOneRootRouter.post("/", (req: Request, res: Response) => {
  const body = bodyRecord(req.body);
  const model = body.model;
  if (typeof model !== "string" || model.trim() === "") {
    const { status, body: error } = errorBody(
      new ApiError(400, "VALIDATION_ERROR", "model: required, must be the name of a Switchy service", [
        "model: required — POST /v1/systemone expects the name of a service of the Switchy catalog",
      ]),
    );
    res.status(status).json(error);
    return;
  }
  void handleSystemOne(req, res, model.trim(), "POST /v1/systemone");
});

export { systemOneRouter, systemOneRootRouter };
export default systemOneRouter;
