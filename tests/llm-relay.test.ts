/**
 * Relais LLM (Lot 3) — résolution du service, principal → replis, pass-through
 * fidèle, streaming SSE, journalisation des tentatives. AUCUN accès réseau :
 * `globalThis.fetch` est mocké.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
  sseResponse,
  waitFor,
  TEST_API_KEY,
  type TestEnv,
} from "./helpers.js";
import { instrumentStream } from "../src/llm/relay.js";

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

/** Provider `p1` + service `chat` (principal p1/model-a, sans repli). */
async function seedChat(overrides: Record<string, unknown> = {}): Promise<void> {
  await seedProvider(env.app, {
    id: "p1",
    label: "Fournisseur 1",
    type: "openai-compatible",
    baseUrl: "https://p1.example/v1",
    apiKey: "sk-SECRET_P1",
  });
  await seedService(env.app, {
    name: "chat",
    description: "service de test",
    principal: step("p1", "model-a"),
    fallbacks: [],
    contextWindow: 8000,
    maxOutputTokens: 1000,
    vision: false,
    enabled: true,
    ...overrides,
  });
}

function readLog(): Array<Record<string, unknown>> {
  const file = join(env.dir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("relais — principal, fidélité, tool-calling", () => {
  it("relaie le principal : statut, corps, en-tête utile, clé du fournisseur", async () => {
    await seedChat();
    mock = installMockFetch(() =>
      jsonResponse(
        { id: "cmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "salut" } }] },
        { headers: { "x-request-id": "req-42" } },
      ),
    );

    const res = await api(env.app)
      .post("/api/llm/chat")
      .send({ model: "ignoré", messages: [{ role: "user", content: "bonjour" }], stream: false });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("salut");
    expect(res.headers["x-request-id"]).toBe("req-42");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://p1.example/v1/chat/completions");
    expect(mock.calls[0].init.headers?.authorization).toBe("Bearer sk-SECRET_P1");
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("model-a");
    expect(sent.messages).toEqual([{ role: "user", content: "bonjour" }]);
  });

  it("POST /v1/chat/completions : `model` = nom du service ; modèle absent → 400", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const ok = await api(env.app)
      .post("/v1/chat/completions")
      .send({ model: "chat", messages: [{ role: "user", content: "bonjour" }] });
    expect(ok.status).toBe(200);
    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("model-a");

    const missing = await api(env.app).post("/v1/chat/completions").send({ messages: [] });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");
  });

  it("pass-through des champs inconnus MAIS le niveau de réflexion du SERVICE écrase celui du client", async () => {
    await seedChat();
    mock = installMockFetch(() => jsonResponse({ choices: [] }));

    const body = {
      model: "chat",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      tool_choice: "auto",
      reasoning_effort: "high",
      extra_personnalise: { imbrique: [1, 2, 3] },
    };
    const res = await api(env.app).post("/api/llm/chat").send(body);
    expect(res.status).toBe(200);

    const sent = JSON.parse(mock.calls[0].init.body ?? "{}") as Record<string, unknown>;
    expect(sent.model).toBe("model-a"); // remplacé par le modèle de l'étape
    expect(sent.tools).toEqual(body.tools);
    expect(sent.tool_choice).toBe("auto");
    // Règle d'arbitrage : Switchy IMPOSE le niveau du service (ici « off » →
    // "none", valeur qui coupe réellement la réflexion) et ÉCRASE le client.
    expect(sent.reasoning_effort).toBe("none");
    expect(sent.extra_personnalise).toEqual({ imbrique: [1, 2, 3] });
  });
});

describe("relais — chaîne de replis", () => {
  it("principal 500 → repli : réponse du repli + journal des DEUX tentatives (rang)", async () => {
    await seedProvider(env.app, {
      id: "p2",
      label: "Fournisseur 2",
      type: "openai-compatible",
      baseUrl: "https://p2.example/v1",
      apiKey: "sk-p2",
    });
    await seedChat({ fallbacks: [step("p2", "model-b")] });
    mock = installMockFetch((url) =>
      url.includes("p1.example")
        ? jsonResponse({ error: "boom" }, { status: 500 })
        : jsonResponse({ choices: [{ message: { content: "secours" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    );

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("secours");
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://p1.example/v1/chat/completions",
      "https://p2.example/v1/chat/completions",
    ]);

    const log = readLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ service: "chat", attempt: 0, provider: "p1", model: "model-a", result: "error", status: 500 });
    expect(log[1]).toMatchObject({ service: "chat", attempt: 1, provider: "p2", model: "model-b", result: "ok", status: 200 });
    expect(typeof log[0].durationMs).toBe("number");
  });

  it("400 (requête invalide) → PAS de repli, le corps du fournisseur est relayé tel quel", async () => {
    await seedProvider(env.app, {
      id: "p2",
      label: "Fournisseur 2",
      type: "openai-compatible",
      baseUrl: "https://p2.example/v1",
    });
    await seedChat({ fallbacks: [step("p2", "model-b")] });
    mock = installMockFetch(() => jsonResponse({ error: { message: "bad request" }, code: "invalid" }, { status: 400 }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "bad request" }, code: "invalid" });
    expect(mock.calls).toHaveLength(1);
  });

  it("fournisseur désactivé → étape « skipped » journalisée, repli tenté", async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "Fournisseur 1 (désactivé)",
      type: "openai-compatible",
      baseUrl: "https://p1.example/v1",
      enabled: false,
    });
    await seedProvider(env.app, {
      id: "p2",
      label: "Fournisseur 2",
      type: "openai-compatible",
      baseUrl: "https://p2.example/v1",
    });
    await seedService(env.app, {
      name: "chat",
      description: "",
      principal: step("p1", "model-a"),
      fallbacks: [step("p2", "model-b")],
      contextWindow: 8000,
      maxOutputTokens: 1000,
      vision: false,
      enabled: true,
    });
    mock = installMockFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [] });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("p2.example");

    const log = readLog();
    expect(log[0]).toMatchObject({ attempt: 0, provider: "p1", result: "skipped", error: "provider_disabled" });
    expect(log[1]).toMatchObject({ attempt: 1, provider: "p2", result: "ok" });
  });

  it("service inconnu → 404 NOT_FOUND", async () => {
    mock = installMockFetch(() => jsonResponse({}));
    const res = await api(env.app).post("/api/llm/inconnu").send({ messages: [] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("relais — streaming SSE", () => {
  it("streame les morceaux tels quels (réflexion et contenu séparés) et journalise l'usage", async () => {
    await seedChat();
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "je réfléchis" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "bonjour" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    mock = installMockFetch(() => sseResponse(chunks));

    const res = await api(env.app).post("/api/llm/chat").send({ messages: [], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Le client reçoit EXACTEMENT les morceaux émis, dans l'ordre — aucune
    // fusion réflexion/contenu, aucune re-sérialisation.
    expect(res.text).toBe(chunks.join(""));

    const log = readLog();
    expect(log[0]).toMatchObject({
      service: "chat",
      result: "ok",
      stream: true,
      tokens: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
    });
  });

  it("instrumentStream relaie chaque morceau dès son entrée, sans attendre la fermeture", async () => {
    const encoder = new TextEncoder();
    let sourceController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(encoder.encode("data: un\n\n"));
      },
    });
    const reports: Array<{ aborted: boolean; usage?: unknown; bytes: number }> = [];
    const relayed = instrumentStream(source, () => false, (report) => reports.push(report));
    const reader = relayed.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: un\n\n");
    // La source est TOUJOURS ouverte : le morceau est passé sans tampon.
    expect(reports).toHaveLength(0);

    sourceController!.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n'));
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("prompt_tokens");

    sourceController!.close();
    const end = await reader.read();
    expect(end.done).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].usage).toEqual({ promptTokens: 1, completionTokens: 2 });
    expect(reports[0].aborted).toBe(false);
  });

  it("annulation client : le flux amont est coupé (signal) et la tentative est journalisée « aborted »", async () => {
    await seedChat();
    let upstreamAborted = false;
    mock = installMockFetch((_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: début\n\n"));
          init.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    // Requête HTTP réelle pour pouvoir couper la connexion en plein flux.
    const server = env.app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/llm/chat",
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
          },
          (res) => {
            res.once("data", () => {
              req.destroy(); // le client coupe pendant le flux
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.write(JSON.stringify({ messages: [], stream: true }));
        req.end();
      });
    } finally {
      server.close();
    }

    await waitFor(() => upstreamAborted, 2000);
    await waitFor(() => readLog().some((entry) => entry.result === "aborted"), 2000);
    const aborted = readLog().find((entry) => entry.result === "aborted");
    expect(aborted).toMatchObject({ service: "chat", attempt: 0, provider: "p1" });
  });
});

// ── Course entre la FIN du flux amont et la FERMETURE du client ──────────────
//
// Un client SSE OpenAI-compatible (SDK `openai`, donc Pi-Web) ANNULE sa requête
// HTTP dès qu'il a lu `data: [DONE]` : la fermeture arrive alors que le relais
// n'a pas encore observé `done` sur le flux amont et que `res.end()` n'a pas eu
// lieu. Sans le drapeau `upstreamEnded`, l'appel était classé
// `aborted` / `client_disconnect` alors que le client avait TOUT reçu (faux
// positif mesuré : 100 % des 267 lignes `aborted` portaient des jetons complets).
// Ces tests figent la DISTINCTION : amont TERMINÉ ⇒ `ok` ; amont EN COURS ⇒
// `aborted` + `client_disconnect` (vrai abandon, jamais masqué).

/** Amont SSE dont le TERMINATEUR est émis tôt mais la fermeture retardée. */
function tardyCloseSseResponse(closeDelayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // Le fournisseur n'a pas encore FERMÉ : le relais n'a donc pas vu `done`
        // quand le client coupe — c'est exactement la course observée en prod.
        await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
        controller.close();
      } catch {
        /* flux déjà annulé par la coupure : sans objet */
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Amont SSE ouvert que rien ne termine (aucun terminateur) : coupure = abandon. */
function unterminatedSseResponse(init: { signal?: AbortSignal }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      init.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* déjà terminé */
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Ouvre une VRAIE connexion HTTP, puis la COUPE (`req.destroy()`) dès que
 * `cutOn` est atteint — comme le fait le SDK `openai` après `[DONE]`.
 */
async function streamThenCut(cutOn: "done-marker" | "first-chunk"): Promise<string> {
  const server = env.app.listen(0);
  let received = "";
  try {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/llm/chat",
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            received += chunk.toString();
            const reached = cutOn === "done-marker" ? received.includes("[DONE]") : received.includes("data:");
            if (reached) {
              req.destroy();
              resolve();
            }
          });
          res.on("end", () => resolve());
        },
      );
      req.on("error", () => {});
      req.write(JSON.stringify({ messages: [], stream: true }));
      req.end();
    });
  } finally {
    server.close();
  }
  return received;
}

