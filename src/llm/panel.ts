/**
 * Service « PANEL » — 3 propositions en parallèle, puis 1 juge qui les
 * recompose en citant ses sources (`docs/panel-service.md`).
 *
 * Ce module ne fait AUCUNE I/O lui-même : il emprunte au relais sa mécanique
 * d'étape (`attemptStep`, exporté pour cela) — en-têtes, corps, place de
 * fournisseur, journal — et se contente d'orchestrer :
 *
 *   1. ADMISSION ANTI-FAMINE (§5) : passe immédiate `tryAcquire` A→B→C, puis
 *      passe d'attente BORNÉE AU QUORUM, puis juge admis seulement après
 *      libération de tous les membres. Le panel n'immobilise donc jamais plus de
 *      `quorum` places (2 par défaut) sur les 3 du compte fournisseur : sans
 *      cela, un panel affamerait la file pendant des minutes.
 *   2. MEMBRES : copie du corps client, `stream: false` forcé, squelette (§2)
 *      ajouté à la fin du premier `system`, `tools` du client CONSERVÉS,
 *      `model`/`reasoning_effort` imposés par l'étape (`buildUpstreamBody`).
 *   3. COLLECTE + ÉCARTEMENT : une réponse `tool_calls` n'est PAS une
 *      proposition (elle est journalisée `skipped` / `panel_tool_call_skipped`) ;
 *      le quorum se compte sur les propositions réellement utilisables.
 *   4. JUGE : corps SANS `tools`, UN SEUL `system` (prompt du juge), historique
 *      nettoyé (ni `system`, ni `tool`, ni `tool_calls`), puis le message `user`
 *      du §3.3 où les propositions manquantes valent `INDISPONIBLE`.
 *   5. RÉPONSES, dans l'ordre des décisions utilisateur figées :
 *        - quorum atteint + juge utilisable → le juge ;
 *        - juge en échec ou vide → la PREMIÈRE proposition utilisable (A→B→C) ;
 *        - quorum non atteint → la proposition utilisable servie telle quelle ;
 *        - aucune proposition → `null` : l'appelant bascule sur la chaîne
 *          normale (`principal → fallbacks`) avec le MÊME `callId`.
 *
 * ⚠️ Toute place acquise est rendue dans un `finally` (libération idempotente :
 * `attemptStep` la rend déjà sur son chemin normal). ⚠️ Une fois le signal
 * client avorté, AUCUN appel supplémentaire n'est émis (ni membre, ni juge, ni
 * chaîne : c'est `relayService` qui tranche).
 */
import { getProvider, type ServiceRecord, type ServiceStep } from "../catalog-store.js";
import { getConcurrency } from "../config.js";
import { logCall, PANEL_CONTEXT_MODEL, PANEL_CONTEXT_PROVIDER, type CallReason, type CallResult } from "./calls-log.js";
import { buildJudgeUserMessage, judgePrompt, panelSkeleton, PANEL_LABELS } from "./panel-prompts.js";
import {
  attemptStep,
  buildUpstreamBody,
  extractResponseText,
  isStepEnabled,
  type PanelResultVerdict,
  type RelayInput,
  type RelayOutput,
} from "./relay.js";
import { QueueFullError, QueueTimeoutError, llmSlots } from "./slot-queue.js";

/**
 * Rang journalisé de la CHAÎNE DE REPLI quand le panel n'a rien pu servir :
 * les membres occupent 0/1/2, le juge 3, la chaîne commence à 4. Les lignes de
 * GROUPE (`panel_degraded`, `panel_no_quorum`, `panel_all_failed`) prennent ce
 * même rang : elles constatent la fin du panel, pas une étape de plus.
 */
export const PANEL_FALLBACK_ATTEMPT = 4;

/** Rang journalisé du juge. */
export const PANEL_JUDGE_ATTEMPT = 3;

