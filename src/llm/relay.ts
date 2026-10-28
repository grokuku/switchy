/**
 * Relais LLM de Switchy — résolution du service nommé, chaîne principal →
 * replis, et PASS-THROUGH fidèle vers le fournisseur.
 *
 * Règles tenues par ce module :
 *   - le corps relayé est celui du client, au SEUL champ `model` (remplacé par
 *     le modèle de l'étape courante) et au champ `reasoning_effort` près :
 *     Switchy IMPOSE le niveau de réflexion du service (`step.reasoning`) et
 *     ÉCRASE la valeur éventuelle du client (Switchy = point de contrôle
 *     central). Si le service ne définit aucun niveau, le corps passe tel quel.
 *     Aucune autre transformation, aucune normalisation de format ;
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
import { preferredProvider, rememberProvider } from "./key-affinity.js";
import { isReasoningLevel, normalizeMessagesForProvider, reasoningWireValue } from "./reasoning.js";
import { llmSlots, QueueFullError, QueueTimeoutError } from "./slot-queue.js";

// ── Entrées / sorties ──

/**
 * TYPE D'API amont géré nativement par le relais.
 *
 *   - `chat`       : API « chat completions » OpenAI-compatible
 *                    (`POST {baseUrl}/chat/completions`) — historique ;
 *   - `systemone`  : API « System One » d'Ollama (`POST {baseUrl}/v1/systemone`,
 *                    voir `systemOneEndpointUrl`). Corps `{ model, state,
 *                    questions, images?, keep_alive? }` relayé TEL QUEL ; aucun
 *                    `reasoning_effort`, aucune normalisation de messages, aucun
 *                    streaming (la doc Ollama est explicite : « Returns one JSON
 *                    response; streaming, video, tools, and generation controls
 *                    are not supported »).
 *
 * Aucune conversion n'est faite d'un type vers l'autre : un appel System One
 * n'est JAMAIS transformé en appel chat, et réciproquement.
 */
export type RelayApi = "chat" | "systemone";

export interface RelayInput {
  /** Nom du service dans le catalogue. */
  serviceName: string;
  /** Corps du client (déjà parsé). Seul `model` sera remplacé. */
  body: Record<string, unknown>;
  /** En-têtes de la requête client (filtrés avant émission). */
  headers: IncomingHttpHeaders;
  /** Signal d'annulation (déconnexion du client). */
  signal?: AbortSignal;
  /** Étiquette de provenance pour le journal (mode `full`). */
  endpoint?: string;
  /**
   * NOM de la clé d'API appelante (ou `"session"` / `"inconnu"`) — journalisé
   * tel quel pour les statistiques par clé. ⚠️ Jamais un secret.
   */
  keyName?: string;
  /** Type d'API amont (défaut `chat`). Voir `RelayApi`. */
  api?: RelayApi;
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

/** Normalise un objet `usage` fournisseur (OpenAI `/v1`, Ollama natif, System One). */
export function normalizeUsage(raw: unknown): CallLogTokens | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  // System One (`{"input_tokens":332,"output_tokens":0}`) : noms snake_case
  // distincts de ceux d'OpenAI — traités au même titre, jamais devinés.
  const promptTokens =
    positiveInt(obj.prompt_tokens) ?? positiveInt(obj.prompt_eval_count) ?? positiveInt(obj.input_tokens);
  const completionTokens =
    positiveInt(obj.completion_tokens) ?? positiveInt(obj.eval_count) ?? positiveInt(obj.output_tokens);
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
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let observing = true;
  let bytes = 0;
  let usage: CallLogTokens | undefined;
  let finished = false;
  const reader = source.getReader();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const finish = (report: StreamReport): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    onFinish({ ...report, usage: report.usage ?? usage, bytes });
  };

  const stop = (reason: unknown): Promise<void> => {
    stopping = true;
    return stopPromise ??= Promise.resolve(reader.cancel(reason)).catch(() => {}).then(() => {
      finish({ aborted: true, error: undefined, usage, bytes });
    });
  };
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const abort = (): void => {
    if (finished || stopping) return;
    streamController.error(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    void stop(signal?.reason);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopping || finished) return;
        if (done) {
          controller.close();
          finish({ aborted: false, error: undefined, usage, bytes });
          return;
        }
        if (!value) return;
        controller.enqueue(value);
        bytes += value.byteLength;
        if (!observing) return;
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
      } catch (err) {
        if (stopping || finished) return;
        const aborted = isAborted() || (err instanceof Error && err.name === "AbortError");
        if (aborted) controller.close();
        else controller.error(err);
        finish({ aborted, error: aborted ? undefined : err instanceof Error ? err.message : String(err), usage, bytes });
      }
    },
    cancel(reason) {
      return stop(reason);
    },
  });
}

