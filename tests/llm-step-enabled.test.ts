/**
 * Bouton ON/OFF d'UNE ÉTAPE (`step.enabled`) — comportement à l'exécution.
 *
 * Verrouille les décisions de conception :
 *   1. une étape désactivée est SAUTÉE, avec un motif PROPRE
 *      (`reason: "step_disabled"`) : ni `saturated` (charge), ni une erreur
 *      fournisseur — aucun appel réseau n'est fait ;
 *   2. le PRINCIPAL peut être désactivé : la chaîne démarre alors sur le premier
 *      repli actif (jamais un 400, jamais un plantage) ;
 *   3. TOUTES les étapes désactivées → `503 / NO_ENABLED_STEP`, message clair,
 *      AUCUN appel fournisseur ;
 *   4. le bouton `enabled` du SERVICE reste le MAÎTRE (service éteint = 503,
 *      quelles que soient les étapes) ;
 *   5. le TEST d'une étape désactivée est REFUSÉ explicitement (aucun appel),
 *      tandis que le test de la CHAÎNE complète saute simplement les étapes
 *      éteintes (comportement de production) ;
 *   6. rolling + affinité : une étape désactivée ne consomme aucune place et
 *      n'est jamais reprise par affinité (retour au principal actif).
 *
 * AUCUN accès réseau : `globalThis.fetch` est mocké.
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
import { resetKeyAffinity, rememberProvider } from "../src/llm/key-affinity.js";

let env: TestEnv;
let mock: ReturnType<typeof installMockFetch> | null = null;
const held: string[] = [];

/** Nom de la clé d'outil de test (jamais un secret) — pour l'affinité. */
const KEY = "env-bootstrap";

beforeEach(() => {
  env = makeTestEnv();
  mock = null;
  held.length = 0;
  resetKeyAffinity();
});

afterEach(() => {
  mock?.restore();
  for (const slot of held) llmSlots.release(slot);
  env.cleanup();
});

function readLog(): Array<Record<string, unknown>> {
  const file = join(env.dir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Étape de fixture avec son état on/off. */
function offStep(providerId: string, model: string) {
  return { ...step(providerId, model), enabled: false };
}

function onStep(providerId: string, model: string) {
  return { ...step(providerId, model), enabled: true };
}

function chatBody(): Record<string, unknown> {
  return { model: "chat", messages: [{ role: "user", content: "bonjour" }] };
}

/** Deux fournisseurs (p1, p2) ; le service est décrit par l'appelant. */
async function seedProviders(): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Principal",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
    apiKey: "sk-P1_SECRET",
    maxConcurrency: 1,
  });
  await seedProvider(env.app, {
    id: "p2",
    label: "Repli",
    type: "openai-compatible",
    baseUrl: "https://p2.example/v1",
    apiKey: "sk-P2_SECRET",
    maxConcurrency: 1,
  });
}

async function seedServiceWith(steps: {
  principal: Record<string, unknown>;
  fallbacks: Array<Record<string, unknown>>;
  rolling?: boolean;
  enabled?: boolean;
}): Promise<void> {
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: steps.principal,
    fallbacks: steps.fallbacks,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    rolling: steps.rolling === true,
    enabled: steps.enabled !== false,
  });
}

// ── 1. Une étape désactivée est SAUTÉE ──

