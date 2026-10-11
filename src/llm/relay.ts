/**
 * Relais LLM de Switchy — résolution du service nommé, chaîne principal →
 * replis, et PASS-THROUGH fidèle vers le fournisseur.
 *
 * Règles tenues par ce module :
 *   - le corps relayé est celui du client, au SEUL champ `model` près (remplacé
 *     par le modèle de l'étape courante) : aucune autre transformation, aucune
 *     normalisation de format ;
 *   - le streaming SSE est relayé CHUNK PAR CHUNK, sans tampon ; l'annulation
 *     du client interrompt l'appel amont (AbortController) et libère le slot ;
 *   - le tool-calling et les canaux de réflexion passent tels quels : Switchy
 *     ne fusionne ni ne réordonne jamais les deltas — l'application appelante
 *     reste seule responsable de séparer réflexion et contenu ;
 *   - les codes d'erreur du fournisseur sont relayés tels quels (statut et
 *     corps) quand la chaîne est épuisée ;
 *   - AUCUN retry sur un même fournisseur (le SDK Pi reprend déjà) : la seule
 *     reprise est la bascule vers l'étape suivante de la chaîne ;
 *   - chaque tentative est journalisée (succès, erreur, abandon, étape
 *     ignorée) avec son rang.
 *
 * Politique de bascule (`shouldFallback`) : on ne bascule PAS sur une erreur
 * manifeste de la requête (400, 405, 406, 413, 415, 422) — l'étape suivante
 * échouerait pareil — NI sur un échec d'AUTHENTIFICATION (401/403) : une clé
 * invalide/expirée ne deviendra pas valide chez le fournisseur suivant, et
 * basculer vers un repli PAYANT masquerait un simple problème de configuration.
 * L'échec est alors relayé tel quel et journalisé (`reason: "auth_error"`).
 * On bascule sur tout le reste : 404 (modèle propre à un fournisseur), 408/409,
 * 429 (quota ou débit), 5xx, échec réseau.
 */
import type { IncomingHttpHeaders } from "node:http";
import { getProvider, getService, type ProviderRecord, type ServiceRecord, type ServiceStep } from "../catalog-store.js";
import { getConcurrency } from "../config.js";
import { ApiError } from "../utils/api-error.js";
import { classifyReason, logCall, newCallId, type CallLogTokens } from "./calls-log.js";
import { llmSlots, QueueFullError, QueueTimeoutError } from "./slot-queue.js";

// ── Entrées / sorties ──

export interface RelayInput {
  /** Nom du service dans le catalogue. */
  serviceName: string;
  /** Corps OpenAI-compatible du client (déjà parsé). Seul `model` sera remplacé. */
  body: Record<string, unknown>;
  /** En-têtes de la requête client (filtrés avant émission). */
  headers: IncomingHttpHeaders;
  /** Signal d'annulation (déconnexion du client). */
  signal?: AbortSignal;
  /** Étiquette de provenance pour le journal (mode `full`). */
  endpoint?: string;
}

export interface RelayOutput {
  status: number;
  headers: Record<string, string>;
  /** Flux SSE (streaming) ou corps JSON complet, à relayer tel quel. */
  payload: Buffer | ReadableStream<Uint8Array>;
  streaming: boolean;
}

/** Échec terminal d'une tentative : statut/en-têtes/corps PRÊTS À RELAYER. */
export class UpstreamFailure extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
  readonly aborted: boolean;

  constructor(status: number, headers: Record<string, string>, body: Buffer | null, options: { aborted?: boolean; message?: string } = {}) {
    super(options.message ?? `Upstream request failed (${status})`);
    this.name = "UpstreamFailure";
    this.status = status;
    this.headers = headers;
    this.body = body;
    this.aborted = options.aborted === true;
  }
}

// ── En-têtes ──

/** En-têtes jamais transmis au fournisseur (hop-by-hop, longueur, auth client). */
const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
  "expect",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/** En-têtes jamais relayés au client (recalculés par Node, décodés par fetch). */
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