// ── Relais ──

function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix}`;
}

/**
 * URL de l'endpoint « System One » d'un fournisseur.
 *
 *   - `provider.systemOneUrl` renseigné → il FAIT FOI (chemin dédié) ;
 *   - sinon DÉRIVÉ de `baseUrl` : `https://ollama.com/v1` →
 *     `https://ollama.com/v1/systemone`, `http://localhost:11434` →
 *     `http://localhost:11434/v1/systemone`.
 *
 * La dérivation ne touche à rien d'autre : un fournisseur qui n'utilise pas
 * System One n'est jamais appelé par ce chemin (voir `RelayApi`).
 */
export function systemOneEndpointUrl(provider: ProviderRecord): string {
  if (provider.systemOneUrl) return provider.systemOneUrl;
  const base = provider.baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/systemone` : `${base}/v1/systemone`;
}

/** URL réellement appelée pour le type d'API demandé. */
export function upstreamUrl(provider: ProviderRecord, api: RelayApi = "chat"): string {
  return api === "systemone" ? systemOneEndpointUrl(provider) : joinUrl(provider.baseUrl, "chat/completions");
}

/**
 * Le client demande-t-il un flux SSE ?
 * ⚠️ System One ne streame JAMAIS (doc Ollama) : la réponse est un unique corps
 * JSON, même si le client a mis `stream: true`. Le relais ne trame donc pas.
 */
function wantsStream(body: Record<string, unknown>, api: RelayApi = "chat"): boolean {
  return api === "chat" && body.stream === true;
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
  /** Type d'API amont (`chat` par défaut). */
  api?: RelayApi;
  /** Nom de la clé appelante (voir `RelayInput.keyName`). */
  keyName: string | undefined;
  /**
   * Mode d'acquisition de la place : `wait` (file d'attente, historique) ou
   * `try` (mode rolling : on ne PATIENTE pas — pas de place ⇒ étape écartée).
   */
  acquireMode?: "wait" | "try";
  /** Vrai si au moins une étape a été écartée pour CHARGE avant cette tentative. */
  charge?: boolean;
  /** Vrai si cette tentative est celle du fournisseur repris par AFFINITÉ de cache. */
  affinity?: boolean;
}

type StepOutcome =
  | { ok: true; output: RelayOutput }
  | { ok: false; failure: UpstreamFailure; fallbackable: boolean }
  | { ok: false; saturated: true };

/**
 * Corps RÉELLEMENT envoyé au fournisseur. Deux régimes, JAMAIS mélangés :
 *
 *  - `api: "chat"` (défaut) : copie du corps client, `model` remplacé par celui
 *    de l'étape courante, puis le niveau de réflexion du service IMPOSÉ
 *    (`reasoning_effort`) — y compris quand il vaut `off`, qui doit sortir en
 *    `"none"` (sinon Ollama réactive la réflexion : contrôle fantôme).
 *    ⚠️ RÈGLE D'ARBITRAGE (décision utilisateur) : Switchy est le point de
 *    contrôle central, il IMPOSE toujours son niveau et ÉCRASE la valeur du
 *    client. Le corps n'est laissé intact que si le service ne définit AUCUN
 *    niveau (`step.reasoning` absent) — c'est alors le mode pass-through.
 *    Petit plus : le rôle `developer` est neutralisé pour un fournisseur Ollama
 *    (sinon HTTP 400).
 *
 *  - `api: "systemone"` : PASSTHROUGH STRICT — copie du corps client au SEUL
 *    champ `model` remplacé. `state`, `questions`, `images`, `keep_alive` sont
 *    transmis tels quels (aucune conversion vers des messages de chat). Le
 *    fournisseur refuse par 400 les contrôles de génération : on n'en ajoute
 *    donc AUCUN (`reasoning_effort` compris), et `step.reasoning` est IGNORÉ
 *    pour ce type d'API.
 */
export function buildUpstreamBody(
  body: Record<string, unknown>,
  step: ServiceStep,
  provider: ProviderRecord,
  api: RelayApi = "chat",
): Record<string, unknown> {
  if (api === "systemone") return { ...body, model: step.model };
  const out: Record<string, unknown> = { ...body, model: step.model };
  if (isReasoningLevel(step.reasoning)) {
    out.reasoning_effort = reasoningWireValue(step.reasoning, provider);
  }
  const messages = normalizeMessagesForProvider(out.messages, provider);
  if (messages) out.messages = messages;
  return out;
}

async function attemptStep(params: StepParams): Promise<StepOutcome> {
  const { service, step, attempt, callId, provider, body, headers, prioritaire, signal, endpoint, keyName } = params;
  const acquireMode = params.acquireMode ?? "wait";
  const api: RelayApi = params.api ?? "chat";
  const stream = wantsStream(body, api);
  const startedAt = Date.now();

  // Slot du seau DU FOURNISSEUR : sa `maxConcurrency` (ou le défaut global)
  // s'applique, et la priorité est INTRINSÈQUE au service (pas d'en-tête client).
  const watchdog = new AbortController();
  const attemptSignal = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  let slotKey: string | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (slotKey) llmSlots.release(slotKey);
  };

  const common = {
    callId,
    service: service.name,
    keyName,
    attempt,
    provider: provider.id,
    model: step.model,
    prioritaire,
    endpoint,
    providerType: provider.type,
    ...(params.charge ? { charge: true } : {}),
    ...(params.affinity ? { affinity: true } : {}),
  };

  try {
    const request = {
      service: service.name,
      provider: provider.id,
      limit: provider.maxConcurrency ?? getConcurrency(),
      prioritaire,
      signal: attemptSignal,
      onExpire: () => watchdog.abort(new DOMException("LLM slot watchdog expired", "AbortError")),
    };
    if (acquireMode === "try") {
      // Mode ROLLING : aucune attente. Pas de place ⇒ l'étape est ÉCARTÉE pour
      // CHARGE (motif distinct d'une erreur fournisseur : `reason: "saturated"`),
      // et la chaîne passe à l'étape suivante.
      const immediate = llmSlots.tryAcquire(request);
      if (!immediate) {
        logCall({
          ...common,
          result: "skipped",
          reason: "saturated",
          charge: true,
          durationMs: 0,
          stream,
        });
        return { ok: false, saturated: true };
      }
      slotKey = immediate;
    } else {
      slotKey = await llmSlots.acquire(request);
    }
    attemptSignal.throwIfAborted();
    const upstream = await fetch(upstreamUrl(provider, api), {
      method: "POST",
      headers: buildUpstreamHeaders(provider, headers),
      body: JSON.stringify(buildUpstreamBody(body, step, provider, api)),
      signal: attemptSignal,
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
        stream,
      });
      release();
      return {
        ok: false,
        failure: new UpstreamFailure(upstream.status, responseHeaders, errorBody),
        fallbackable,
      };
    }

    const streaming = stream || (api === "chat" && (upstream.headers.get("content-type") ?? "").includes("text/event-stream"));
    if (streaming && upstream.body) {
      const payload = instrumentStream(upstream.body, () => attemptSignal.aborted, (report) => {
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
      }, attemptSignal);
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
    if (err instanceof QueueFullError || err instanceof QueueTimeoutError) throw err;
    const aborted = attemptSignal.aborted || (err instanceof Error && err.name === "AbortError");
    logCall({
      ...common,
      result: aborted ? "aborted" : "error",
      ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err), reason: "network_error" as const }),
      durationMs: Date.now() - startedAt,
      stream,
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

/** Résultat d'une traversée de chaîne : réponse, dernier échec, étape qui a servi. */
interface ChainRun {
  /** Réponse de l'étape qui a abouti (`null` si la chaîne a échoué). */
  output: RelayOutput | null;
  /** Dernier échec rencontré (`null` en cas de succès). */
  failure: UpstreamFailure | null;
  /** Index de l'étape qui a RÉPONDU (`0` = principal) ; `-1` si aucune. */
  answeredIndex: number;
}

/**
 * Une étape est-elle ACTIVÉE ?
 *
 * Règle UNIQUE du niveau étape : seul un `false` EXPLICITE désactive. Un champ
 * absent (catalogue antérieur, étape construite à la main dans un test) vaut
 * ACTIVÉE — une étape n'est jamais éteinte par surprise.
 */
export function isStepEnabled(step: ServiceStep | null | undefined): boolean {
  return !step || step.enabled !== false;
}

/**
 * Étape sur laquelle ATTENDRE quand toutes les étapes d'un service en rolling
 * sont saturées : le fournisseur MÉMORISÉ pour la clé (cache déjà chaud, index
 * d'affinité) s'il est une étape UTILISABLE de CE service, sinon le principal
 * (`0`), sinon la première étape utilisable. `null` = aucune étape utilisable.
 * ⚠️ On ne sort JAMAIS du service : l'attente porte forcément sur une de ses étapes.
 * ⚠️ Une étape DÉSACTIVÉE n'est jamais retenue : elle ne consomme pas de place
 * et ne doit pas servir de cible d'attente.
 */
function pickWaitStep(steps: ServiceStep[], affinityIndex: number): number | null {
  const usable = (index: number): boolean => {
    if (!isStepEnabled(steps[index])) return false;
    const provider = getProvider(steps[index].providerId);
    return provider !== null && provider.enabled;
  };
  if (affinityIndex >= 0 && usable(affinityIndex)) return affinityIndex;
  for (let index = 0; index < steps.length; index++) if (usable(index)) return index;
  return null;
}

/**
 * Traverse la CHAÎNE d'un service : principal (rang 0) puis replis, dans l'ordre
 * du catalogue, en journalisant CHAQUE tentative. Ne jette pas : renvoie la
 * réponse de l'étape qui a abouti, ou le dernier échec.
 *
 * MODE ROLLING (`service.rolling === true`) — deux passes :
 *   1. PASSE SANS ATTENTE : chaque étape est tentée avec `tryAcquire`. Si son
 *      fournisseur est plein, l'étape est ÉCARTÉE (`reason: "saturated"`) sans
 *      patienter et la chaîne passe à la suivante (répartition de la charge) ;
 *   2. si TOUTES les étapes utilisables sont saturées, PASSE EN ATTENTE sur le
 *      fournisseur mémorisé pour cette clé d'API (affinité de cache), sinon sur
 *      le principal, puis, en cas d'échec, sur les étapes restantes.
 * Hors rolling, une seule passe EN ATTENTE — comportement historique inchangé.
 *
 * ÉTAPES DÉSACTIVÉES (`step.enabled === false`, bouton on/off d'une ligne) :
 * elles sont SAUTÉES sans aucun appel réseau, avec le motif PROPRE
 * `reason: "step_disabled"` (journalisé une seule fois, jamais silencieux).
 * Elles gardent leur position dans le catalogue (le libellé `principal` /
 * `repli n` suit l'ORDRE, pas l'état). Conséquences :
 *   - si le PRINCIPAL est désactivé, la chaîne démarre simplement sur la
 *     première étape activée (repli 1…) — jamais d'erreur de validation ;
 *   - si AUCUNE étape n'est activée, refus franc `503 / NO_ENABLED_STEP`
 *     AVANT tout appel fournisseur (pas de 500 opaque) ;
 *   - en rolling, une étape désactivée ne consomme aucune place et n'est
 *     jamais choisie comme cible d'attente ;
 *   - l'AFFINITÉ ignore une étape désactivée : si le fournisseur mémorisé pour
 *     la clé est éteint, on retombe sur le principal actif.
 *
 * AFFINITÉ (rolling uniquement) : le dernier fournisseur qui a répondu pour
 * cette clé passe en tête s'il est une étape ACTIVE de CE service. La place est
 * toujours vérifiée : l'affinité ne fait JAMAIS dépasser la concurrence.
 *
 * ⚠️ SOURCE DE VÉRITÉ UNIQUE : le relais de production (`relayServiceChat`) et
 * le test d'étape de l'interface (`testServiceStep`) passent tous les deux par
 * ICI — la logique fournisseur (corps, en-têtes, slots, journal) n'est jamais
 * dupliquée.
 */
async function runServiceChain(service: ServiceRecord, input: RelayInput): Promise<ChainRun> {
  const prioritaire = service.prioritaire === true;
  const steps: ServiceStep[] = [service.principal, ...service.fallbacks];
  // Identifiant commun à TOUTES les tentatives de cet appel : un repli se
  // constate en lisant le journal (mêmes `callId`) sans corrélation manuelle.
  const callId = newCallId();
  const rolling = service.rolling === true;

  // Ordre de tentative = étapes ACTIVÉES, dans l'ordre du catalogue. Les étapes
  // désactivées sont journalisées ICI, une seule fois (le second passage du
  // rolling ne les revoit donc pas) : aucun appel réseau, motif `step_disabled`.
  const catalogueOrder: number[] = [];
  for (let index = 0; index < steps.length; index++) {
    if (isStepEnabled(steps[index])) {
      catalogueOrder.push(index);
      continue;
    }
    const step = steps[index];
    logCall({
      callId,
      keyName: input.keyName,
      service: service.name,
      attempt: index,
      provider: step.providerId,
      model: step.model,
      result: "skipped",
      reason: "step_disabled",
      durationMs: 0,
      prioritaire,
      endpoint: input.endpoint,
    });
  }
  if (catalogueOrder.length === 0) {
    // AUCUNE étape activée : erreur CLAIRE et HONNÊTE, avant tout appel
    // fournisseur (ni 500 opaque, ni quota consommé).
    return {
      output: null,
      failure: new UpstreamFailure(
        503,
        {},
        jsonErrorBody(`service "${service.name}": toutes les étapes sont désactivées`, "NO_ENABLED_STEP"),
      ),
      answeredIndex: -1,
    };
  }

  // Ordre des étapes : celui du catalogue par défaut ; en rolling, le
  // fournisseur mémorisé pour la clé (affinité) passe devant s'il est une étape
  // ACTIVE de CE service. L'affinité expire au bout de 5 min (`key-affinity.ts`)
  // et ne ressuscite JAMAIS une étape désactivée.
  const affinityId = rolling ? preferredProvider(input.keyName) : null;
  const affinityCandidate =
    affinityId === null ? undefined : catalogueOrder.find((index) => steps[index].providerId === affinityId);
  const affinityIndex = affinityCandidate === undefined ? -1 : affinityCandidate;
  const affinityApplied = affinityIndex > 0; // le principal n'a rien à gagner à passer devant lui-même
  let order = affinityApplied
    ? [affinityIndex, ...catalogueOrder.filter((index) => index !== affinityIndex)]
    : catalogueOrder;

  let lastFailure: UpstreamFailure | null = null;
  let anyAttempted = false;
  let acquireMode: "wait" | "try" = rolling ? "try" : "wait";
  // Nombre d'étapes écartées pour CHARGE : sert à distinguer « bascule pour
  // charge » de « bascule pour erreur » dans le journal (tentatives suivantes).
  let loadSkips = 0;

  for (;;) {
    let usableSteps = 0;
    let saturatedSteps = 0;
    let stopped = false;

    for (const index of order) {
      const step = steps[index];
      const provider = getProvider(step.providerId);
      if (!provider || !provider.enabled) {
        // Étape impossible : journalisée (jamais silencieuse), aucun appel réseau.
        logCall({
          callId,
          keyName: input.keyName,
          service: service.name,
          attempt: index,
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
      usableSteps += 1;
      const outcome = await attemptStep({
        service,
        step,
        attempt: index,
        callId,
        provider,
        body: input.body,
        headers: input.headers,
        prioritaire,
        signal: input.signal,
        endpoint: input.endpoint,
        api: input.api ?? "chat",
        keyName: input.keyName,
        acquireMode,
        charge: loadSkips > 0,
        affinity: affinityApplied && index === affinityIndex,
      });

      if (outcome.ok) {
        // AFFINITÉ : on ne mémorise QUE ce qui a RÉPONDU (jamais un échec).
        rememberProvider(input.keyName, provider.id);
        return { output: outcome.output, failure: null, answeredIndex: index };
      }
      if ("saturated" in outcome) {
        saturatedSteps += 1;
        loadSkips += 1;
        continue;
      }
      lastFailure = outcome.failure;
      if (outcome.failure.aborted) return { output: null, failure: outcome.failure, answeredIndex: -1 };
      if (!outcome.fallbackable) {
        stopped = true;
        break;
      }
    }

    if (stopped) break;

    // TOUTES les étapes utilisables étaient saturées : on ATTEND maintenant,
    // sur le fournisseur mémorisé pour la clé (cache chaud), sinon le principal.
    const allSaturated = acquireMode === "try" && usableSteps > 0 && saturatedSteps === usableSteps;
    if (!allSaturated) break;
    const waitIndex = pickWaitStep(steps, affinityIndex);
    if (waitIndex === null) break; // aucune étape utilisable : 503 plus bas
    order = [waitIndex, ...catalogueOrder.filter((index) => index !== waitIndex)];
    acquireMode = "wait";
    lastFailure = null; // la passe d'attente repart d'un bilan vierge
  }

  if (lastFailure) return { output: null, failure: lastFailure, answeredIndex: -1 };
  return {
    output: null,
    failure: new UpstreamFailure(
      503,
      {},
      jsonErrorBody(
        anyAttempted
          ? `service "${service.name}": all steps failed`
          : `service "${service.name}": no enabled provider available`,
        "NO_PROVIDER",
      ),
    ),
    answeredIndex: -1,
  };
}

/**
 * Relaie un appel vers un service nommé : principal → replis, avec comptage
 * PAR FOURNISSEUR et journalisation de CHAQUE tentative. Le TYPE d'API est
 * donné par `input.api` (`chat` par défaut) — voir `RelayApi`.
 *
 * Jette `ApiError` (service inconnu/désactivé), `QueueFullError` /
 * `QueueTimeoutError` (429 côté route) ou `UpstreamFailure` (dernier échec à
 * relayer tel quel).
 */
export async function relayService(input: RelayInput): Promise<RelayOutput> {
  const service = getService(input.serviceName);
  if (!service) throw ApiError.notFound(`service "${input.serviceName}" not found`);
  if (!service.enabled) {
    throw new ApiError(503, "SERVICE_DISABLED", `service "${service.name}" is disabled`);
  }
  if (input.signal?.aborted) {
    throw new UpstreamFailure(499, {}, null, { aborted: true, message: "Client disconnected" });
  }

  const run = await runServiceChain(service, input);
  if (run.output) return run.output;
  throw run.failure ?? new UpstreamFailure(503, {}, jsonErrorBody("relay failed", "NO_PROVIDER"));
}

/**
 * Relaie un appel « chat completions » pour un service nommé (raccourci
 * historique de `relayService` en `api: "chat"`).
 */
export async function relayServiceChat(input: RelayInput): Promise<RelayOutput> {
  return relayService({ ...input, api: "chat" });
}

// ── Test d'UNE étape (interface « Tester », diagnostic de configuration) ──

/**
 * Délai maximal d'un test manuel d'étape. Court à dessein : c'est du QUOTA
 * utilisateur, pas une requête de production — mieux vaut un « délai dépassé »
 * franc qu'un bouton qui tourne indéfiniment.
 */
export const TEST_TIMEOUT_MS = 30_000;

/** Délai minimal accepté (protège d'un `timeoutMs: 1` qui ne testerait rien). */
export const TEST_MIN_TIMEOUT_MS = 1_000;

/** Plafond du texte renvoyé à l'interface (le reste est tronqué, pas perdu). */
const MAX_TEST_TEXT_CHARS = 4_000;

/** Jetons d'un test (champs `null` = le fournisseur ne les expose pas). */
export interface StepTestTokens {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
}

/** Échec STRUCTURÉ d'un test : jamais un 500 opaque, jamais un corps amont brut. */
export interface StepTestError {
  /** Code stable et catégorisé (voir `StepTestResult.error`). */
  code: string;
  /** Motif court (`CallReason`, `provider_disabled`, `provider_missing`, `timeout`, `busy`…). */
  reason: string;
  /** Message lisible en FRANÇAIS, sans secret, sans URL de fournisseur, sans JSON brut. */
  message: string;
}

/** Réponse du test d'étape — forme STABLE consommée par l'interface. */
export interface StepTestResult {
  ok: boolean;
  /** Code HTTP amont (`0` quand aucun appel n'a eu lieu). */
  status: number;
  /** Index de l'étape réellement testée / utilisée (`0` = principal). */
  stepIndex: number;
  providerId: string;
  model: string;
  reasoning: string | null;
  latencyMs: number;
  tokens: StepTestTokens;
  text?: string;
  error?: StepTestError;
  /** Vrai si un repli a répondu (chaîne complète uniquement, jamais en test ciblé). */
  fellBack: boolean;
}

export interface StepTestInput {
  serviceName: string;
  /** Corps « chat completions » minimal déjà construit par l'appelant. */
  body: Record<string, unknown>;
  /** `undefined` = chaîne complète (replis compris) ; sinon index ABSOLU d'étape. */
  stepIndex?: number;
  headers?: IncomingHttpHeaders;
  timeoutMs?: number;
  keyName?: string;
  endpoint?: string;
}

const EMPTY_TOKENS: StepTestTokens = { prompt: null, completion: null, reasoning: null };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Texte d'une réponse OpenAI-compatible (ou native Ollama) ; `undefined` si absent. */
function extractResponseText(payload: Record<string, unknown>): string | undefined {
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = asObject(asObject(choices[0])?.message);
    const content = message?.content;
    if (typeof content === "string" && content !== "") return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          const obj = asObject(part);
          return obj && typeof obj.text === "string" ? obj.text : "";
        })
        .join("");
      if (parts !== "") return parts;
    }
  }
  // API NATIVE Ollama : `/api/chat` renvoie `{ message: { content } }`.
  const ollamaMessage = asObject(payload.message);
  if (ollamaMessage && typeof ollamaMessage.content === "string" && ollamaMessage.content !== "") {
    return ollamaMessage.content;
  }
  if (typeof payload.response === "string" && payload.response !== "") return payload.response;
  return undefined;
}

/** Découpe une réponse complète en `{ text, tokens }` (jamais d'exception). */
function readTestPayload(payload: Buffer | null): { text: string | undefined; tokens: StepTestTokens } {
  if (!payload) return { text: undefined, tokens: EMPTY_TOKENS };
  try {
    const obj = asObject(JSON.parse(payload.toString("utf-8")));
    if (!obj) return { text: undefined, tokens: EMPTY_TOKENS };
    const usage = normalizeUsage(obj.usage);
    const text = extractResponseText(obj);
    return {
      text: text === undefined ? undefined : text.length > MAX_TEST_TEXT_CHARS ? `${text.slice(0, MAX_TEST_TEXT_CHARS)}…` : text,
      tokens: {
        prompt: usage?.promptTokens ?? null,
        completion: usage?.completionTokens ?? null,
        reasoning: usage?.reasoningTokens ?? null,
      },
    };
  } catch {
    return { text: undefined, tokens: EMPTY_TOKENS };
  }
}

/** Message FRANÇAIS d'un échec fournisseur — code HTTP + motif, jamais un corps brut. */
function upstreamErrorMessage(status: number, reason: string): string {
  const motifs: Record<string, string> = {
    auth_error: "clé du fournisseur refusée",
    quota: "quota épuisé chez le fournisseur",
    rate_limit: "débit dépassé (trop de requêtes)",
    overloaded: "fournisseur momentanément indisponible",
    network_error: "fournisseur injoignable (réseau)",
    upstream_error: "le fournisseur a refusé la requête",
  };
  const motif = motifs[reason] ?? motifs.upstream_error;
  return status > 0 ? `HTTP ${status} — ${motif}` : motif;
}

/**
 * Teste UNE étape (ou la chaîne complète) d'un service et renvoie un résultat
 * STRUCTURÉ — jamais d'exception pour un échec fournisseur, jamais de secret ni
 * de corps amont brut dans la réponse.
 *
 *   - `stepIndex: 0` → principal SEUL (aucun repli : on teste ce qu'on croit) ;
 *   - `stepIndex: n` → repli n-1 SEUL ;
 *   - `stepIndex` absent → CHAÎNE COMPLÈTE (comportement de production, replis
 *     compris) — `fellBack` dit alors si un repli a répondu.
 *
 * ÉTAPE DÉSACTIVÉE (`step.enabled === false`) : DÉCISION — on REFUSE de la
 * tester (résultat structuré `ok: false`, `error.code = "step_disabled"`,
 * `status: 0`). Aucun appel fournisseur, aucun quota consommé, et le message
 * dit comment procéder (« réactivez-la pour la tester »). Un « test forcé » a
 * été écarté : il afficherait un ✅ sur une étape qui ne sert aucun appel réel.
 * En revanche, le test de la CHAÎNE COMPLÈTE (index absent) SAUTE les étapes
 * éteintes — c'est exactement ce que fait la production, donc ce qu'on veut
 * vérifier.
 *
 * L'appel est journalisé normalement (il compte dans les statistiques).
 * Un service DÉSACTIVÉ reste testable : c'est un diagnostic de configuration,
 * pas une mise en service.
 */
export async function testServiceStep(input: StepTestInput): Promise<StepTestResult> {
  const service = getService(input.serviceName);
  if (!service) throw ApiError.notFound(`service "${input.serviceName}" not found`);

  const steps: ServiceStep[] = [service.principal, ...service.fallbacks];
  const index = input.stepIndex;
  if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= steps.length)) {
    throw ApiError.validation([`stepIndex: doit être un entier entre 0 et ${steps.length - 1}`]);
  }

  const timeoutMs = Math.max(
    TEST_MIN_TIMEOUT_MS,
    Math.min(60_000, Number.isFinite(input.timeoutMs) ? Math.floor(input.timeoutMs as number) : TEST_TIMEOUT_MS),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Switchy step test timeout", "TimeoutError"));
  }, timeoutMs);
  (timer as { unref?: () => void })?.unref?.();

  // Corps minimal : jamais de streaming (on veut un corps complet à lire).
  const body: Record<string, unknown> = { ...input.body, stream: false };
  const startedAt = Date.now();
  const base = (step: ServiceStep, stepIndex: number): StepTestResult => ({
    ok: false,
    status: 0,
    stepIndex,
    providerId: step.providerId,
    model: step.model,
    reasoning: step.reasoning ?? null,
    latencyMs: 0,
    tokens: EMPTY_TOKENS,
    fellBack: false,
  });

  try {
    return await runTest(service, steps, index, body, base, {
      input,
      signal: controller.signal,
      startedAt,
      timeoutMs,
    });
  } catch (err) {
    // File pleine / attente expirée : un diagnostic honnête, pas un 500.
    const busy = err instanceof QueueFullError || err instanceof QueueTimeoutError;
    const step = steps[index ?? 0];
    const result = base(step, index ?? 0);
    result.latencyMs = Date.now() - startedAt;
    result.error = {
      code: busy ? "busy" : "internal_error",
      reason: busy ? "busy" : "upstream_error",
      message: busy
        ? "le fournisseur est saturé (file d'attente pleine) — réessayez"
        : `échec inattendu du relais : ${err instanceof Error ? err.message : String(err)}`,
    };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Cœur de `testServiceStep` (étape ciblée ou chaîne complète). */
async function runTest(
  service: ServiceRecord,
  steps: ServiceStep[],
  index: number | undefined,
  body: Record<string, unknown>,
  base: (step: ServiceStep, stepIndex: number) => StepTestResult,
  ctx: { input: StepTestInput; signal: AbortSignal; startedAt: number; timeoutMs: number },
): Promise<StepTestResult> {
  const { input, signal, startedAt, timeoutMs } = ctx;
  const elapsed = (): number => Date.now() - startedAt;

  // ── Chaîne COMPLÈTE (comportement de production, replis compris) ──
  if (index === undefined) {
    const run = await runServiceChain(service, {
      serviceName: service.name,
      body,
      headers: input.headers ?? {},
      signal,
      keyName: input.keyName,
      endpoint: input.endpoint ?? "test",
    });
    const answered = run.output ? steps[run.answeredIndex] : undefined;
    const usedStep = answered ?? steps[0];
    const result = base(usedStep, run.output ? run.answeredIndex : 0);
    result.latencyMs = elapsed();
    result.fellBack = run.output !== null && run.answeredIndex > 0;
    if (run.output) {
      const payload = Buffer.isBuffer(run.output.payload) ? run.output.payload : null;
      const parsed = readTestPayload(payload);
      result.ok = true;
      result.status = run.output.status;
      result.tokens = parsed.tokens;
      if (parsed.text !== undefined) result.text = parsed.text;
      return result;
    }
    Object.assign(result, failureToTestError(run.failure, signal, timeoutMs, elapsed()));
    return result;
  }

  // ── Étape CIBLÉE : un seul fournisseur, AUCUN repli ──
  const step = steps[index];
  const result = base(step, index);
  if (!isStepEnabled(step)) {
    // Refus EXPLICITE : on ne teste pas une étape éteinte (voir la doc de
    // `testServiceStep`). Aucun appel réseau, donc aucun quota consommé.
    result.latencyMs = elapsed();
    result.error = {
      code: "step_disabled",
      reason: "step_disabled",
      message: `étape ${index === 0 ? "principale" : `de repli ${index}`} désactivée : aucun appel n'a été tenté — réactivez-la pour la tester`,
    };
    return result;
  }
  const provider = getProvider(step.providerId);
  if (!provider || !provider.enabled) {
    result.latencyMs = elapsed();
    result.error = {
      code: provider ? "provider_disabled" : "provider_missing",
      reason: provider ? "provider_disabled" : "provider_missing",
      message: provider
        ? `fournisseur « ${step.providerId} » désactivé : aucun appel n'a été tenté`
        : `fournisseur « ${step.providerId} » absent du catalogue : aucun appel n'a été tenté`,
    };
    return result;
  }

  const outcome = await attemptStep({
    service,
    step,
    attempt: index,
    callId: newCallId(),
    provider,
    body,
    headers: input.headers ?? {},
    prioritaire: service.prioritaire === true,
    signal,
    endpoint: input.endpoint ?? "test",
    keyName: input.keyName,
  });
  result.latencyMs = elapsed();
  if (!outcome.ok) {
    // Le test ciblé emploie `acquireMode: "wait"` : « saturated » y est
    // inatteignable, mais le type l'autorise — on ne fabrique jamais un échec nul.
    const failure = "saturated" in outcome ? null : outcome.failure;
    Object.assign(result, failureToTestError(failure, signal, timeoutMs, result.latencyMs));
    return result;
  }
  const payload = Buffer.isBuffer(outcome.output.payload) ? outcome.output.payload : null;
  const parsed = readTestPayload(payload);
  result.ok = true;
  result.status = outcome.output.status;
  result.tokens = parsed.tokens;
  if (parsed.text !== undefined) result.text = parsed.text;
  return result;
}

