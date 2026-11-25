/**
 * Service « PANEL » — orchestration (`src/llm/panel.ts`).
 *
 * AUCUN réseau réel : `globalThis.fetch` est mocké, les réponses sont routées
 * par le `model` du corps envoyé au fournisseur (`m-a`, `m-b`, `m-c`,
 * `m-judge`, `m-chain`).
 *
 * Comportements verrouillés ici (décisions utilisateur figées, §9) :
 *   - quorum 2/3 : le juge recompose, ses `[sources : …]` restent visibles ;
 *   - quorum 3/3 : les trois propositions partent au juge ;
 *   - quorum non atteint (1 utilisable) : la proposition est servie TELLE QUELLE,
 *     sans juge ;
 *   - une réponse `tool_calls` est ÉCARTÉE (elle ne compte pas au quorum) et la
 *     proposition manquante vaut `INDISPONIBLE` chez le juge ;
 *   - les 3 membres en appel d'outil → repli sur la CHAÎNE normale, même `callId` ;
 *   - juge en échec ou vide → PREMIÈRE proposition utilisable (A→B→C) ;
 *   - anti-famine : jamais plus de `quorum` places, juge admis après libération ;
 *   - annulation client : aucun appel supplémentaire, toutes les places rendues ;
 *   - journal : même `callId`, rangs 0/1/2/3, motifs du §6, `panelServed`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  step,
  jsonResponse,
  type TestEnv,
} from "./helpers.js";
import { llmSlots } from "../src/llm/slot-queue.js";
import { relayService, UpstreamFailure } from "../src/llm/relay.js";
import { readAllCallsLog, summarizeActivity } from "../src/llm/calls-log.js";
import { toCallPayload } from "../src/live/hub.js";
import { JUDGE_PROMPT_FR } from "../src/llm/panel-prompts.js";

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

// ── Fixtures ──

const PROVIDER = { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "http://p.test/v1" };

/** Réponse chat complète (corps JSON, jamais de flux : le panel force stream:false). */
function chatResponse(content: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  });
}

/** Réponse « appel d'outil » : inutilisable comme proposition. */
function toolCallResponse(): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

type ModelHandler = (signal: AbortSignal | undefined) => Response | Promise<Response>;

/** Installe un mock réseau routant par `model` du corps envoyé. */
function mockModels(handlers: Record<string, ModelHandler>) {
  return installMockFetch(async (_url, init) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { model?: string };
    const model = String(body.model ?? "");
    const handler = handlers[model];
    if (!handler) throw new Error(`unexpected upstream model: ${model}`);
    return handler(init.signal);
  });
}

