/**
 * Mode « ROLLING » d'un service : ne pas patienter quand un fournisseur est plein.
 *
 * Trois comportements verrouillés ici (décisions utilisateur) :
 *   1. une étape dont le fournisseur est PLEIN est SAUTÉE sans attente — la
 *      chaîne passe à l'étape suivante (bascule pour CHARGE) ;
 *   2. si TOUTES les étapes sont saturées → on ATTEND sur le fournisseur
 *      MÉMORISÉ pour la clé d'API (affinité, cache chaud) ;
 *   3. sans historique pour la clé → on attend sur le PRINCIPAL ;
 *   4. `rolling: false` → comportement historique INCHANGÉ (file d'attente, et
 *      aucune étape sautée pour cause de charge).
 *
 * AUCUN accès réseau : `globalThis.fetch` est mocké. Les places sont occupées
 * directement dans le seau partagé (`llmSlots.tryAcquire`), plafond 1.
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
  waitFor,
  type TestEnv,
} from "./helpers.js";
import { llmSlots } from "../src/llm/slot-queue.js";
import { resetKeyAffinity, preferredProvider } from "../src/llm/key-affinity.js";

let env: TestEnv;
let mock: ReturnType<typeof installMockFetch> | null = null;
const held: string[] = [];

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

/** Occupe la seule place du fournisseur (plafond 1) — équivalent d'un appel en vol. */
function occupy(providerId: string): string {
  const slot = llmSlots.tryAcquire({ service: "test", provider: providerId, limit: 1, prioritaire: false });
  if (!slot) throw new Error(`impossible d'occuper la place de ${providerId}`);
  held.push(slot);
  return slot;
}

function release(slot: string): void {
  llmSlots.release(slot);
  const index = held.indexOf(slot);
  if (index >= 0) held.splice(index, 1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Deux fournisseurs plafonnés à 1 + un service (rolling selon l'appelant). */
async function seedChain(rolling: boolean): Promise<void> {
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
  await seedService(env.app, {
    name: "chat",
    description: "",
    principal: step("p1", "model-p1"),
    fallbacks: [step("p2", "model-p2")],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    rolling,
    enabled: true,
  });
}

function chatBody(): Record<string, unknown> {
  return { model: "chat", messages: [{ role: "user", content: "bonjour" }] };
}

describe("rolling — une étape pleine est SAUTÉE (bascule pour charge)", () => {
  it("principal saturé → repli appelé tout de suite, motifs distincts au journal", async () => {
    await seedChain(true);
    occupy("p1");
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "servi par p2" } }] }));

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("servi par p2");
    // Aucune attente : un SEUL appel réseau, chez le repli.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p2.example");

    const entries = readLog();
    const skip = entries.find((e) => e.result === "skipped");
    const ok = entries.find((e) => e.result === "ok");
    // Étape écartée pour CHARGE : motif dédié, jamais une erreur fournisseur.
    expect(skip).toMatchObject({ provider: "p1", attempt: 0, reason: "saturated", charge: true });
    expect(skip?.status).toBeUndefined();
    // La tentative qui a suivi porte la marque « bascule pour charge ».
    expect(ok).toMatchObject({ provider: "p2", attempt: 1, charge: true });
    expect(ok?.reason).toBeUndefined();
    // ⚠️ Aucune clé dans le journal ni dans la réponse.
    const raw = readFileSync(join(env.dir, "calls.jsonl"), "utf-8");
    expect(raw).not.toContain("sk-P1_SECRET");
    expect(raw).not.toContain("sk-P2_SECRET");
    expect(JSON.stringify(res.body)).not.toContain("sk-");
  });
});