describe("exécution — une étape désactivée est SAUTÉE (motif distinct)", () => {
  it("repli désactivé → jamais appelé, aucune ligne réseau chez lui", async () => {
    await seedProviders();
    await seedServiceWith({ principal: onStep("p1", "model-p1"), fallbacks: [offStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p1" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("servi par p1");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example");
    // L'étape éteinte est journalisée UNE fois, sans appel réseau.
    const skipped = readLog().filter((e) => e.reason === "step_disabled");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ result: "skipped", provider: "p2", attempt: 1 });
  });

  it("motif `step_disabled` : ni `saturated` (charge) ni une erreur fournisseur", async () => {
    await seedProviders();
    await seedServiceWith({ principal: onStep("p1", "model-p1"), fallbacks: [offStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await api(env.app).post("/v1/chat/completions").send(chatBody());

    const entry = readLog().find((e) => e.reason === "step_disabled");
    expect(entry).toBeDefined();
    // Pas de confusion avec une bascule pour CHARGE : `charge` reste absent.
    expect(entry.charge).toBeUndefined();
    expect(entry.status).toBeUndefined();
    // Et `saturated` n'apparaît nulle part dans cet appel.
    expect(readLog().some((e) => e.reason === "saturated")).toBe(false);
  });

  it("étape désactivée SAUTÉE même quand elle serait la seule à pouvoir répondre", async () => {
    await seedProviders();
    // p1 renvoie 500 : le repli p2 existe mais est ÉTEINT → échec honnête, sans l'appeler.
    await seedServiceWith({ principal: onStep("p1", "model-p1"), fallbacks: [offStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(500);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls.some((call) => call.url.includes("p2.example"))).toBe(false);
  });
});

// ── 2. Principal désactivé → démarrage sur le repli actif ──

describe("exécution — principal désactivé", () => {
  it("démarre sur le repli 1 ACTIF (pas de 400, pas de plantage)", async () => {
    await seedProviders();
    await seedServiceWith({ principal: offStep("p1", "model-p1"), fallbacks: [onStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p2" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("servi par p2");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p2.example");
    // Le libellé/position ne change pas : c'est l'étape d'index 1 qui a répondu.
    expect(readLog().find((e) => e.result === "ok")).toMatchObject({ provider: "p2", attempt: 1 });
    expect(readLog().find((e) => e.reason === "step_disabled")).toMatchObject({ provider: "p1", attempt: 0 });
  });

  it("principal ET repli 1 désactivés → repli 2 actif prend la main", async () => {
    await seedProviders();
    await seedProvider(env.app, {
      id: "p3",
      label: "Repli 2",
      type: "openai-compatible",
      baseUrl: "https://p3.example/v1",
      apiKey: "sk-P3_SECRET",
    });
    await seedServiceWith({
      principal: offStep("p1", "model-p1"),
      fallbacks: [offStep("p2", "model-p2"), onStep("p3", "model-p3")],
    });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p3" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p3.example");
  });
});

// ── 3. Toutes désactivées → 503 clair, aucun appel ──

describe("exécution — toutes les étapes désactivées", () => {
  it("503 / NO_ENABLED_STEP avec un message clair, AUCUN appel fournisseur", async () => {
    await seedProviders();
    await seedServiceWith({
      principal: offStep("p1", "model-p1"),
      fallbacks: [offStep("p2", "model-p2")],
    });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "jamais" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(503);
    // Corps JSON brut (Buffer) : on le relit explicitement, sans dépendre du
    // type MIME renvoyé par le relais.
    const raw = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text ?? "");
    const body = JSON.parse(raw) as { error: string; code: string };
    expect(body.code).toBe("NO_ENABLED_STEP");
    expect(body.error).toMatch(/toutes les étapes sont désactivées/);
    expect(mock.calls).toHaveLength(0); // ni quota, ni latence inutile
    // Les deux étapes sont tout de même tracées (jamais silencieux).
    expect(readLog().filter((e) => e.reason === "step_disabled")).toHaveLength(2);
  });

  it("le bouton `enabled` du SERVICE reste MAÎTRE : service éteint → 503, étapes actives comprises", async () => {
    await seedProviders();
    await seedServiceWith({
      principal: onStep("p1", "model-p1"),
      fallbacks: [onStep("p2", "model-p2")],
      enabled: false,
    });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "jamais" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_DISABLED"); // ApiError → JSON typé
    expect(mock.calls).toHaveLength(0);
  });
});

// ── 4. Test d'une étape désactivée : refus explicite ──

describe("test d'étape — une étape désactivée est REFUSÉE", () => {
  it("POST /test avec stepIndex d'une étape éteinte → refus clair, sans appel", async () => {
    await seedProviders();
    await seedServiceWith({ principal: onStep("p1", "model-p1"), fallbacks: [offStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "jamais" } }] }));

    const res = await api(env.app)
      .post("/api/services/chat/test")
      .send({ stepIndex: 1, prompt: "ok", maxTokens: 16 });

    expect(res.status).toBe(200); // diagnostic, pas une erreur de protocole
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(0);
    expect(res.body.error).toMatchObject({ code: "step_disabled", reason: "step_disabled" });
    expect(res.body.error.message).toMatch(/désactivée/);
    expect(mock.calls).toHaveLength(0);
  });

  it("une étape ACTIVE reste testable (aucune régression du bouton « Tester »)", async () => {
    await seedProviders();
    await seedServiceWith({ principal: onStep("p1", "model-p1"), fallbacks: [offStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const res = await api(env.app).post("/api/services/chat/test").send({ stepIndex: 0, maxTokens: 16 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it("test de la CHAÎNE complète → les étapes éteintes sont sautées (comportement de prod)", async () => {
    await seedProviders();
    await seedServiceWith({ principal: offStep("p1", "model-p1"), fallbacks: [onStep("p2", "model-p2")] });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const res = await api(env.app).post("/api/services/chat/test").send({ maxTokens: 16 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stepIndex).toBe(1);
    expect(res.body.providerId).toBe("p2");
    expect(res.body.fellBack).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });
});

// ── 5. Rolling + affinité ──

describe("rolling & affinité — une étape désactivée est ignorée", () => {
  it("affinité IGNORÉE si le fournisseur mémorisé est une étape désactivée", async () => {
    await seedProviders();
    await seedServiceWith({
      principal: onStep("p1", "model-p1"),
      fallbacks: [offStep("p2", "model-p2")],
      rolling: true,
    });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p1" } }] }));
    rememberProvider(KEY, "p2"); // cache chaud… mais p2 est ÉTEINT

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example"); // retour au principal actif
    expect(readLog().some((e) => e.affinity === true)).toBe(false);
  });

  it("une étape désactivée n'est JAMAIS la cible d'attente quand tout est saturé", async () => {
    await seedProviders();
    await seedServiceWith({
      principal: onStep("p1", "model-p1"),
      fallbacks: [offStep("p2", "model-p2")],
      rolling: true,
    });
    // p1 (plafond 1) est plein ; p2 est éteint → l'attente doit porter sur p1.
    const slot = llmSlots.tryAcquire({ service: "autre", provider: "p1", limit: 1, prioritaire: false });
    if (!slot) throw new Error("impossible d'occuper la place de p1");
    held.push(slot);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p1" } }] }));

    const pending = api(env.app).post("/v1/chat/completions").send(chatBody());
    // Laisse la passe « sans attente » s'exécuter : p1 saturé, p2 éteint.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mock.calls.some((call) => call.url.includes("p2.example"))).toBe(false);

    // Libère p1 : l'attente doit aboutir CHEZ p1 (jamais chez l'étape éteinte).
    llmSlots.release(slot);
    held.length = 0;
    const res = await pending;

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example");
  });
});