/** Corps JSON envoyé au fournisseur pour un `model` donné. */
function sentBody(model: string): Record<string, unknown> {
  const call = mock?.calls.find((c) => {
    const body = JSON.parse(String(c.init.body ?? "{}")) as { model?: string };
    return body.model === model;
  });
  if (!call) throw new Error(`no upstream call for model ${model}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function calledModels(): string[] {
  return (mock?.calls ?? []).map((c) => String((JSON.parse(String(c.init.body ?? "{}")) as { model?: string }).model));
}

/** Service « mode panel » : principal/fallbacks = repli de chaîne, panel = 3 + 1. */
async function seedPanelService(options: { quorum?: number; memberTimeoutMs?: number } = {}): Promise<void> {
  await seedProvider(env.app, { ...PROVIDER });
  await seedService(env.app, {
    name: "panel-svc",
    description: "panel",
    principal: step("p1", "m-chain"),
    fallbacks: [step("p1", "m-fallback")],
    contextWindow: 8192,
    maxOutputTokens: 1024,
    vision: false,
    prioritaire: false,
    rolling: false,
    enabled: true,
    panel: {
      members: [step("p1", "m-a"), step("p1", "m-b"), step("p1", "m-c")],
      judge: step("p1", "m-judge"),
      quorum: options.quorum ?? 2,
      memberTimeoutMs: options.memberTimeoutMs ?? 60_000,
      judgeTimeoutMs: 90_000,
      lang: "fr",
    },
  });
}

interface LogLine {
  [key: string]: unknown;
}

function readLog(): LogLine[] {
  const file = join(env.dir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

function relayBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "panel-svc", messages: [{ role: "user", content: "Quelle base de données choisir ?" }], ...extra };
}

// ── Quorum ──

describe("panel — quorum", () => {
  it("quorum 2/3 : deux propositions suffisent, le juge recompose", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => jsonResponse({ error: "boom" }, { status: 500 }),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("RÉPONSE JUGÉE\n[sources : A, C]"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain("RÉPONSE JUGÉE");
    expect(res.headers["x-switchy-panel"]).toBe("judge");
    // 3 membres + 1 juge, jamais la chaîne
    expect(calledModels().sort()).toEqual(["m-a", "m-b", "m-c", "m-judge"]);

    // Le juge reçoit un corps SANS outils, UN SEUL system (son prompt) et le
    // message `user` du §3.3 avec INDISPONIBLE pour la proposition manquante.
    const judge = sentBody("m-judge");
    expect(judge.tools).toBeUndefined();
    expect(judge.stream).toBe(false);
    const messages = judge.messages as Array<{ role: string; content: string }>;
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages[0].content).toBe(JUDGE_PROMPT_FR);
    const user = messages[messages.length - 1];
    expect(user.role).toBe("user");
    expect(user.content).toContain("DEMANDE D'ORIGINE :");
    expect(user.content).toContain("Quelle base de données choisir ?");
    expect(user.content).toContain("[A]\nPROP A");
    expect(user.content).toContain("[B]\nINDISPONIBLE");
    expect(user.content).toContain("[C]\nPROP C");
  });

  it("quorum 3/3 : les trois propositions partent au juge, outils du client conservés chez les membres", async () => {
    await seedPanelService({ quorum: 3 });
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("FUSION"),
    });
    const tools = [{ type: "function", function: { name: "read_file", parameters: {} } }];

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody({ tools }));

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("FUSION");
    const judgeUser = (sentBody("m-judge").messages as Array<{ content: string }>).at(-1)?.content ?? "";
    expect(judgeUser).toContain("[A]\nPROP A");
    expect(judgeUser).toContain("[B]\nPROP B");
    expect(judgeUser).toContain("[C]\nPROP C");
    expect(judgeUser).not.toContain("INDISPONIBLE");

    // Membres : outils du client CONSERVÉS, squelette en fin de premier system,
    // stream forcé à false.
    const member = sentBody("m-a");
    expect(member.tools).toEqual(tools);
    expect(member.stream).toBe(false);
    const memberMessages = member.messages as Array<{ role: string; content: string }>;
    expect(memberMessages[0].role).toBe("system");
    expect(memberMessages[0].content).toContain("Réponse directe");
    expect(memberMessages[0].content).toContain("250 mots");
  });

  it("quorum non atteint (1/3) : la proposition est servie TELLE QUELLE, sans juge", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => jsonResponse({ error: "boom" }, { status: 500 }),
      "m-b": () => jsonResponse({ error: "boom" }, { status: 429 }),
      "m-c": () => chatResponse("PROP C SEULE"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("PROP C SEULE");
    expect(res.headers["x-switchy-panel"]).toBe("degraded");
    expect(calledModels()).not.toContain("m-judge");
    expect(calledModels()).not.toContain("m-chain");

    const lines = readLog();
    expect(lines.some((l) => l.reason === "panel_no_quorum" && l.panelServed === true)).toBe(true);
    // Comptage : la ligne servie vaut SUCCÈS pour le groupe.
    expect(summarizeActivity(readAllCallsLog()).succeeded).toBe(1);
  });
});

// ── Appels d'outils ──

describe("panel — écartement des appels d'outils", () => {
  it("une proposition en tool_calls est écartée (et vaut INDISPONIBLE chez le juge)", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => toolCallResponse(),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("FUSION SANS A"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("FUSION SANS A");
    const judgeUser = (sentBody("m-judge").messages as Array<{ content: string }>).at(-1)?.content ?? "";
    expect(judgeUser).toContain("[A]\nINDISPONIBLE");
    expect(judgeUser).toContain("[B]\nPROP B");

    const aLine = readLog().find((l) => l.model === "m-a");
    expect(aLine?.result).toBe("skipped");
    expect(aLine?.reason).toBe("panel_tool_call_skipped");
    expect(aLine?.panelRole).toBe("member");
  });

  it("les 3 membres en appel d'outil : repli sur la chaîne normale, même callId", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => toolCallResponse(),
      "m-b": () => toolCallResponse(),
      "m-c": () => toolCallResponse(),
      "m-chain": () => chatResponse("RÉPONSE CHAÎNE"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("RÉPONSE CHAÎNE");
    expect(res.body.panel).toBeUndefined();

    const lines = readLog();
    const callIds = new Set(lines.map((l) => l.callId));
    expect(callIds.size).toBe(1); // un seul appel logique
    expect(lines.filter((l) => l.reason === "panel_tool_call_skipped")).toHaveLength(3);
    const allFailed = lines.find((l) => l.reason === "panel_all_failed");
    expect(allFailed?.result).toBe("error");
    expect(allFailed?.panelRole).toBe("fallback");
    // La ligne de la chaîne se distingue de la ligne de GROUPE du panel
    // (`panel_all_failed`) : la seconde reprend l'étape du principal comme
    // porteur, mais `panelRole` est absent pour un vrai appel de chaîne.
    const chain = lines.find((l) => l.model === "m-chain" && l.panelRole === undefined);
    expect(chain?.result).toBe("ok");
    expect(chain?.attempt).toBe(4); // rangs 0-3 pris par le panel
  });
});

// ── Juge en échec / vide ──

describe("panel — juge en échec", () => {
  it("juge en échec : PREMIÈRE proposition utilisable, journal `panel_degraded`", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => jsonResponse({ error: "boom" }, { status: 500 }),
      "m-judge": () => jsonResponse({ error: "boom" }, { status: 500 }),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("PROP A");
    expect(res.headers["x-switchy-panel"]).toBe("degraded");

    const lines = readLog();
    const judgeLine = lines.find((l) => l.panelRole === "judge");
    expect(judgeLine?.result).toBe("error");
    expect(judgeLine?.attempt).toBe(3);
    const degraded = lines.find((l) => l.reason === "panel_degraded");
    expect(degraded?.result).toBe("ok");
    expect(degraded?.panelServed).toBe(true);
    expect(summarizeActivity(readAllCallsLog()).succeeded).toBe(1);
  });

  it("juge vide : première proposition utilisable, journal `judge_empty`", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("   "),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("PROP A");
    const lines = readLog();
    const judgeLine = lines.find((l) => l.panelRole === "judge");
    expect(judgeLine?.reason).toBe("judge_empty");
    expect(lines.some((l) => l.reason === "panel_degraded" && l.panelServed === true)).toBe(true);
  });
});

// ── Anti-famine ──

describe("panel — anti-famine", () => {
  it("n'immobilise jamais plus de `quorum` places et n'admet le juge qu'après libération", async () => {
    // UN SEUL fournisseur, DEUX places : le piège exact du §5.
    await seedProvider(env.app, { ...PROVIDER, maxConcurrency: 2 });
    await seedService(env.app, {
      name: "panel-svc",
      description: "panel",
      principal: step("p1", "m-chain"),
      fallbacks: [],
      contextWindow: 8192,
      maxOutputTokens: 1024,
      vision: false,
      prioritaire: false,
      rolling: false,
      enabled: true,
      panel: {
        members: [step("p1", "m-a"), step("p1", "m-b"), step("p1", "m-c")],
        judge: step("p1", "m-judge"),
        quorum: 2,
        memberTimeoutMs: 60_000,
        judgeTimeoutMs: 90_000,
        lang: "fr",
      },
    });

    let active = 0;
    let maxActive = 0;
    const events: { model: string; phase: "start" | "end"; at: number }[] = [];
    const slow = (model: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push({ model, phase: "start", at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      events.push({ model, phase: "end", at: Date.now() });
      return chatResponse(`PROP ${model}`);
    };
    mock = mockModels({
      "m-a": slow("m-a"),
      "m-b": slow("m-b"),
      "m-c": slow("m-c"),
      "m-judge": slow("m-judge"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());

    expect(res.status).toBe(200);
    // Jamais plus de `quorum` (2) places simultanées chez le fournisseur.
    expect(maxActive).toBeLessThanOrEqual(2);
    // Le 3ᵉ membre n'est même pas lancé : le quorum est atteint avant lui.
    expect(calledModels()).not.toContain("m-c");
    const memberEnds = events.filter((e) => e.phase === "end" && e.model !== "m-judge").map((e) => e.at);
    const judgeStart = events.find((e) => e.phase === "start" && e.model === "m-judge")?.at;
    expect(judgeStart).toBeDefined();
    // Le juge n'est admis qu'APRÈS la libération de tous les membres.
    expect(judgeStart as number).toBeGreaterThanOrEqual(Math.max(...memberEnds));
    // Le membre écarté est journalisé `saturated`, jamais silencieusement.
    const saturated = readLog().find((l) => l.reason === "saturated" && l.panelRank === 2);
    expect(saturated?.result).toBe("skipped");
    expect(saturated?.panelRole).toBe("member");
  });
});

// ── Annulation du client ──

describe("panel — annulation du client", () => {
  it("aucun appel supplémentaire et toutes les places rendues", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": (signal) => abortable(signal, 200, () => chatResponse("PROP A")),
      "m-b": (signal) => abortable(signal, 200, () => chatResponse("PROP B")),
      "m-c": (signal) => abortable(signal, 200, () => chatResponse("PROP C")),
      "m-judge": () => chatResponse("FUSION"),
    });

    const controller = new AbortController();
    const pending = relayService({
      serviceName: "panel-svc",
      body: relayBody(),
      headers: {},
      signal: controller.signal,
      keyName: "test",
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeInstanceOf(UpstreamFailure);
    await expect(pending).rejects.toMatchObject({ aborted: true });

    // Ni juge, ni chaîne après l'annulation.
    expect(calledModels()).not.toContain("m-judge");
    expect(calledModels()).not.toContain("m-chain");
    // Toutes les places rendues (aucune fuite de slot).
    expect(llmSlots.getStats().active).toBe(0);
    expect(llmSlots.getStats().queued).toBe(0);
  });
});

// ── Journal & direct ──

describe("panel — journal et direct", () => {
  it("4 lignes, même callId, rangs 0/1/2/3, motifs du §6 et panelServed", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("FUSION"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody());
    expect(res.status).toBe(200);

    const lines = readLog();
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => l.callId)).size).toBe(1);
    expect(lines.map((l) => l.attempt).sort()).toEqual([0, 1, 2, 3]);
    expect(lines.map((l) => l.panelRole).sort()).toEqual(["judge", "member", "member", "member"]);
    const judgeLine = lines.find((l) => l.panelRole === "judge");
    expect(judgeLine?.panelServed).toBe(true);
    expect(judgeLine?.result).toBe("ok");
    // Un appel logique, pas quatre.
    const summary = summarizeActivity(readAllCallsLog());
    expect(summary.calls).toBe(1);
    expect(summary.succeeded).toBe(1);
  });

  it("le direct expose panelRole / panelRank / panelServed (CALL_FIELDS étendu)", () => {
    const payload = toCallPayload({ provider: "p1", panelRole: "judge", panelRank: 0, panelServed: true });
    expect(payload.call).toEqual({
      provider: "p1",
      panelRole: "judge",
      panelRank: 0,
      panelServed: true,
    });
  });
});

/** Réponse différée qui REJETTE à l'annulation, comme un vrai `fetch`. */
function abortable(signal: AbortSignal | undefined, ms: number, make: () => Response): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(make()), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// ── SSE synthétique (§4, décision D3) ──

describe("panel — SSE synthétique", () => {
  it("stream: true → flux SSE d'un bloc, en-tête x-switchy-panel, puis [DONE]", async () => {
    await seedPanelService();
    mock = mockModels({
      "m-a": () => chatResponse("PROP A"),
      "m-b": () => chatResponse("PROP B"),
      "m-c": () => chatResponse("PROP C"),
      "m-judge": () => chatResponse("RÉPONSE JUGÉE"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody({ stream: true }));

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    // En SSE, le mode exact (juge/dégradé) n'est plus un en-tête : le flux est
    // déjà ouvert quand le panel rend sa réponse. L'en-tête annonce le panel.
    expect(res.headers["x-switchy-panel"]).toBe("panel");
    const raw = res.text;
    expect(raw).toContain('"object":"chat.completion.chunk"');
    expect(raw).toContain('"content":"RÉPONSE JUGÉE"');
    expect(raw).toContain('"finish_reason":"stop"');
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("un battement `: ping` est émis pendant l'attente du panel", async () => {
    env.cleanup();
    env = makeTestEnv({ SWITCHY_PANEL_SSE_PING_MS: "10" });
    await seedPanelService();
    const slow = (text: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return chatResponse(text);
    };
    mock = mockModels({
      "m-a": slow("PROP A"),
      "m-b": slow("PROP B"),
      "m-c": slow("PROP C"),
      "m-judge": slow("RÉPONSE JUGÉE"),
    });

    const res = await api(env.app).post("/v1/chat/completions").send(relayBody({ stream: true }));

    expect(res.status).toBe(200);
    expect(res.text).toContain(": ping");
    expect(res.text).toContain("data: [DONE]");
  });
});
