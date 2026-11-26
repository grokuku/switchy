/**
 * Suppression d'un SERVICE — contrat serveur ↔ interface. Aucun réseau réel.
 *
 * Bug signalé : supprimer un service affichait un toast d'erreur JSON alors que
 * la suppression RÉUSSISSAIT, et la carte restait à l'écran jusqu'au
 * rafraîchissement de la page.
 *
 * Cause : `DELETE /api/services/:name` répond **204 sans corps**
 * (`src/routes/services.ts`) ; la brique fetch vendorisée
 * (`public/vendor/holaf/holaf-fetch.js`, `parseResponse`) exige un
 * `Content-Type: application/json` et lève « réponse non-JSON » même sur un
 * statut 2xx → `apiRequest` rejetait, donc (a) toast d'erreur et (b) le
 * `loadServices()` placé après le `await` n'était jamais atteint.
 *
 * Ce fichier fige :
 *   [1] le contrat de la route (204 vide ; 404 JSON sur service inconnu) ;
 *   [2] la suppression RÉELLE dans `catalog.json` (pas seulement à l'écran) ;
 *   [3] le comportement de l'interface sur un 204 VIDE (aucun toast d'erreur,
 *       carte retirée, liste rechargée) — exécuté dans un bac à sable avec la
 *       VRAIE brique fetch vendorisée ;
 *   [4] la non-régression d'un DELETE 200 avec corps JSON ;
 *   [5] la tolérance NE DOIT PAS avaler un vrai échec (4xx/5xx, page HTML).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";
import { HolafFetch } from "../public/vendor/holaf/holaf-fetch.js";
import { makeTestEnv, installMockFetch, jsonResponse, createApiKey, type TestEnv } from "./helpers.js";

let env: TestEnv;
let key: string;
let js: string;

beforeEach(async () => {
  env = makeTestEnv();
  key = await createApiKey(env.app);
  js = (await request(env.app).get("/app.js")).text;
});

afterEach(() => env.cleanup());

const auth = (r: request.Test) => r.set("X-API-Key", key);

const validProvider = (over = {}) => ({
  id: "ollama-cloud",
  label: "Ollama Cloud",
  type: "openai-compatible",
  baseUrl: "https://ollama.com/v1",
  nativeUrl: "https://ollama.com/api",
  apiKey: "sk-secret-123",
  enabled: true,
  ...over,
});

const validService = (over = {}) => ({
  name: "Deepseek-Fast",
  description: "Rapide, bon marché",
  principal: { providerId: "ollama-cloud", model: "deepseek-v3", reasoning: "off" },
  fallbacks: [],
  contextWindow: 128000,
  maxOutputTokens: 8192,
  vision: false,
  prioritaire: false,
  enabled: true,
  ...over,
});

/** Crée le fournisseur + le service de référence. */
async function seed(): Promise<void> {
  const p = await auth(request(env.app).post("/api/providers")).send(validProvider());
  if (p.status !== 201) throw new Error(`seed provider: ${p.status}`);
  const s = await auth(request(env.app).post("/api/services")).send(validService());
  if (s.status !== 201) throw new Error(`seed service: ${s.status}`);
}

// ════════════════════════════════════════════════════════════════════════════
// [1][2] Contrat de la route DELETE
// ════════════════════════════════════════════════════════════════════════════