describe("rolling — toutes les étapes saturées : on ATTEND, jamais hors du service", () => {
  it("attend sur le fournisseur MÉMORISÉ pour la clé (cache chaud)", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    // 1. p1 plein → p2 répond → l'affinité de la clé retient p2.
    const first = occupy("p1");
    await api(env.app).post("/v1/chat/completions").send(chatBody());
    expect(preferredProvider("env-bootstrap")).toBe("p2");
    release(first);
    expect(mock.calls).toHaveLength(1);

    // 2. les DEUX étapes sont saturées : l'appel doit patienter.
    occupy("p1");
    const p2Slot = occupy("p2");
    const pending = api(env.app).post("/v1/chat/completions").send(chatBody()).then((r) => r);
    await sleep(80);
    expect(mock.calls).toHaveLength(1); // toujours rien : il attend

    // 3. Une place se libère chez p2 (l'affinité), PAS chez le principal.
    release(p2Slot);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1].url).toContain("p2.example"); // jamais p1

    // Journal : deux étapes sautées pour charge, puis la tentative en attente.
    const last = readLog().slice(-3);
    expect(last[0]).toMatchObject({ result: "skipped", reason: "saturated", provider: "p2" });
    expect(last[2]).toMatchObject({ result: "ok", provider: "p2", affinity: true });
  });

  it("sans historique pour la clé → attend sur le PRINCIPAL", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    expect(preferredProvider("env-bootstrap")).toBeNull(); // aucune affinité

    occupy("p2");
    const p1Slot = occupy("p1");
    const pending = api(env.app).post("/v1/chat/completions").send(chatBody()).then((r) => r);
    await sleep(80);
    expect(mock.calls).toHaveLength(0); // les deux étapes sont pleines : il attend

    release(p1Slot); // le PRINCIPAL est celui qu'on attend
    const res = await pending;
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example");
  });
});

describe("rolling — hors mode rolling, comportement INCHANGÉ", () => {
  it("rolling:false → file d'attente normale, aucune étape sautée pour charge", async () => {
    await seedChain(false);
    mock = installMockFetch((url) =>
      url.includes("p1.example")
        ? jsonResponse({ choices: [{ message: { content: "p1 après attente" } }] })
        : jsonResponse({ choices: [{ message: { content: "jamais p2" } }] }),
    );

    const p1Slot = occupy("p1");
    const pending = api(env.app).post("/v1/chat/completions").send(chatBody()).then((r) => r);
    await sleep(80);
    // Il PATIENTE sur le principal (file d'attente), il ne saute pas au repli.
    expect(mock.calls).toHaveLength(0);
    expect(llmSlots.getStats().queued).toBe(1);

    release(p1Slot);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("p1 après attente");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example");
    // Aucune trace de bascule pour charge.
    expect(readLog().some((e) => e.reason === "saturated")).toBe(false);
  });

  it("le champ `rolling` est accepté et relu par l'API des services", async () => {
    await seedChain(true);
    const res = await api(env.app).get("/api/services");
    const chat = res.body.services.find((s: { name: string }) => s.name === "chat");
    expect(chat.rolling).toBe(true);

    const off = await api(env.app).put("/api/services/chat").send({ rolling: false });
    expect(off.status).toBe(200);
    expect(off.body.service.rolling).toBe(false);

    const bad = await api(env.app).put("/api/services/chat").send({ rolling: "oui" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("rolling");
  });
});

describe("rolling — visibilité", () => {
  it("le tableau de bord compte les sauts pour charge et les reprises par affinité", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const first = occupy("p1");
    await api(env.app).post("/v1/chat/completions").send(chatBody()); // skip p1 → p2 (affinité)
    release(first);
    await api(env.app).post("/v1/chat/completions").send(chatBody()); // p2 repris par affinité

    const dash = await api(env.app).get("/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.activity.loadFallbacks).toBe(1);
    expect(dash.body.activity.affinityHits).toBe(1);
    // Les blocs historiques restent intacts.
    expect(typeof dash.body.activity.fallbacks).toBe("number");
    expect(Array.isArray(dash.body.recent)).toBe(true);
    expect(Array.isArray(dash.body.byKey)).toBe(true);
    await waitFor(() => dash.body.live !== undefined);
  });
});
