/**
 * Test de DIAGNOSTIC des cibles du PANEL — `POST /api/services/:name/test` avec
 * `panel: "member" | "judge"` (+ `panelIndex: 0|1|2`).
 *
 * Ce que ces tests verrouillent (décisions utilisateur) :
 *   - un MEMBRE se teste SEUL, avec le corps EXACT de la production (squelette
 *     du panel ajouté au `system`) : ni les autres membres, ni le juge ;
 *   - le JUGE se teste SEUL, avec des propositions FACTICES (courtes et
 *     annoncées) : les 3 membres ne sont PAS appelés (coût ÷4) ;
 *   - `maxTokens` reste plafonné par la route (`TEST_MAX_TOKENS`) : un test ne
 *     peut pas coûter plus cher qu'avant ;
 *   - une cible invalide (index hors bornes, service sans panel, `stepIndex` +
 *     `panel`, `panelIndex` sans `panel`) est refusée en 400 SANS appel ;
 *   - RÉTRO-COMPATIBILITÉ : `stepIndex` seul (et la chaîne complète) se
 *     comporte exactement comme avant.
 *
 * AUCUN accès réseau : `globalThis.fetch` est mocké.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { panelSkeleton, PANEL_UNAVAILABLE } from "../src/llm/panel-prompts.js";
import { PANEL_TEST_FAKE_PROPOSAL } from "../src/llm/panel.js";

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

const PROVIDER = { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "http://p.test/v1" };

function okPayload(text = "ok"): Response {
  return jsonResponse({
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
}

/** Service « mode panel » : chaîne de repli + 3 membres + 1 juge, même fournisseur. */
async function seedPanelService(options: { judgeEnabled?: boolean; disabledMember?: number } = {}): Promise<void> {
  await seedProvider(env.app, { ...PROVIDER });
  const member = (model: string, index: number) => ({
    ...step("p1", model),
    ...(options.disabledMember === index ? { enabled: false } : {}),
  });
  await seedService(env.app, {
    name: "panel-svc",
    description: "",
    principal: step("p1", "m-chain"),
    fallbacks: [step("p1", "m-fallback")],
    contextWindow: 8192,
    maxOutputTokens: 1024,
    vision: false,
    enabled: true,
    panel: {
      members: [member("m-a", 0), member("m-b", 1), member("m-c", 2)],
      judge: { ...step("p1", "m-judge"), ...(options.judgeEnabled === false ? { enabled: false } : {}) },
      quorum: 2,
      memberTimeoutMs: 60_000,
      judgeTimeoutMs: 90_000,
      lang: "fr",
    },
  });
}

