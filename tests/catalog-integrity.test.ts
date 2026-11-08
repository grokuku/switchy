/**
 * [2] catalogue illisible + [5] écriture non sérialisée / état fantôme.
 *
 * Règle figée ici : un `catalog.json` PRÉSENT mais illisible est une ERREUR
 * (503 `CATALOG_UNREADABLE`) — jamais un catalogue vide. Un fichier ABSENT
 * reste légitime (premier lancement).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, makeTestEnv, type TestEnv } from "./helpers.js";
import { resetCatalogCache, runCatalogMutation, listProviders } from "../src/catalog-store.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  env.cleanup();
  vi.restoreAllMocks();
});

const provider = (id: string) => ({
  id,
  label: `Fournisseur ${id}`,
  type: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
});

const catalogPath = () => join(env.dir, "catalog.json");

describe("[2] catalog.json illisible", () => {
  it("un fichier absent reste toléré (catalogue vide légitime)", async () => {
    const res = await api(env.app).get("/api/services");
    expect(res.status).toBe(200);
    expect(res.body.services).toEqual([]);
  });

  it("fichier présent mais illisible → 503 CATALOG_UNREADABLE, AUCUNE écriture", async () => {
    expect((await api(env.app).post("/api/providers").send(provider("a"))).status).toBe(201);
    const corrupt = '{"providers":[{"id":"a"';
    writeFileSync(catalogPath(), corrupt);
    resetCatalogCache();

    const read = await api(env.app).get("/api/services");
    expect(read.status).toBe(503);
    expect(read.body.code).toBe("CATALOG_UNREADABLE");

    const write = await api(env.app).post("/api/providers").send(provider("b"));
    expect(write.status).toBe(503);
    expect(write.body.code).toBe("CATALOG_UNREADABLE");

    // Le fichier est INTACT (aucune écriture tentée) et aucun temporaire créé.
    expect(readFileSync(catalogPath(), "utf-8")).toBe(corrupt);
    expect(existsSync(`${catalogPath()}.tmp`)).toBe(false);
  });
});

describe("[5] mutations sérialisées et sans état fantôme", () => {
  it("un échec d'écriture ne laisse jamais servir l'état muté", async () => {
    expect((await api(env.app).post("/api/providers").send(provider("a"))).status).toBe(201);
    // Le tmp devient un RÉPERTOIRE ⇒ l'écriture atomique échoue (EISDIR).
    mkdirSync(`${catalogPath()}.tmp`);

    const failed = await api(env.app).post("/api/providers").send(provider("b"));
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("STORAGE_NOT_WRITABLE");

    // Sans `cache = null` avant écriture, l'objet muté restait en cache et
    // « b » apparaissait comme persisté (état fantôme).
    const list = await api(env.app).get("/api/providers");
    expect(list.status).toBe(200);
    expect(list.body.providers.map((p: { id: string }) => p.id)).toEqual(["a"]);
    expect(listProviders().map((p) => p.id)).toEqual(["a"]);
    expect(JSON.parse(readFileSync(catalogPath(), "utf-8")).providers.map((p: { id: string }) => p.id)).toEqual([
      "a",
    ]);
  });

  it("runCatalogMutation exécute les mutations une par une (FIFO)", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runCatalogMutation(async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    const second = runCatalogMutation(() => {
      order.push("b");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["a-start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
