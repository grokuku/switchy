/**
 * Niveau de réflexion — correspondance niveau interne → `reasoning_effort`,
 * injection dans le corps sortant (règle : Switchy IMPOSE), garde-fou du rôle
 * `developer` pour Ollama. AUCUN accès réseau (`fetch` mocké pour la partie API).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildUpstreamBody } from "../src/llm/relay.js";
import {
  isOllamaProvider,
  normalizeMessagesForProvider,
  normalizeReasoningLevel,
  reasoningWireValue,
} from "../src/llm/reasoning.js";
import type { ProviderRecord, ReasoningLevel, ServiceStep } from "../src/catalog-store.js";
import {
  api,
  makeTestEnv,
  installMockFetch,
  seedProvider,
  seedService,
  jsonResponse,
  type TestEnv,
} from "./helpers.js";

function provider(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "p",
    label: "P",
    type: "openai-compatible",
    baseUrl: "https://p.example/v1",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}
function stepS(reasoning: ReasoningLevel, model = "m"): ServiceStep {
  return { providerId: "p", model, reasoning };
}

describe("correspondance niveau → reasoning_effort", () => {
  it("off → \"none\" (seule valeur qui coupe réellement), jamais \"off\"", () => {
    expect(reasoningWireValue("off", provider())).toBe("none");
    expect(reasoningWireValue("off", provider({ type: "ollama-native" }))).toBe("none");
  });

  it("OpenAI-compatible : identité (le niveau vient de la détection)", () => {
    expect(reasoningWireValue("low", provider())).toBe("low");
    expect(reasoningWireValue("medium", provider())).toBe("medium");
    expect(reasoningWireValue("max", provider())).toBe("max");
  });

  it("Ollama : les niveaux non déclarés sont repliés sur le plus proche (jamais inventés)", () => {
    const ollama = provider({ type: "ollama-native" });
    expect(reasoningWireValue("minimal", ollama)).toBe("low");
    expect(reasoningWireValue("medium", ollama)).toBe("high");
    expect(reasoningWireValue("xhigh", ollama)).toBe("high");
    expect(reasoningWireValue("high", ollama)).toBe("high");
    expect(reasoningWireValue("max", ollama)).toBe("max");
  });

  it("normalise les synonymes d'extinction et détecte les fournisseurs Ollama", () => {
    expect(normalizeReasoningLevel("NONE")).toBe("off");
    expect(normalizeReasoningLevel(" disabled ")).toBe("off");
    expect(normalizeReasoningLevel("MAX")).toBe("max");
    expect(normalizeReasoningLevel("bidon")).toBeNull();
    expect(isOllamaProvider({ type: "ollama-native" })).toBe(true);
    expect(isOllamaProvider({ baseUrl: "https://ollama.com/v1" })).toBe(true);
    expect(isOllamaProvider({ baseUrl: "http://127.0.0.1:11434/v1" })).toBe(true);
    expect(isOllamaProvider({ baseUrl: "https://api.deepseek.com/v1" })).toBe(false);
  });
});

describe("buildUpstreamBody — Switchy IMPOSE le niveau du service", () => {
  it("pose reasoning_effort depuis step.reasoning même si le client en fournit un (écrasement)", () => {
    const out = buildUpstreamBody(
      { model: "client-model", reasoning_effort: "low", messages: [] },
      stepS("high", "service-model"),
      provider(),
    );
    expect(out.model).toBe("service-model");
    expect(out.reasoning_effort).toBe("high"); // client écrasé
  });

  it("off → \"none\" imposé (contrôle fantôme évité)", () => {
    const out = buildUpstreamBody({ messages: [] }, stepS("off"), provider());
    expect(out.reasoning_effort).toBe("none");
  });

  it("mode pass-through : aucun niveau de service → le corps client est intact", () => {
    const body = { reasoning_effort: "medium", messages: [] } as Record<string, unknown>;
    const out = buildUpstreamBody(body, stepS(undefined as unknown as ReasoningLevel), provider());
    expect(out.reasoning_effort).toBe("medium"); // non touché
  });

  it("neutralise le rôle developer pour Ollama, le conserve ailleurs", () => {
    const msgs = [{ role: "developer", content: "sys" }, { role: "user", content: "x" }];
    const ollama = buildUpstreamBody({ messages: msgs }, stepS("off"), provider({ type: "ollama-native" }));
    expect((ollama.messages as Array<Record<string, unknown>>)[0].role).toBe("system");
    const generic = buildUpstreamBody({ messages: msgs }, stepS("off"), provider());
    expect((generic.messages as Array<Record<string, unknown>>)[0].role).toBe("developer");
    // Rien à changer → aucune réécriture (mêmes références).
    expect(normalizeMessagesForProvider([{ role: "user" }], provider({ type: "ollama-native" }))).toBeUndefined();
  });
});

// ── Intégration via l'API (fetch mocké) ──

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

function sentBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse(mock!.calls[callIndex].init.body ?? "{}") as Record<string, unknown>;
}

describe("relais — injection effective du niveau de réflexion", () => {
  it("le corps envoyé au fournisseur contient le niveau du service (écrase le client)", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "P1",
      type: "openai-compatible",
      baseUrl: "https://p1.example/v1",
    });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: { providerId: "p1", model: "m", reasoning: "high" },
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    await api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [], reasoning_effort: "low" });
    expect(sentBody().reasoning_effort).toBe("high");
  });

  it("le niveau du repli est appliqué à SA tentative", async () => {
    await seedProvider(env.app, { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://p1.example/v1" });
    await seedProvider(env.app, { id: "p2", label: "P2", type: "openai-compatible", baseUrl: "https://p2.example/v1" });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: { providerId: "p1", model: "a", reasoning: "off" },
      fallbacks: [{ providerId: "p2", model: "b", reasoning: "max" }],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch((url) =>
      url.includes("p1.example")
        ? jsonResponse({ error: "boom" }, { status: 500 })
        : jsonResponse({ choices: [] }),
    );

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(200);
    expect(sentBody(0).reasoning_effort).toBe("none"); // principal « off »
    expect(sentBody(1).reasoning_effort).toBe("max"); // repli « max »
  });

  it("Ollama : le rôle developer est converti en system avant l'envoi", async () => {
    await seedProvider(env.app, {
      id: "ollama",
      label: "Ollama",
      type: "ollama-native",
      baseUrl: "https://ollama.example/v1",
      nativeUrl: "https://ollama.example",
    });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: { providerId: "ollama", model: "qwen3", reasoning: "high" },
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    await api(env.app)
      .post("/api/llm/chat")
      .send({ messages: [{ role: "developer", content: "sys" }, { role: "user", content: "x" }] });
    const messages = sentBody().messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe("system");
    expect(sentBody().reasoning_effort).toBe("high");
  });

  it("le niveau « max » est accepté par la validation du catalogue", async () => {
    await seedProvider(env.app, { id: "p1", label: "P1", type: "openai-compatible", baseUrl: "https://p1.example/v1" });
    const res = await api(env.app).post("/api/services").send({
      name: "svc-max",
      description: "",
      principal: { providerId: "p1", model: "m", reasoning: "max" },
      fallbacks: [],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.service.principal.reasoning).toBe("max");
  });
});
