/**
 * Routes de relais LLM — le cœur de Switchy.
 *
 * Deux points d'entrée équivalents (même handler, même fidélité) :
 *
 *   POST /api/llm/:service       → nom de service dans l'URL (canonique)
 *   POST /v1/chat/completions    → compatible OpenAI, `model` = nom du service
 *   GET  /v1/models              → liste des services ACTIVÉS au format OpenAI
 *   GET  /v1/models/:id          → détail d'un service (`id` = nom du service)
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
import { listOpenAiModels, getOpenAiModel } from "../llm/openai-models.js";
import { getService } from "../catalog-store.js";
import { getPanelSsePingMs } from "../config.js";
import { ApiError, errorBody } from "../utils/api-error.js";
import { requestKeyName } from "../middleware/api-auth.js";
import { beginCall, endCall } from "../llm/inflight-by-key.js";

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
    res.once("close", () => nodeStream.destroy());
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    nodeStream.pipe(res);
    return;
  }
  res.send(out.payload);
}

/** Type MIME du flux synthétique du panel (identique à un vrai SSE de chat). */
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/**
 * Ouvre un flux SSE SYNTHÉTIQUE pour un service en mode PANEL (§4).
 *
 * Pourquoi : un panel ne peut pas streamer (il lui faut les 3 propositions
 * complètes, puis le juge). Sans cela, un client qui a demandé `stream: true`
 * attendrait jusqu'à 150 s sans le moindre octet, et un proxy couperait. On
 * ouvre donc les en-têtes TOUT DE SUITE et on émet un commentaire SSE `: ping`
 * toutes les `SWITCHY_PANEL_SSE_PING_MS` (15 s) — le contenu, lui, part d'un
 * bloc à la fin.
 *
 * Retourne la fonction d'arrêt du battement (à appeler dans un `finally`).
 */
function openPanelSse(res: Response): () => void {
  res.status(200);
  res.setHeader("content-type", SSE_CONTENT_TYPE);
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  // Posé AVANT l'envoi des en-têtes (ensuite c'est trop tard) : il annonce un
  // flux issu d'un panel, sans prétendre savoir si le juge répondra.
  res.setHeader("x-switchy-panel", "panel");
  res.flushHeaders();
  const pingMs = getPanelSsePingMs();
  if (pingMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": ping\n\n");
  }, pingMs);
  (timer as { unref?: () => void })?.unref?.();
  return () => clearInterval(timer);
}

/** Événements SSE d'une réponse complète servie d'un bloc (panel ou repli). */
function sseChunks(model: string, text: string): string {
  const created = Math.floor(Date.now() / 1000);
  const base = { id: `switchy-panel-${Date.now()}`, object: "chat.completion.chunk", created, model };
  const content = JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  const stop = JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  return `data: ${content}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`;
}

/** Texte d'un corps JSON de réponse (repli de chaîne non streamée) ; `""` si absent. */
function textFromJsonPayload(payload: Buffer): string {
  try {
    const parsed = JSON.parse(payload.toString("utf-8")) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
    }
    return "";
  } catch {
    return "";
  }
}

async function handleRelay(req: Request, res: Response, serviceName: string, endpoint: string): Promise<void> {
  // Déconnexion du client → interruption de l'appel amont et libération du slot.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  // Compteur d'appels EN VOL par clé (nom de clé, jamais un secret) : la
  // mesure est distincte des places par fournisseur (slot-queue). Le décrément
  // est garanti par le `finally` — succès, erreur, annulation, fermeture.
  const keyName = requestKeyName(req);
  beginCall(keyName);
  let streaming = false;
  let counted = false;

  // SSE SYNTHÉTIQUE : un service en mode PANEL qui reçoit `stream: true` ne
  // pourra rien émettre avant la fin. On ouvre le flux AVANT l'appel pour
  // tenir la connexion (battement `: ping`) et pour que l'échec éventuel
  // s'exprime en SSE, pas en JSON sur un flux déjà commencé.
  const requestBody = bodyRecord(req.body);
  const panelService = getService(serviceName);
  const panelSse =
    requestBody.stream === true && panelService?.enabled === true && panelService.panel !== undefined;
  let closeSse: (() => void) | undefined = panelSse ? openPanelSse(res) : undefined;
  const finishCount = (): void => {
    if (counted) return;
    counted = true;
    endCall(keyName);
  };

  try {
    const out = await relayServiceChat({
      serviceName,
      body: bodyRecord(req.body),
      headers: req.headers,
      signal: controller.signal,
      endpoint,
      keyName,
    });
    streaming = out.streaming === true;
    if (!closeSse) {
      sendRelay(res, out);
    } else if (out.panel) {
      // Réponse du panel (juge ou proposition dégradée) : un bloc, puis [DONE].
      // `x-switchy-panel` est déjà annoncé (`panel`) : les en-têtes sont partis.
      res.write(sseChunks(serviceName, out.panel.text));
      res.end();
      streaming = false;
    } else if (out.streaming && out.payload instanceof ReadableStream) {
      // Repli sur la chaîne : le flux amont est DÉJÀ du SSE, on le relaie tel quel.
      const nodeStream = Readable.fromWeb(out.payload as unknown as WebReadableStream<Uint8Array>);
      res.once("close", () => nodeStream.destroy());
      nodeStream.on("error", () => {
        if (!res.writableEnded) res.destroy();
      });
      nodeStream.pipe(res);
    } else {
      const text = Buffer.isBuffer(out.payload) ? textFromJsonPayload(out.payload) : "";
      res.write(sseChunks(serviceName, text));
      res.end();
      streaming = false;
    }
  } catch (err) {
    // Flux SSE déjà ouvert : l'échec doit s'exprimer EN SSE (les en-têtes sont
    // partis, un `res.status().json()` lèverait ERR_HTTP_HEADERS_SENT).
    if (closeSse) {
      if (err instanceof UpstreamFailure && err.aborted) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      const detail =
        err instanceof UpstreamFailure && err.body
          ? err.body.toString("utf-8")
          : JSON.stringify(errorBody(err).body);
      if (!res.writableEnded) {
        res.write(`data: ${detail}\n\ndata: [DONE]\n\n`);
        res.end();
      }
      return;
    }
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
    closeSse?.();
    closeSse = undefined;
    // Flux SSE : l'appel reste « en vol » jusqu'à la fin de la réponse.
    if (streaming && !res.writableFinished) {
      res.once("finish", finishCount);
      res.once("close", finishCount);
    } else {
      finishCount();
    }
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

// ── GET /v1/models — services ACTIVÉS au format OpenAI ──
// Un SERVICE est le « modèle » du client : son nom est exactement ce qu'il met
// dans `body.model` de POST /v1/chat/completions. Seuls les services `enabled`
// sont exposés ; aucune clé, aucun baseUrl, aucun identifiant de fournisseur.

openaiRouter.get("/models", (_req: Request, res: Response) => {
  res.json(listOpenAiModels());
});

// ── GET /v1/models/:id — détail d'un service (`id` = nom du service) ──
// 404 JSON propre si le service n'existe pas OU s'il est désactivé (même
// réponse dans les deux cas : un client n'a pas à distinguer les deux).

openaiRouter.get("/models/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const model = getOpenAiModel(id);
  if (!model) {
    const { status, body } = errorBody(ApiError.notFound(`model: unknown or disabled service "${id}"`));
    res.status(status).json(body);
    return;
  }
  res.json(model);
});

export { llmRouter, openaiRouter };
export default llmRouter;