/** Réponse servie par le panel (le texte est repris tel quel par le SSE synthétique). */
export interface PanelServed {
  output: RelayOutput;
  /** Texte final (juge ou proposition servie seule). */
  text: string;
  /** Vrai si c'est le JUGE qui a produit la réponse. */
  judged: boolean;
}

export interface PanelRunRequest {
  service: ServiceRecord;
  input: RelayInput;
  /** Identifiant d'appel commun aux 4 étapes et, le cas échéant, à la chaîne. */
  callId: string;
}

// ── Petites lectures défensives du corps client ──

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Texte d'un `content` (chaîne ou liste de parties `{ type: "text", text }`). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const obj = asObject(part);
    if (obj && typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("");
}

/**
 * Conversation NETTOYÉE pour le juge (§10) : ni `system` (le sien est le seul
 * prompt du juge), ni `tool` (les appels d'outils n'ont pas été exécutés), ni
 * `tool_calls`/`tool_call_id`/`name` sur les messages conservés. Un message
 * `assistant` qui ne portait qu'un appel d'outil disparaît (contenu vide).
 */
export function cleanConversation(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    const message = asObject(item);
    if (!message) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = messageText(message.content);
    if (role === "assistant" && content.trim() === "") continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * Sépare l'historique de la DEMANDE d'origine : le dernier message `user`
 * nettoyé est « la demande du client, telle quelle » (§3.3), le reste est
 * l'historique envoyé au juge avant le message du §3.3 (jamais de doublon).
 */
export function splitJudgeConversation(raw: unknown): {
  history: Array<Record<string, unknown>>;
  request: string;
} {
  const messages = cleanConversation(raw);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return { history: messages, request: "" };
  return {
    history: messages.slice(0, lastUser),
    request: messageText(messages[lastUser].content),
  };
}

/** Vrai si la réponse est un APPEL D'OUTIL (donc pas une proposition utilisable). */
export function hasToolCall(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = asObject(choices[0]);
  if (choice && choice.finish_reason === "tool_calls") return true;
  const toolCalls = asObject(choice?.message)?.tool_calls;
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

/**
 * Ajoute le squelette (§2) à la FIN du premier `system`. S'il n'y a aucun
 * `system`, il en est créé un en tête : sans squelette imposé, les propositions
 * ne seraient pas comparables et le juge inventerait des correspondances.
 * Le corps du client n'est jamais muté (copie).
 */
export function appendSkeleton(raw: unknown, skeleton: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = Array.isArray(raw)
    ? raw.filter((message) => asObject(message) !== null).map((message) => ({ ...(asObject(message) as Record<string, unknown>) }))
    : [];
  const index = messages.findIndex((message) => message.role === "system");
  if (index < 0) {
    messages.unshift({ role: "system", content: skeleton });
    return messages;
  }
  const target = messages[index];
  const content = target.content;
  if (typeof content === "string") {
    target.content = content === "" ? skeleton : `${content}\n\n${skeleton}`;
  } else if (Array.isArray(content)) {
    target.content = [...content, { type: "text", text: skeleton }];
  } else {
    target.content = skeleton;
  }
  return messages;
}

/** Corps d'un MEMBRE : corps client, `stream: false`, squelette, étape imposée. */
function memberBody(
  rawBody: Record<string, unknown>,
  skeleton: string,
  step: ServiceStep,
  provider: Parameters<typeof buildUpstreamBody>[2],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...rawBody,
    messages: appendSkeleton(rawBody.messages, skeleton),
    stream: false, // le panel ne peut pas streamer : il lui faut les corps complets
  };
  return buildUpstreamBody(body, step, provider, "chat");
}

/**
 * Corps du JUGE : AUCUN outil (le juge ne doit rien appeler), un seul `system`,
 * historique nettoyé, puis le message `user` du §3.3.
 */
function judgeBody(
  rawBody: Record<string, unknown>,
  instruction: string,
  userMessage: string,
  history: Array<Record<string, unknown>>,
  step: ServiceStep,
  provider: Parameters<typeof buildUpstreamBody>[2],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...rawBody,
    messages: [{ role: "system", content: instruction }, ...history, { role: "user", content: userMessage }],
    stream: false,
  };
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  return buildUpstreamBody(body, step, provider, "chat");
}