/** Traduit un `UpstreamFailure` en échec STRUCTURÉ (délai dépassé distingué du reste). */
function failureToTestError(
  failure: UpstreamFailure | null,
  signal: AbortSignal,
  timeoutMs: number,
  latencyMs: number,
): Partial<StepTestResult> {
  if (signal.aborted) {
    return {
      ok: false,
      status: 0,
      latencyMs,
      error: {
        code: "timeout",
        reason: "timeout",
        message: `délai de ${Math.round(timeoutMs / 1000)} s dépassé — le fournisseur n'a pas répondu à temps`,
      },
    };
  }
  if (!failure) {
    return {
      ok: false,
      status: 0,
      latencyMs,
      error: { code: "upstream_error", reason: "upstream_error", message: "aucune réponse du fournisseur" },
    };
  }
  const status = failure.status;
  const bodyText = failure.body ? failure.body.toString("utf-8") : "";
  const reason = classifyReason(status === 0 ? undefined : status, bodyText);
  return {
    ok: false,
    status,
    latencyMs,
    error: {
      code: "upstream_error",
      reason,
      message: upstreamErrorMessage(status, reason),
    },
  };
}

/** Erreurs attendues du relais, à convertir en réponse HTTP par la route. */
export { QueueFullError, QueueTimeoutError };