describe("flux terminé côté amont, fermeture côté client : un succès, pas un abandon", () => {
  it("A — amont déjà terminé (`[DONE]` + fermeture) puis le client coupe → result: ok, jetons conservés", async () => {
    await seedChat();
    mock = installMockFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const received = await streamThenCut("done-marker");
    expect(received).toContain("[DONE]");

    await waitFor(() => readLog().length > 0, 2000);
    const entry = readLog()[0];
    // ⚠️ Le client a TOUT reçu : la fermeture n'est pas un abandon.
    expect(entry).toMatchObject({
      service: "chat",
      result: "ok",
      stream: true,
      tokens: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
    });
    expect(entry.result).not.toBe("aborted");
    expect(entry.reason).toBeUndefined();
  });

  it("C — COURSE : `[DONE]` relayé mais amont encore OUVERT quand le client coupe → result: ok", async () => {
    await seedChat();
    // 50 ms : la fermeture amont est certainement postérieure à la coupure
    // client, donc `done` n'a PAS pu être observé avant elle.
    mock = installMockFetch(() => tardyCloseSseResponse(50));

    const received = await streamThenCut("done-marker");
    expect(received).toContain("[DONE]");

    await waitFor(() => readLog().length > 0, 2000);
    const entry = readLog()[0];
    expect(entry).toMatchObject({ result: "ok", stream: true, status: 200 });
    expect(entry.reason).toBeUndefined();
    expect(entry.tokens).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
  });

  it("B — NON-RÉGRESSION : le client coupe AU MILIEU (aucun terminateur) → aborted + client_disconnect", async () => {
    await seedChat();
    mock = installMockFetch((_url, init) => unterminatedSseResponse(init));

    await streamThenCut("first-chunk");

    await waitFor(() => readLog().length > 0, 3000);
    const entry = readLog()[0];
    // ⚠️ Vrai abandon : surtout NE PAS le maquiller en succès.
    expect(entry).toMatchObject({ result: "aborted", reason: "client_disconnect" });
    expect(entry.tokens).toBeUndefined();
  });

  it("D — le cas « coupé après [DONE] » conserve `tokens` / `usage` / `durationMs` du cas nominal", async () => {
    await seedChat();
    mock = installMockFetch(() => tardyCloseSseResponse(20));

    // 1) nominal : le client lit le flux jusqu'au bout.
    const nominal = await api(env.app).post("/api/llm/chat").send({ messages: [], stream: true });
    expect(nominal.status).toBe(200);
    await waitFor(() => readLog().length === 1, 2000);

    // 2) course : le client coupe dès `[DONE]`, amont pas encore fermé.
    await streamThenCut("done-marker");
    await waitFor(() => readLog().length === 2, 2000);

    const [complete, cut] = readLog();
    expect(complete).toMatchObject({ result: "ok", stream: true });
    expect(cut).toMatchObject({ result: "ok", stream: true });
    // Aucun champ de mesure perdu ou réinventé par le reclassement.
    expect(cut.tokens).toEqual(complete.tokens);
    expect(cut.status).toBe(complete.status);
    expect(cut.model).toBe(complete.model);
    expect(cut.error).toBeUndefined();
    expect(typeof cut.durationMs).toBe("number");
    expect(typeof complete.durationMs).toBe("number");
  });
});