describe("[1][2] DELETE /api/services/:name — contrat & persistance", () => {
  it("204 SANS corps, et le service a RÉELLEMENT disparu de catalog.json", async () => {
    await seed();
    const files = join(env.dir, "catalog.json");
    expect(JSON.parse(readFileSync(files, "utf-8")).services).toHaveLength(1);

    const del = await auth(request(env.app).delete("/api/services/Deepseek-Fast"));
    expect(del.status).toBe(204);
    // Succès SANS corps : c'est ce que l'interface doit savoir tolérer.
    expect(del.text).toBe("");
    expect(del.headers["content-type"]).toBeUndefined();

    // Le FICHIER est la source de vérité : plus aucun service, fournisseur intact.
    const raw = JSON.parse(readFileSync(files, "utf-8"));
    expect(raw.services).toEqual([]);
    expect(raw.providers).toHaveLength(1);

    // Et le cache/API ne ressert pas un service fantôme.
    const list = await auth(request(env.app).get("/api/services"));
    expect(list.body.services).toEqual([]);
  });

  it("service inexistant → 404 JSON propre (jamais un 500 ni un corps vide)", async () => {
    const res = await auth(request(env.app).delete("/api/services/Fantome"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toContain("Fantome");
  });

  it("le fournisseur référencé n'est PAS supprimé au passage", async () => {
    await seed();
    await auth(request(env.app).delete("/api/services/Deepseek-Fast"));
    const providers = await auth(request(env.app).get("/api/providers"));
    expect(providers.body.providers).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bac à sable : le VRAI script servi, la VRAIE brique fetch vendorisée
// ════════════════════════════════════════════════════════════════════════════

/** Bloc `{ … }` équilibré à partir de son accolade ouvrante. */
function braceBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("bloc non équilibré");
}

/** Source complète de `(async) function nom(...) { … }` du script servi. */
function fnSource(source: string, name: string): string {
  // ⚠️ Le préfixe `async ` fait partie de la déclaration : l'omettre produit un
  // corps contenant `await` hors fonction asynchrone (SyntaxError).
  const found = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!found) throw new Error(`fonction absente du script servi : ${name}`);
  const start = found.index;
  const open = source.indexOf("{", start);
  return source.slice(start, open) + braceBlock(source, open);
}

/** Rend une fonction du script servi exécutable avec des dépendances explicites. */
function sandbox<T>(name: string, deps: Record<string, unknown>): T {
  const src = fnSource(js, name);
  const names = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(...names, `${src}\n; return ${name};`);
  return factory(...names.map((n) => deps[n])) as T;
}

/** 204 « No Content » : ni corps, ni `Content-Type` — la réponse réelle du serveur. */
const noContent = () => new Response(null, { status: 204 });

interface DeleteHarness {
  apiRequest: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  run: (service: { name: string }) => Promise<void>;
  logs: {
    toasts: Array<{ message: string; type?: string }>;
    errors: Array<{ message: string; status?: number }>;
    renders: number;
    reloads: number;
    services: Array<{ name: string }>;
  };
}

/** Monte `apiRequest` + `deleteService` du script servi, brique fetch réelle. */
function harness(initial: Array<{ name: string }> = [{ name: "Deepseek-Fast" }]): DeleteHarness {
  const logs: DeleteHarness["logs"] = { toasts: [], errors: [], renders: 0, reloads: 0, services: initial.slice() };
  const state: { csrfToken: string; services: Array<{ name: string }> } = {
    csrfToken: "csrf-test",
    services: initial.slice(),
  };
  const notify = (message: string, type?: string) => {
    logs.toasts.push({ message, type });
  };
  const handleApiError = (err: Error & { status?: number }, fallback?: string) => {
    logs.errors.push({ message: (err && err.message) || String(fallback), status: err && err.status });
    if (!(err && err.message) && fallback) notify(fallback, "error");
  };
  const apiRequest = sandbox<DeleteHarness["apiRequest"]>("apiRequest", {
    http: HolafFetch,
    state,
    nativeRequest: () => {
      throw new Error("repli natif non utilisé dans ce test");
    },
  });
  const deleteService = sandbox<(s: { name: string }) => Promise<void>>("deleteService", {
    confirmAction: async () => true,
    apiRequest,
    handleApiError,
    clearStepTests: () => {},
    state,
    renderServices: () => {
      logs.renders += 1;
      logs.services = state.services.slice();
    },
    loadServices: async () => {
      logs.reloads += 1;
    },
    notify,
  });
  return { apiRequest, run: (s) => deleteService(s), logs };
}

// ════════════════════════════════════════════════════════════════════════════
// [3] L'interface sur un 204 VIDE — le bug signalé
// ════════════════════════════════════════════════════════════════════════════

describe("[3] DELETE 204 sans corps → succès, pas de toast d'erreur, carte retirée", () => {
  it("`apiRequest` résout (corps vide) au lieu de lever « réponse non-JSON »", async () => {
    const mock = installMockFetch(() => noContent());
    try {
      const h = harness();
      await expect(
        h.apiRequest("/api/services/Deepseek-Fast", { method: "DELETE" }),
      ).resolves.toBeNull();
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].init.method).toBe("DELETE");
      // Le jeton CSRF accompagne bien la mutation.
      expect(mock.calls[0].init.headers?.["X-CSRF-Token"]).toBe("csrf-test");
    } finally {
      mock.restore();
    }
  });

  it("`deleteService` : AUCUN toast d'erreur, la carte disparaît, la liste est rechargée", async () => {
    const mock = installMockFetch(() => noContent());
    try {
      const h = harness();
      await h.run({ name: "Deepseek-Fast" });

      expect(h.logs.errors).toEqual([]);
      const messages = h.logs.toasts.map((t) => t.message).join(" | ");
      expect(messages).not.toMatch(/non-JSON|illisible|Erreur|erreur/i);
      expect(messages).toContain("supprimé");

      // Re-rendu AVANT le rechargement : la carte ne peut pas rester.
      expect(h.logs.renders).toBeGreaterThan(0);
      expect(h.logs.services.map((s) => s.name)).not.toContain("Deepseek-Fast");
      expect(h.logs.reloads).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("même si le rechargement de la liste échoue, la carte reste retirée et le toast est un succès", async () => {
    const mock = installMockFetch((url, init) => {
      if (init.method === "DELETE") return noContent();
      return jsonResponse({ error: "panne" }, { status: 500 });
    });
    try {
      const h = harness();
      // `loadServices` réel : le rechargement échoue (500) mais ne doit rien casser.
      const state = { services: [{ name: "Deepseek-Fast" }] };
      const notify = (message: string, type?: string) => h.logs.toasts.push({ message, type });
      const handleApiError = (err: Error & { status?: number }) =>
        h.logs.errors.push({ message: err.message, status: err.status });
      const apiRequest = sandbox<DeleteHarness["apiRequest"]>("apiRequest", {
        http: HolafFetch,
        state,
        nativeRequest: () => {
          throw new Error("repli natif non utilisé dans ce test");
        },
      });
      const loadServices = sandbox<() => Promise<void>>("loadServices", {
        apiRequest,
        state,
        handleApiError,
        renderServices: () => {
          h.logs.renders += 1;
        },
      });
      const deleteService = sandbox<(s: { name: string }) => Promise<void>>("deleteService", {
        confirmAction: async () => true,
        apiRequest,
        handleApiError,
        clearStepTests: () => {},
        state,
        renderServices: () => {
          h.logs.renders += 1;
          h.logs.services = state.services.slice();
        },
        loadServices,
        notify,
      });

      await deleteService({ name: "Deepseek-Fast" });

      expect(h.logs.toasts.some((t) => t.message.includes("supprimé"))).toBe(true);
      expect(state.services.map((s) => s.name)).not.toContain("Deepseek-Fast");
      expect(h.logs.renders).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [4] Non-régression : DELETE 200 avec corps JSON
// ════════════════════════════════════════════════════════════════════════════

describe("[4] DELETE 200 avec corps JSON → même résultat", () => {
  it("`apiRequest` rend le corps JSON et `deleteService` se comporte pareil", async () => {
    let deleted = false;
    const mock = installMockFetch(() => {
      deleted = true;
      return jsonResponse({ ok: true, service: { name: "Deepseek-Fast" } });
    });
    try {
      const h = harness();
      const body = await h.apiRequest("/api/services/Deepseek-Fast", { method: "DELETE" });
      expect(body).toEqual({ ok: true, service: { name: "Deepseek-Fast" } });
      expect(deleted).toBe(true);

      await h.run({ name: "Deepseek-Fast" });
      expect(h.logs.errors).toEqual([]);
      expect(h.logs.toasts.map((t) => t.message).join(" ")).toContain("supprimé");
      expect(h.logs.services.map((s) => s.name)).not.toContain("Deepseek-Fast");
    } finally {
      mock.restore();
    }
  });

  it("aucun corps sur un 200 est aussi un succès (null)", async () => {
    const mock = installMockFetch(() => new Response("", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      const h = harness();
      await expect(h.apiRequest("/api/services/X", { method: "DELETE" })).resolves.toBeNull();
    } finally {
      mock.restore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [5] La tolérance n'avale PAS un vrai échec
// ════════════════════════════════════════════════════════════════════════════

describe("[5] la tolérance du corps vide ne masque aucun échec", () => {
  it("404 JSON → l'erreur remonte (et `deleteService` affiche l'erreur, garde la carte)", async () => {
    const mock = installMockFetch(() =>
      jsonResponse({ error: 'service "Fantome" not found', code: "NOT_FOUND" }, { status: 404 }),
    );
    try {
      const h = harness([{ name: "Fantome" }]);
      await h.run({ name: "Fantome" });
      expect(h.logs.errors).toHaveLength(1);
      expect(h.logs.errors[0].status).toBe(404);
      expect(h.logs.toasts.map((t) => t.message).join(" ")).not.toContain("supprimé");
      // Échec : la carte n'est pas retirée (l'écran ne ment jamais).
      expect(h.logs.services.map((s) => s.name)).toContain("Fantome");
    } finally {
      mock.restore();
    }
  });

  it("500 HTML (proxy) → l'erreur remonte, elle n'est pas traduite en succès", async () => {
    const mock = installMockFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    try {
      const h = harness();
      await expect(h.apiRequest("/api/services/X", { method: "DELETE" })).rejects.toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("200 JSON illisible (corps non vide) → l'erreur remonte", async () => {
    const mock = installMockFetch(
      () => new Response("<<tronqué", { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const h = harness();
      await expect(h.apiRequest("/api/services/X", { method: "GET" })).rejects.toBeTruthy();
    } finally {
      mock.restore();
    }
  });
});