/**
 * En-têtes émis vers le fournisseur : ceux du client jugés utiles (tout sauf
 * hop-by-hop/auth/interne), plus l'authentification du FOURNISSEUR (Switchy
 * absorbe les clés : celle du client ne sort jamais).
 */
export function buildUpstreamHeaders(provider: ProviderRecord, clientHeaders: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-switchy")) continue; // en-têtes internes au relais
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  out["content-type"] = "application/json";
  if (provider.apiKey) {
    switch (provider.type) {
      case "anthropic":
        out["x-api-key"] = provider.apiKey;
        break;
      case "google":
        out["x-goog-api-key"] = provider.apiKey;
        break;
      default:
        out["authorization"] = `Bearer ${provider.apiKey}`;
        break;
    }
  }
  return out;
}

/** En-têtes relayés au client depuis la réponse fournisseur (fidèles, filtrés). */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value;
  });
  return out;
}

// ── Politique de bascule ──

const NON_FALLBACK_STATUSES = new Set([400, 401, 403, 405, 406, 413, 415, 422]);

/** Vrai si l'échec de l'étape justifie d'essayer l'étape suivante. */
export function shouldFallback(status: number | undefined): boolean {
  if (status === undefined) return true; // échec réseau : un autre fournisseur peut répondre
  return !NON_FALLBACK_STATUSES.has(status);
}

// ── Jetons (usage) ──

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Normalise un objet `usage` fournisseur (OpenAI `/v1` ou Ollama natif). */
export function normalizeUsage(raw: unknown): CallLogTokens | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const promptTokens = positiveInt(obj.prompt_tokens) ?? positiveInt(obj.prompt_eval_count);
  const completionTokens = positiveInt(obj.completion_tokens) ?? positiveInt(obj.eval_count);
  const totalTokens = positiveInt(obj.total_tokens);
  // Tokens de RÉFLEXION : détaillés par certains fournisseurs (OpenAI/OpenRouter/
  // DeepSeek) sous `completion_tokens_details.reasoning_tokens`. Absent = le
  // fournisseur ne les expose pas (l'interface affiche « — »).
  const details = obj.completion_tokens_details;
  const reasoningTokens =
    details && typeof details === "object" && !Array.isArray(details)
      ? positiveInt((details as Record<string, unknown>).reasoning_tokens)
      : positiveInt(obj.reasoning_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined && reasoningTokens === undefined) {
    return undefined;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function usageFromJsonPayload(text: string): CallLogTokens | undefined {
  try {
    const obj = JSON.parse(text) as { usage?: unknown };
    return normalizeUsage(obj?.usage);
  } catch {
    return undefined;
  }
}

/** Taille maximale observée par le détecteur d'usage (jamais de rétention). */
const USAGE_SNIFF_MAX_CHARS = 64 * 1024;

function usageFromSseLine(line: string): CallLogTokens | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return undefined;
  return usageFromJsonPayload(payload);
}

interface StreamReport {
  aborted: boolean;
  error: string | undefined;
  usage: CallLogTokens | undefined;
  bytes: number;
}

/**
 * Enveloppe un flux amont : chaque morceau est relayé IMMÉDIATEMENT (aucun
 * tampon), un détecteur borné extrait `usage` des lignes SSE au passage, et
 * `onFinish` est appelé une seule fois (fin normale, erreur ou annulation)
 * pour libérer le slot et journaliser.
 */