/** En-tête de diagnostic : le client VOIT si un juge a répondu. */
function withPanelHeader(output: RelayOutput, mode: "judge" | "degraded"): RelayOutput {
  return { ...output, headers: { ...output.headers, "x-switchy-panel": mode } };
}

/** Objet JSON d'une réponse relayée (jamais d'exception, `null` si non-JSON). */
function payloadObject(output: RelayOutput): Record<string, unknown> | null {
  if (!Buffer.isBuffer(output.payload)) return null;
  try {
    return asObject(JSON.parse(output.payload.toString("utf-8")));
  } catch {
    return null;
  }
}

// ── Test de DIAGNOSTIC d'une cible du panel (`POST /api/services/:name/test`) ──

/**
 * Cible d'un test du panel : UN membre (`A`/`B`/`C`) ou LE juge. Jamais les
 * 3 membres + le juge : ce serait 4 appels pour un simple diagnostic.
 */
export type PanelTestTarget = { role: "member"; index: number } | { role: "judge" };

/**
 * Propositions FACTICES envoyées au juge lors d'un test : courtes, fixes et
 * ANNONCÉES comme telles (on teste la configuration du juge, pas la qualité
 * d'une recomposition).
 */
export const PANEL_TEST_FAKE_PROPOSAL = "PROPOSITION FACTICE — test de configuration, aucun contenu réel.";

/** Fournisseur résolu (même type que celui attendu par `buildUpstreamBody`). */
type PanelProvider = Parameters<typeof buildUpstreamBody>[2];

/** Cible de test RÉSOLUE : l'étape, son rang de journal et son corps de production. */
export interface ResolvedPanelTestTarget {
  step: ServiceStep;
  /** Rang journalisé (`attempt`) : 0/1/2 pour les membres, 3 pour le juge. */
  attempt: number;
  panelRole: "member" | "judge";
  /**
   * Corps EXACT qu'enverrait le panel (squelette d'un membre, consigne et
   * propositions factices du juge) — construit avec le fournisseur résolu.
   */
  body: (provider: PanelProvider) => Record<string, unknown>;
}

/**
 * Résout une cible de test du panel. Source de vérité UNIQUE des corps : ce sont
 * `memberBody`/`judgeBody` de la production qui sont employés, jamais une copie
 * (un test qui n'enverrait pas le même corps ne dirait rien de la production).
 *
 * Renvoie `null` quand la cible n'existe pas sur ce service (aucun panel, index
 * de membre hors bornes) : l'appelant en fait un 400, jamais un appel inutile.
 */
export function resolvePanelTestTarget(
  service: ServiceRecord,
  rawBody: Record<string, unknown>,
  target: PanelTestTarget,
): ResolvedPanelTestTarget | null {
  const panel = service.panel;
  if (!panel) return null;

  if (target.role === "member") {
    const rank = target.index;
    if (!Number.isInteger(rank) || rank < 0 || rank >= panel.members.length) return null;
    const member = panel.members[rank];
    const skeleton = panelSkeleton(panel.lang);
    return {
      step: member,
      attempt: rank,
      panelRole: "member",
      body: (provider) => memberBody(rawBody, skeleton, member, provider),
    };
  }

  const judge = panel.judge;
  const instruction = judgePrompt(panel.lang);
  const conversation = splitJudgeConversation(rawBody.messages);
  const userMessage = buildJudgeUserMessage(
    conversation.request,
    PANEL_LABELS.map((label) => ({ label, text: PANEL_TEST_FAKE_PROPOSAL })),
  );
  return {
    step: judge,
    attempt: PANEL_JUDGE_ATTEMPT,
    panelRole: "judge",
    body: (provider) => judgeBody(rawBody, instruction, userMessage, conversation.history, judge, provider),
  };
}

