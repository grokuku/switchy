/**
 * Affinité de cache PAR CLÉ D'API (`src/llm/key-affinity.ts`).
 *
 * Verrouille la mécanique et ses garde-fous :
 *   - mémoire `keyName → { providerId, at }`, TTL FIXE de 5 minutes ;
 *   - purge paresseuse + expiration à la lecture ;
 *   - enregistrement APRÈS SUCCÈS uniquement (jamais après un échec) ;
 *   - reprise du fournisseur mémorisé SI (et seulement si) il est une étape du
 *     service, qu'une place y est libre, et que le service est en rolling ;
 *   - jamais de sortie du service, jamais de dépassement de concurrence ;
 *   - uniquement des NOMS (aucun secret) dans la réponse comme au journal.
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
import {
  KEY_AFFINITY_TTL_MS,
  affinityCount,
  forgetAffinity,
  preferredProvider,
  rememberProvider,
  resetKeyAffinity,
} from "../src/llm/key-affinity.js";

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

const KEY = "env-bootstrap"; // nom de la clé d'outil de test (jamais un secret)

function readLog(): Array<Record<string, unknown>> {
  const file = join(env.dir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

async function seedChain(rolling: boolean, extraProvider = false): Promise<void> {
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
  if (extraProvider) {
    await seedProvider(env.app, {
      id: "p3",
      label: "Hors service",
      type: "openai-compatible",
      baseUrl: "https://p3.example/v1",
      apiKey: "sk-P3_SECRET",
      maxConcurrency: 1,
    });
  }
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

const chatBody = (): Record<string, unknown> => ({
  model: "chat",
  messages: [{ role: "user", content: "bonjour" }],
});

// ── Mécanique pure (aucun réseau) ──

describe("affinité — mécanique et TTL", () => {
  it("la durée est FIXE à 5 minutes", () => {
    expect(KEY_AFFINITY_TTL_MS).toBe(5 * 60_000);
  });

  it("mémorise puis rend le fournisseur ; l'affinité EXPIRE au bout de 5 min", () => {
    const t0 = 1_000_000;
    rememberProvider("outil", "p2", t0);
    expect(preferredProvider("outil", t0)).toBe("p2");
    // Juste AVANT l'échéance : encore valable.
    expect(preferredProvider("outil", t0 + KEY_AFFINITY_TTL_MS - 1)).toBe("p2");
    // À l'échéance : expirée → le principal reprend la main.
    expect(preferredProvider("outil", t0 + KEY_AFFINITY_TTL_MS)).toBeNull();
    // L'expiration a bien purgé l'entrée.
    expect(affinityCount()).toBe(0);
  });

  it("un nom de clé vide ou absent n'a aucune affinité", () => {
    rememberProvider("", "p2");
    rememberProvider(undefined, "p2");
    expect(affinityCount()).toBe(0);
    expect(preferredProvider("")).toBeNull();
    expect(preferredProvider(undefined)).toBeNull();
  });

  it("forgetAffinity oublie une clé (et resetKeyAffinity toutes)", () => {
    rememberProvider("a", "p1");
    rememberProvider("b", "p2");
    expect(affinityCount()).toBe(2);
    forgetAffinity("a");
    expect(preferredProvider("a")).toBeNull();
    expect(preferredProvider("b")).toBe("p2");
    forgetAffinity();
    expect(affinityCount()).toBe(0);
  });
});

// ── Comportement dans la chaîne de relais ──

describe("affinité — enregistrement", () => {
  it("mémorise le fournisseur APRÈS un succès", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const slot = occupy("p1"); // force p2 à répondre
    await api(env.app).post("/v1/chat/completions").send(chatBody());
    release(slot);
    expect(preferredProvider(KEY)).toBe("p2");
  });

  it("ne mémorise RIEN après un échec (503 des deux étapes)", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ error: "boom" }, { status: 503 }));
    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());
    expect(res.status).toBe(503);
    expect(preferredProvider(KEY)).toBeNull();
  });
});

describe("affinité — reprise du fournisseur mémorisé", () => {
  it("reprend en priorité le fournisseur mémorisé (place libre, étape du service)", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    rememberProvider(KEY, "p2"); // cache chaud : p2 a déjà répondu
    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p2.example"); // p2 AVANT le principal
    expect(readLog().slice(-1)[0]).toMatchObject({ provider: "p2", attempt: 1, affinity: true });
  });

  it("IGNORÉE si le service n'est pas en rolling", async () => {
    await seedChain(false);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    rememberProvider(KEY, "p2");

    await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example"); // le principal reprend la main
    expect(readLog().some((e) => e.affinity === true)).toBe(false);
  });

  it("IGNORÉE si le fournisseur mémorisé n'est pas une étape du service", async () => {
    await seedChain(true, true); // p3 existe mais hors du service
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    rememberProvider(KEY, "p3");

    const res = await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example"); // jamais hors de la chaîne
    expect(mock.calls.some((call) => call.url.includes("p3.example"))).toBe(false);
  });

  it("IGNORÉE si aucune place n'est libre chez le fournisseur mémorisé", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    rememberProvider(KEY, "p2");
    occupy("p2"); // p2 plein, p1 libre

    await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p1.example");
    // p2 a été écarté pour CHARGE (pas pour une erreur), puis p1 a servi.
    const entries = readLog();
    expect(entries[0]).toMatchObject({ result: "skipped", provider: "p2", reason: "saturated" });
    expect(entries.slice(-1)[0]).toMatchObject({ result: "ok", provider: "p1" });
  });

  it("ne stocke aucun secret : seuls le nom de clé et le providerId sont mémorisés", async () => {
    await seedChain(true);
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await api(env.app).post("/v1/chat/completions").send(chatBody());

    expect(preferredProvider(KEY)).toBe("p1");
    // Un secret présenté comme nom de clé n'a évidemment aucune affinité.
    expect(preferredProvider("sk-P1_SECRET")).toBeNull();
    // Le journal ne contient jamais la valeur d'une clé de fournisseur.
    const raw = readFileSync(join(env.dir, "calls.jsonl"), "utf-8");
    expect(raw).not.toContain("sk-P1_SECRET");
    expect(raw).not.toContain("sk-P2_SECRET");
  });
});