export function instrumentStream(
  source: ReadableStream<Uint8Array>,
  isAborted: () => boolean,
  onFinish: (report: StreamReport) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let observing = true;
  let bytes = 0;
  let usage: CallLogTokens | undefined;
  let finished = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const finish = (report: StreamReport): void => {
    if (finished) return;
    finished = true;
    onFinish({ ...report, usage: report.usage ?? usage, bytes });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          controller.enqueue(value); // relais immédiat — le client reçoit le morceau tel quel
          bytes += value.byteLength;
          if (!observing) continue;
          try {
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, "");
              buffer = buffer.slice(idx + 1);
              const found = usageFromSseLine(line);
              if (found) usage = found;
            }
            if (buffer.length > USAGE_SNIFF_MAX_CHARS) {
              observing = false;
              buffer = "";
            }
          } catch {
            observing = false;
            buffer = "";
          }
        }
        controller.close();
        finish({ aborted: false, error: undefined, usage, bytes });
      } catch (err) {
        const aborted = isAborted() || (err instanceof Error && err.name === "AbortError");
        if (aborted) controller.close();
        else controller.error(err);
        finish({ aborted, error: aborted ? undefined : err instanceof Error ? err.message : String(err), usage, bytes });
      }
    },
    cancel(reason) {
      finish({ aborted: true, error: undefined, usage, bytes });
      const active = reader;
      const cancelPromise = active ? active.cancel(reason) : source.cancel(reason);
      void Promise.resolve(cancelPromise).catch(() => {});
    },
  });
}