describe("instrumentStream — le terminateur SSE vaut fin de l'amont", () => {
  it("terminateur relayé puis annulation du consommateur → aborted: false, octets/usage conservés", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // Jamais fermé : le lecteur ne verra pas `done` avant l'annulation.
      },
    });
    const reports: Array<{ aborted: boolean; bytes: number; usage?: unknown }> = [];
    const relayed = instrumentStream(source, () => false, (report) => reports.push(report));
    const reader = relayed.getReader();
    await reader.read(); // morceau contenant l'usage
    await reader.read(); // morceau contenant le terminateur
    await reader.cancel();

    expect(reports).toHaveLength(1);
    expect(reports[0].aborted).toBe(false);
    expect(reports[0].usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    expect(reports[0].bytes).toBe('data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'.length + "data: [DONE]\n\n".length);
  });

  it("terminateur COUPÉ entre deux morceaux → aborted: false", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DO"));
        controller.enqueue(encoder.encode("NE]\n\n"));
      },
    });
    const reports: Array<{ aborted: boolean }> = [];
    const relayed = instrumentStream(source, () => false, (report) => reports.push(report));
    const reader = relayed.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();

    expect(reports).toHaveLength(1);
    expect(reports[0].aborted).toBe(false);
  });

  it("annulation AVANT tout terminateur → aborted: true (vrai abandon préservé)", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      },
    });
    const reports: Array<{ aborted: boolean }> = [];
    const relayed = instrumentStream(source, () => false, (report) => reports.push(report));
    const reader = relayed.getReader();
    await reader.read();
    await reader.cancel();

    expect(reports).toHaveLength(1);
    expect(reports[0].aborted).toBe(true);
  });

  it("un `data: [DONE]` présent dans le CONTENU d'un message ne vaut pas fin d'amont", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\n\n'),
        );
      },
    });
    const reports: Array<{ aborted: boolean }> = [];
    const relayed = instrumentStream(source, () => false, (report) => reports.push(report));
    const reader = relayed.getReader();
    await reader.read();
    await reader.cancel();

    expect(reports).toHaveLength(1);
    expect(reports[0].aborted).toBe(true);
  });
});
