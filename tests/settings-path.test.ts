/**
 * [9] Réglages de type `path` CONFINÉS au répertoire de données.
 *
 * `SWITCHY_KEYS_FILE`, `SWITCHY_CATALOG_FILE` et `SWITCHY_CALLS_LOG_FILE` sont
 * éditables par `POST /api/settings` : sans confinement, une clé d'API (ou une
 * session) faisait écrire un JSON contrôlé en 0600 + `rename` N'IMPORTE OÙ.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { api, makeTestEnv, type TestEnv } from "./helpers.js";
import { validateSettingValue, getSettingSpec, resolveSetting } from "../src/settings-store.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => {
  env.cleanup();
});

describe("[9] chemins de réglages confinés", () => {
  it("hors du répertoire de données → 403 PATH_OUTSIDE_DATA_DIR, rien n'est écrit", async () => {
    const res = await api(env.app)
      .post("/api/settings")
      .send({ settings: { SWITCHY_CATALOG_FILE: "/tmp/switchy-evil/catalog.json" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PATH_OUTSIDE_DATA_DIR");
    expect(existsSync("/tmp/switchy-evil/catalog.json")).toBe(false);
  });

  it("évasion par `..` → refus", async () => {
    const res = await api(env.app)
      .post("/api/settings")
      .send({ settings: { SWITCHY_KEYS_FILE: join(env.dir, "..", "keys-ailleurs.json") } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PATH_OUTSIDE_DATA_DIR");
  });

  it("un chemin DANS le répertoire de données est accepté et résolu en absolu", async () => {
    const inside = join(env.dir, "sous-dossier", "catalog.json");
    const res = await api(env.app).post("/api/settings").send({ settings: { SWITCHY_CATALOG_FILE: inside } });
    expect(res.status).toBe(200);
    expect(res.body.updated).toContain("SWITCHY_CATALOG_FILE");
    expect(resolveSetting("SWITCHY_CATALOG_FILE", "")).toBe(inside);
  });

  it("validateSettingValue refuse un chemin relatif qui sort du répertoire", () => {
    const spec = getSettingSpec("SWITCHY_CALLS_LOG_FILE")!;
    const outside = validateSettingValue(spec, "../ailleurs.json");
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("PATH_OUTSIDE_DATA_DIR");

    const inside = validateSettingValue(spec, join(env.dir, "calls.jsonl"));
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.value).toBe(join(env.dir, "calls.jsonl"));
  });
});