// ── Relais ──

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix}`;
}

function wantsStream(body: Record<string, unknown>): boolean {
  return body.stream === true;
}

interface StepParams {
  service: ServiceRecord;
  step: ServiceStep;
  attempt: number;
  /** Identifiant de l'appel logique (commun à toutes les tentatives). */
  callId: string;
  provider: ProviderRecord;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  prioritaire: boolean;
  signal: AbortSignal | undefined;
  endpoint: string | undefined;
}

type StepOutcome =
  | { ok: true; output: RelayOutput }
  | { ok: false; failure: UpstreamFailure; fallbackable: boolean };

async function attemptStep(params: StepParams): Promise<StepOutcome> {
  const { service, step, attempt, callId, provider, body, headers, prioritaire, signal, endpoint } = params;
  const startedAt = Date.now();

  // Slot du seau DU FOURNISSEUR : sa `maxConcurrency` (ou le défaut global)
  // s'applique, et la priorité est INTRINSÈQUE au service (pas d'en-tête client).
  const slotKey = await llmSlots.acquire({
    service: service.name,
    provider: provider.id,
    limit: provider.maxConcurrency ?? getConcurrency(),
    prioritaire,
  });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    llmSlots.release(slotKey);
  };

  const common = {
    callId,
    service: service.name,
    attempt,
    provider: provider.id,
    model: step.model,
    prioritaire,
    endpoint,
    providerType: provider.type,
  };

  try {
    const upstream = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: buildUpstreamHeaders(provider, headers),
      body: JSON.stringify({ ...body, model: step.model }),
      signal,
    });
    const responseHeaders = filterResponseHeaders(upstream.headers);

    if (!upstream.ok) {
      const errorBody = Buffer.from(await upstream.arrayBuffer());
      const fallbackable = shouldFallback(upstream.status);
      const reason = classifyReason(upstream.status, errorBody.toString("utf-8"));
      logCall({
        ...common,
        result: "error",
        status: upstream.status,
        reason,
        error: fallbackable ? "upstream_error" : reason === "auth_error" ? "upstream_auth_error" : "upstream_rejected_request",
        durationMs: Date.now() - startedAt,
        stream: wantsStream(body),
      });
      release();
      return {
        ok: false,
        failure: new UpstreamFailure(upstream.status, responseHeaders, errorBody),
        fallbackable,
      };
    }

    const streaming = wantsStream(body) || (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (streaming && upstream.body) {
      const payload = instrumentStream(upstream.body, () => signal?.aborted === true, (report) => {
        logCall({
          ...common,
          result: report.aborted ? "aborted" : report.error ? "error" : "ok",
          status: upstream.status,
          ...(report.error && !report.aborted ? { error: report.error, reason: "upstream_error" as const } : {}),
          durationMs: Date.now() - startedAt,
          tokens: report.usage,
          stream: true,
        });
        release();
      });
      return { ok: true, output: { status: upstream.status, headers: responseHeaders, payload, streaming: true } };
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const usage = usageFromJsonPayload(buffer.toString("utf-8"));
    logCall({
      ...common,
      result: "ok",
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      tokens: usage,
      stream: false,
    });
    release();
    return { ok: true, output: { status: upstream.status, headers: responseHeaders, payload: buffer, streaming: false } };
  } catch (err) {
    const aborted = signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
    logCall({
      ...common,
      result: aborted ? "aborted" : "error",
      ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err), reason: "network_error" as const }),
      durationMs: Date.now() - startedAt,
      stream: wantsStream(body),
    });
    release();
    if (aborted) {
      return {
        ok: false,
        failure: new UpstreamFailure(499, {}, null, { aborted: true, message: "Client disconnected" }),
        fallbackable: false,
      };
    }
    return { ok: false, failure: new UpstreamFailure(502, {}, null, { message: "Upstream unreachable" }), fallbackable: true };
  }
}

function jsonErrorBody(message: string, code: string): Buffer {
  return Buffer.from(JSON.stringify({ error: message, code }));
}

/**
 * Relaie un appel « chat completions » pour un service nommé :
 * principal → replis, avec comptage PAR FOURNISSEUR et journalisation de CHAQUE
 * tentative. Jette `ApiError` (service inconnu/désactivé), `QueueFullError` /
 * `QueueTimeoutError` (429 côté route) ou `UpstreamFailure` (dernier échec à
 * relayer tel quel).
 */
export async function relayServiceChat(input: RelayInput): Promise<RelayOutput> {
  const service = getService(input.serviceName);
  if (!service) throw ApiError.notFound(`service "${input.serviceName}" not found`);
  if (!service.enabled) {
    throw new ApiError(503, "SERVICE_DISABLED", `service "${service.name}" is disabled`);
  }
  if (input.signal?.aborted) {
    throw new UpstreamFailure(499, {}, null, { aborted: true, message: "Client disconnected" });
  }

  const prioritaire = service.prioritaire === true;
  const steps: ServiceStep[] = [service.principal, ...service.fallbacks];
  // Identifiant commun à TOUTES les tentatives de cet appel : un repli se
  // constate en lisant le journal (mêmes `callId`) sans corrélation manuelle.
  const callId = newCallId();

  let lastFailure: UpstreamFailure | null = null;
  let anyAttempted = false;

  for (let attempt = 0; attempt < steps.length; attempt++) {
    const step = steps[attempt];
    const provider = getProvider(step.providerId);
    if (!provider || !provider.enabled) {
      // Étape impossible : journalisée (jamais silencieuse), aucun appel réseau.
      logCall({
        callId,
        service: service.name,
        attempt,
        provider: step.providerId,
        model: step.model,
        result: "skipped",
        error: provider ? "provider_disabled" : "provider_missing",
        durationMs: 0,
        prioritaire,
        endpoint: input.endpoint,
      });
      continue;
    }

    anyAttempted = true;
    const outcome = await attemptStep({
      service,
      step,
      attempt,
      callId,
      provider,
      body: input.body,
      headers: input.headers,
      prioritaire,
      signal: input.signal,
      endpoint: input.endpoint,
    });
    if (outcome.ok) return outcome.output;
    lastFailure = outcome.failure;
    if (outcome.failure.aborted) throw outcome.failure;
    if (!outcome.fallbackable) break;
  }

  if (lastFailure) throw lastFailure;
  throw new UpstreamFailure(
    503,
    {},
    jsonErrorBody(
      anyAttempted
        ? `service "${service.name}": all steps failed`
        : `service "${service.name}": no enabled provider available`,
      "NO_PROVIDER",
    ),
  );
}

/** Erreurs attendues du relais, à convertir en réponse HTTP par la route. */
export { QueueFullError, QueueTimeoutError };
