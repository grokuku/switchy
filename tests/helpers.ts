import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/index.js";
import { resetSettingsCache } from "../src/settings-store.js";
import { resetCatalogCache } from "../src/catalog-store.js";
import { resetAuthCaches } from "../src/switchy-auth.js";

export interface TestEnv {
  app: Express;
  dir: string;
  cleanup: () => void;
}

/**
 * Prépare un environnement de test isolé : répertoire de données temporaire,
 * variables SWITCHY_* nettoyées (les défauts du service s'appliquent), caches
 * mémo réinitialisés.
 *
 * Le socle n'émet AUCUNE requête sortante : aucun mock réseau n'est nécessaire.
 */
export function makeTestEnv(overrides: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "switchy-test-"));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SWITCHY_")) delete process.env[key];
  }
  process.env.SWITCHY_DATA_DIR = dir;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  resetSettingsCache();
  resetCatalogCache();
  resetAuthCaches();

  return {
    app: createApp(),
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Crée une clé d'API via l'API (mode amorçage : l'API est ouverte tant qu'aucune
 * clé n'existe) et renvoie son secret, à présenter ensuite en en-tête. Rend la
 * clé d'amorçage PERSISTÉE (le fichier de clés existe désormais) : l'API exige
 * alors une clé.
 */
export async function createApiKey(app: Express, name = "test"): Promise<string> {
  const res = await request(app).post("/api/keys").send({ name });
  if (res.status !== 201 || typeof res.body?.secret !== "string") {
    throw new Error(`createApiKey failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.secret as string;
}