// ── Orchestration ──

/**
 * Exécute le panel d'un service. Renvoie la réponse à servir, ou `null` si
 * AUCUNE proposition n'est utilisable (l'appelant bascule alors sur la chaîne
 * normale, même `callId`). Ne jette jamais pour un échec fournisseur : les
 * échecs sont journalisés et dégradent la réponse, ils ne la suppriment pas.
 */
export async function runPanel({ service, input, callId }: PanelRunRequest): Promise<PanelServed | null> {
  const panel = service.panel;
  if (!panel) return null;
  // Copie NON optionnelle : `runMember` est une déclaration de fonction (hoistée),
  // le rétrécissement de type du garde ci-dessus n'y survit pas.
  const config = panel;

  const prioritaire = service.prioritaire === true;
  const skeleton = panelSkeleton(panel.lang);
  const instruction = judgePrompt(panel.lang);
  const quorum = Math.min(Math.max(1, panel.quorum), panel.members.length);

  const logLine = (
    step: ServiceStep,
    entry: {
      attempt: number;
      result: CallResult;
      reason?: CallReason;
      error?: string;
      panelRole: "member" | "judge" | "fallback";
      panelRank?: number;
      panelServed?: boolean;
    },
  ): void => {
    logCall({
      callId,
      service: service.name,
      keyName: input.keyName,
      attempt: entry.attempt,
      provider: step.providerId,
      model: step.model,
      result: entry.result,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      durationMs: 0,
      prioritaire,
      endpoint: input.endpoint,
      panelRole: entry.panelRole,
      ...(entry.panelRank !== undefined ? { panelRank: entry.panelRank } : {}),
      ...(entry.panelServed ? { panelServed: true } : {}),
    });
  };

  // ── 1) Étapes utilisables (mêmes règles que la chaîne) ──
  const usable: number[] = [];
  panel.members.forEach((member, rank) => {
    if (!isStepEnabled(member)) {
      logLine(member, { attempt: rank, result: "skipped", reason: "step_disabled", panelRole: "member", panelRank: rank });
      return;
    }
    const provider = getProvider(member.providerId);
    if (!provider || !provider.enabled) {
      logLine(member, {
        attempt: rank,
        result: "skipped",
        error: provider ? "provider_disabled" : "provider_missing",
        panelRole: "member",
        panelRank: rank,
      });
      return;
    }
    usable.push(rank);
  });

  const slotRequest = (rank: number) => {
    const member = panel.members[rank];
    const provider = getProvider(member.providerId);
    return {
      service: service.name,
      provider: member.providerId,
      limit: provider?.maxConcurrency ?? getConcurrency(),
      prioritaire,
      signal: input.signal,
    };
  };

  // ── 2) ADMISSION ANTI-FAMINE ──
  // Invariant tenu à chaque instant : `propositions utilisables + membres en
  // vol <= quorum`. Le panel n'immobilise donc JAMAIS plus de `quorum` places
  // (2 par défaut) sur les 3 du compte fournisseur — un panel naïf prendrait
  // les 3 pendant des minutes (§5).
  //
  // Ce plafond porte sur les places SIMULTANÉES, pas sur le nombre d'appels :
  // quand un membre échoue (ou renvoie un appel d'outil), sa place est rendue et
  // le candidat suivant (C) est lancé pour tenter d'atteindre le quorum. Un
  // échec de proposeur est ainsi TRANSPARENT (décision utilisateur), tout en
  // gardant au plus `quorum` places occupées.
  //
  // Passe 1 : `tryAcquire` immédiat, dans l'ordre A→B→C. Passe 2 : attente
  // (`acquire`) BORNÉE à la couverture du quorum — au-delà, les candidats
  // restants sont écartés (`saturated`), comme en mode rolling.
  const proposals = new Map<number, { text: string; output: RelayOutput }>();
  const pending = [...usable];
  const running = new Set<Promise<void>>();
  const held = new Set<string>();

  const needMore = (): boolean => proposals.size + running.size < quorum && pending.length > 0;

  const startMember = (rank: number, slotKey: string): void => {
    held.add(slotKey);
    const promise = runMember(rank, slotKey).finally(() => {
      running.delete(promise);
      held.delete(slotKey);
    });
    running.add(promise);
  };

  const skipSaturated = (rank: number): void => {
    logLine(panel.members[rank], {
      attempt: rank,
      result: "skipped",
      reason: "saturated",
      panelRole: "member",
      panelRank: rank,
    });
  };

  /** Admet sans attendre tout ce qui peut l'être, sans jamais dépasser le quorum. */
  const fill = (): void => {
    while (needMore()) {
      const rank = pending[0];
      const slotKey = llmSlots.tryAcquire(slotRequest(rank));
      if (!slotKey) return; // seau plein : la passe d'attente prend le relais
      pending.shift();
      startMember(rank, slotKey);
    }
  };

  // ── 3) MEMBRES : corps, appel, collecte et écartement ──
  async function runMember(rank: number, slotKey: string): Promise<void> {
    const member = config.members[rank];
    const provider = getProvider(member.providerId);
    if (!provider) return; // déjà journalisé (fournisseur inutilisable)
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Panel member timeout", "TimeoutError"));
    }, config.memberTimeoutMs);
    (timer as { unref?: () => void })?.unref?.();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    try {
      const outcome = await attemptStep({
        service,
        step: member,
        attempt: rank,
        callId,
        provider,
        body: memberBody(input.body, skeleton, member, provider),
        headers: input.headers,
        prioritaire,
        signal,
        endpoint: input.endpoint,
        api: "chat",
        keyName: input.keyName,
        panel: {
          role: "member",
          rank,
          slotKey,
          abortReason: () => (timedOut ? "panel_member_timeout" : undefined),
          decide: (payload): PanelResultVerdict | undefined =>
            hasToolCall(payload) ? { result: "skipped", reason: "panel_tool_call_skipped" } : undefined,
        },
      });
      if (!outcome.ok) return; // ligne déjà journalisée par `attemptStep`
      const payload = payloadObject(outcome.output);
      const text = payload ? extractResponseText(payload) : undefined;
      // Une proposition vide (ni texte ni appel d'outil) n'est pas utilisable :
      // le quorum se compte sur les propositions RÉELLEMENT servables.
      if (!hasToolCall(payload) && typeof text === "string" && text.trim() !== "") {
        proposals.set(rank, { text, output: outcome.output });
      }
    } finally {
      clearTimeout(timer);
      // Libération idempotente : `attemptStep` a déjà rendu sa place sur son
      // chemin normal ; ce `finally` couvre une exception ou une sortie inattendue.
      llmSlots.release(slotKey);
    }
  }

  try {
    fill();
    while (running.size > 0 || needMore()) {
      if (running.size > 0) {
        // Un membre vient de rendre sa place : on refait le plein au besoin.
        await Promise.race(running);
        fill();
        continue;
      }
      // Plus rien en vol et quorum non couvert : on ATTEND une place pour le
      // prochain candidat (attente annulable par le client, bornée par la file).
      const rank = pending[0];
      if (input.signal?.aborted) break;
      let slotKey: string;
      try {
        slotKey = await llmSlots.acquire(slotRequest(rank));
      } catch (err) {
        if (input.signal?.aborted) break;
        if (err instanceof QueueFullError || err instanceof QueueTimeoutError) {
          // File pleine / attente expirée : le candidat est ÉCARTÉ, pas une erreur.
          pending.shift();
          skipSaturated(rank);
          continue;
        }
        throw err;
      }
      pending.shift();
      startMember(rank, slotKey);
    }
  } finally {
    // Aucune place du panel ne survit à la phase des membres (libération
    // idempotente : `attemptStep` a déjà rendu la sienne sur son chemin normal).
    for (const slotKey of held) llmSlots.release(slotKey);
  }

  // Candidats jamais lancés : quorum déjà couvert (écartement volontaire) ou
  // annulation client. Jamais silencieux.
  for (const rank of pending) skipSaturated(rank);

  // Annulation client : AUCUN appel de plus (ni juge, ni chaîne).
  if (input.signal?.aborted) return null;

  const usableRanks = [...proposals.keys()].sort((a, b) => a - b);

  // ── 4) Aucune proposition → repli sur la chaîne normale ──
  if (usableRanks.length === 0) {
    // ⚠️ Ligne de GROUPE : aucun appel réseau n'a été fait, elle n'est donc
    // attribuée à AUCUN modèle réel. L'attribuer à `service.principal`
    // fabriquait un faux échec (et une durée nulle) au nom d'un modèle jamais
    // appelé ; le provider de contexte `__panel__` garde la trace du passage au
    // repli sans polluer les statistiques du principal (les agrégations du
    // journal excluent ce provider — `calls-log.ts`).
    logCall({
      callId,
      service: service.name,
      keyName: input.keyName,
      attempt: PANEL_FALLBACK_ATTEMPT,
      provider: PANEL_CONTEXT_PROVIDER,
      model: PANEL_CONTEXT_MODEL,
      result: "error",
      reason: "panel_all_failed",
      durationMs: 0,
      prioritaire,
      endpoint: input.endpoint,
      panelRole: "fallback",
    });
    return null;
  }

  // ── 5) Quorum non atteint → la proposition est servie TELLE QUELLE ──
  if (usableRanks.length < quorum) {
    const rank = usableRanks[0];
    const proposal = proposals.get(rank) as { text: string; output: RelayOutput };
    logLine(panel.members[rank], {
      attempt: PANEL_FALLBACK_ATTEMPT,
      result: "skipped",
      reason: "panel_no_quorum",
      panelRole: "fallback",
      panelRank: rank,
      panelServed: true, // réponse servie sans le juge : succès du groupe
    });
    return { output: withPanelHeader(proposal.output, "degraded"), text: proposal.text, judged: false };
  }

  // ── 6) JUGE (admis seulement maintenant : tous les membres ont rendu leur place) ──
  const conversation = splitJudgeConversation(input.body.messages);
  const judged = await runJudge({
    service,
    input,
    callId,
    instruction,
    history: conversation.history,
    request: conversation.request,
    proposals,
    usableRanks,
    prioritaire,
    logLine,
  });
  if (judged) return judged;
  if (input.signal?.aborted) return null;

  // ── 7) Juge en échec ou vide → PREMIÈRE proposition utilisable (A→B→C) ──
  const rank = usableRanks[0];
  const proposal = proposals.get(rank) as { text: string; output: RelayOutput };
  logLine(panel.members[rank], {
    attempt: PANEL_FALLBACK_ATTEMPT,
    result: "ok",
    reason: "panel_degraded",
    panelRole: "fallback",
    panelRank: rank,
    panelServed: true,
  });
  return { output: withPanelHeader(proposal.output, "degraded"), text: proposal.text, judged: false };
}

