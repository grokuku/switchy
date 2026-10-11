import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Express } from "express";
import { createApp } from "../src/index.js";

export interface TestEnv {
  app: Express;
  dir: string;
  cleanup: () => void;
}

/**
 * Prépare un environnement de test isolé : répertoire de données temporaire,
 * variables SWITCHY_* nettoyées (les défauts du service s'appliquent).
 *
 * Le socle du Lot 1 n'émet AUCUNE requête sortante : aucun mock réseau n'est
 * nécessaire (le cœur de la passerelle, lui, sera testé avec `fetch` mocké).
 */
export function makeTestEnv(overrides: Record<string, string> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "switchy-test-"));
  process.env.SWITCHY_DATA_DIR = dir;
  delete process.env.SWITCHY_HOST;
  delete process.env.SWITCHY_PORT;
  delete process.env.SWITCHY_RATE_LIMIT_PER_MIN;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  return {
    app: createApp(),
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