/** Corps JSON envoyé au fournisseur pour `model` (le premier trouvé). */
function sentBody(model: string): Record<string, unknown> {
  const call = mock?.calls.find((c) => {
    const body = JSON.parse(String(c.init.body ?? "{}")) as { model?: string };
    return body.model === model;
  });
  if (!call) throw new Error(`aucun appel amont pour le modèle ${model}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function calledModels(): string[] {
  return (mock?.calls ?? []).map((c) => String((JSON.parse(String(c.init.body ?? "{}")) as { model?: string }).model));
}

/** Texte concaténé des `system` d'un corps (le squelette du panel y est ajouté). */
function systemText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  return messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

/** Texte concaténé des `user` d'un corps (le message du juge du §3.3). */
function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

describe("panel — test d'un MEMBRE seul", () => {
  it("panelIndex 1 : UN appel à la proposition B, avec le squelette du panel", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload("proposition B"));

    const res = await api(env.app)
      .post("/api/services/panel-svc/test")
      .send({ panel: "member", panelIndex: 1, prompt: "Quelle base de données ?" });

    expect(res.status).toBe(200);
    // UN seul appel réseau, et c'est BIEN le membre B (ni A, ni C, ni le juge).
    expect(calledModels()).toEqual(["m-b"]);
    expect(res.body.ok).toBe(true);
    expect(res.body.providerId).toBe("p1");
    expect(res.body.model).toBe("m-b");
    expect(res.body.panel).toEqual({ role: "member", index: 1 });
    expect(res.body.stepIndex).toBe(1);
    expect(res.body.text).toBe("proposition B");
    // MÊME corps qu'en production : le squelette du panel est imposé au modèle.
    expect(systemText(sentBody("m-b"))).toContain(panelSkeleton("fr"));
    // Plafond de la route respecté (64 par défaut, jamais plus de 256).
    expect(Number(sentBody("m-b").max_tokens)).toBeLessThanOrEqual(256);
  });

  it("maxTokens reste PLAFONNÉ (un test ne peut pas exploser la facture)", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app)
      .post("/api/services/panel-svc/test")
      .send({ panel: "member", panelIndex: 0, maxTokens: 99_999 });

    expect(res.status).toBe(200);
    expect(Number(sentBody("m-a").max_tokens)).toBe(256);
  });

  it("membre DÉSACTIVÉ : refus explicite, aucun appel (comme une étape éteinte)", async () => {
    await seedPanelService({ disabledMember: 2 });
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/panel-svc/test").send({ panel: "member", panelIndex: 2 });

    expect(res.status).toBe(200); // diagnostic, pas une erreur de protocole
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(0);
    expect(res.body.error).toMatchObject({ code: "step_disabled" });
    expect(res.body.error.message).toMatch(/proposition C/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("panel — test du JUGE seul", () => {
  it("panel judge : UN appel au juge, propositions FACTICES, jamais les 3 membres", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload("recomposition"));

    const res = await api(env.app)
      .post("/api/services/panel-svc/test")
      .send({ panel: "judge", prompt: "Quelle base de données ?" });

    expect(res.status).toBe(200);
    // Coût ÷4 : le juge SEUL — aucun membre n'est appelé.
    expect(calledModels()).toEqual(["m-judge"]);
    expect(res.body.ok).toBe(true);
    expect(res.body.model).toBe("m-judge");
    expect(res.body.panel).toEqual({ role: "judge" });
    expect(res.body.stepIndex).toBe(3); // rang du juge dans le journal

    const body = sentBody("m-judge");
    // Le juge ne reçoit AUCUN outil (règle de production).
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    // Les 3 propositions annoncées comme FACTICES, jamais `INDISPONIBLE`.
    const user = userText(body);
    expect(user).toContain("Quelle base de données ?");
    expect(user).toContain(PANEL_TEST_FAKE_PROPOSAL);
    expect(user).not.toContain(PANEL_UNAVAILABLE);
    expect(user.split("[A]")).toHaveLength(2);
    expect(user.split("[B]")).toHaveLength(2);
    expect(user.split("[C]")).toHaveLength(2);
  });

  it("juge DÉSACTIVÉ : refus explicite, aucun appel", async () => {
    await seedPanelService({ judgeEnabled: false });
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/panel-svc/test").send({ panel: "judge" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({ code: "step_disabled" });
    expect(res.body.error.message).toMatch(/juge du panel/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("panel — cibles invalides (400, aucun appel)", () => {
  it("panelIndex hors bornes", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/panel-svc/test").send({ panel: "member", panelIndex: 7 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(String(res.body.error)).toMatch(/panelIndex/);
    expect(mock.calls).toHaveLength(0);
  });

  it("panel sur un service SANS panel", async () => {
    await seedProvider(env.app, { ...PROVIDER });
    await seedService(env.app, {
      name: "simple",
      description: "",
      principal: step("p1", "m-chain"),
      fallbacks: [],
      contextWindow: 8192,
      maxOutputTokens: 1024,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/simple/test").send({ panel: "judge" });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/pas de mode panel/);
    expect(mock.calls).toHaveLength(0);
  });

  it("panel inconnu, panelIndex sans panel, panel + stepIndex", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload());

    const bogus = await api(env.app).post("/api/services/panel-svc/test").send({ panel: "trois" });
    expect(bogus.status).toBe(400);
    expect(String(bogus.body.error)).toMatch(/member|judge/);

    const orphan = await api(env.app).post("/api/services/panel-svc/test").send({ panelIndex: 0 });
    expect(orphan.status).toBe(400);
    expect(String(orphan.body.error)).toMatch(/panelIndex/);

    const both = await api(env.app).post("/api/services/panel-svc/test").send({ panel: "judge", stepIndex: 0 });
    expect(both.status).toBe(400);
    expect(String(both.body.error)).toMatch(/une seule cible/);

    expect(mock.calls).toHaveLength(0);
  });
});

describe("panel — rétro-compatibilité du contrat de test", () => {
  it("`stepIndex` seul n'appelle QUE l'étape de chaîne demandée", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/panel-svc/test").send({ stepIndex: 0 });

    expect(res.status).toBe(200);
    expect(calledModels()).toEqual(["m-chain"]);
    expect(res.body.panel).toBeUndefined(); // écho panel absent ⇒ client inchangé
  });

  it("sans cible : CHAÎNE COMPLÈTE (comportement historique, jamais le panel)", async () => {
    await seedPanelService();
    mock = installMockFetch(() => okPayload());

    const res = await api(env.app).post("/api/services/panel-svc/test").send({});

    expect(res.status).toBe(200);
    expect(calledModels()).toEqual(["m-chain"]);
    expect(res.body.fellBack).toBe(false);
  });
});