/** Contexte du juge (sous-ensemble de `runPanel`, pour ne pas le noyer). */
interface JudgeRun {
  service: ServiceRecord;
  input: RelayInput;
  callId: string;
  instruction: string;
  history: Array<Record<string, unknown>>;
  request: string;
  proposals: Map<number, { text: string; output: RelayOutput }>;
  usableRanks: number[];
  prioritaire: boolean;
  logLine: (
    step: ServiceStep,
    entry: {
      attempt: number;
      result: CallResult;
      reason?: CallReason;
      error?: string;
      panelRole: "member" | "judge" | "fallback";
      panelRank?: number;
      panelServed?: boolean;
    },
  ) => void;
}

/**
 * Appelle le juge. Renvoie sa réponse, ou `null` si le juge n'a rien produit
 * d'utilisable (la ligne du juge est alors journalisée avec son motif :
 * `judge_failed` sans motif plus précis, `judge_empty`, ou le motif catégorisé
 * de l'échec fournisseur).
 */
async function runJudge(run: JudgeRun): Promise<PanelServed | null> {
  const { service, input, callId, instruction, history, request, proposals, usableRanks, prioritaire, logLine } = run;
  const panel = service.panel;
  if (!panel) return null;
  const judge = panel.judge;

  const unavailable = (error?: string): null => {
    logLine(judge, {
      attempt: PANEL_JUDGE_ATTEMPT,
      result: "error",
      reason: "judge_failed",
      panelRole: "judge",
      ...(error ? { error } : {}),
    });
    return null;
  };

  if (!isStepEnabled(judge)) {
    logLine(judge, { attempt: PANEL_JUDGE_ATTEMPT, result: "skipped", reason: "step_disabled", panelRole: "judge" });
    return null;
  }
  const provider = getProvider(judge.providerId);
  if (!provider || !provider.enabled) return unavailable(provider ? "provider_disabled" : "provider_missing");

  // Message `user` du §3.3 : étiquettes d'origine conservées, `INDISPONIBLE`
  // pour toute proposition manquante (échec ou appel d'outil écarté).
  const userMessage = buildJudgeUserMessage(
    request,
    PANEL_LABELS.map((label, rank) => ({
      label,
      text: usableRanks.includes(rank) ? (proposals.get(rank) as { text: string }).text : null,
    })),
  );

  let slotKey: string;
  try {
    slotKey = await llmSlots.acquire({
      service: service.name,
      provider: judge.providerId,
      limit: provider.maxConcurrency ?? getConcurrency(),
      prioritaire,
      signal: input.signal,
    });
  } catch (err) {
    if (input.signal?.aborted) return null;
    if (err instanceof QueueFullError || err instanceof QueueTimeoutError) return unavailable();
    throw err;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Panel judge timeout", "TimeoutError"));
  }, panel.judgeTimeoutMs);
  (timer as { unref?: () => void })?.unref?.();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;

  try {
    const outcome = await attemptStep({
      service,
      step: judge,
      attempt: PANEL_JUDGE_ATTEMPT,
      callId,
      provider,
      body: judgeBody(input.body, instruction, userMessage, history, judge, provider),
      headers: input.headers,
      prioritaire,
      signal,
      endpoint: input.endpoint,
      api: "chat",
      keyName: input.keyName,
      panel: {
        role: "judge",
        slotKey,
        // Un juge coupé par SON délai n'est pas une déconnexion client : le
        // motif le dit (`judge_failed`, faute de `judge_timeout` au vocabulaire).
        abortReason: () => (timedOut ? "judge_failed" : undefined),
        decide: (payload): PanelResultVerdict => {
          const text = payload ? extractResponseText(payload) : undefined;
          if (typeof text === "string" && text.trim() !== "") return { result: "ok", panelServed: true };
          return { result: "error", reason: "judge_empty", panelServed: false };
        },
      },
    });
    if (!outcome.ok) return null; // ligne déjà journalisée (motif précis)
    const payload = payloadObject(outcome.output);
    const text = payload ? extractResponseText(payload) : undefined;
    if (typeof text !== "string" || text.trim() === "") return null;
    return { output: withPanelHeader(outcome.output, "judge"), text, judged: true };
  } finally {
    clearTimeout(timer);
    llmSlots.release(slotKey);
  }
}
