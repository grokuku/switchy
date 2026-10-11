/**
 * Mise en page — PLEINE LARGEUR exigée (préférence utilisateur : jamais de
 * colonne étroite centrée).
 *
 * Vérification statique du CSS servi (pas de navigateur) : les règles sont
 * extraites par bloc `sélecteur { … }` — le test reste vert tant que les
 * déclarations attendues sont présentes, sans figer l'ordre ni le formatage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

/** Retourne les déclarations du (ou des) bloc(s) dont la liste de sélecteurs contient `selector`. */
function declarationsFor(css: string, selector: string): string {
  // Les commentaires CSS peuvent précéder un sélecteur : on les retire d'abord.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) bodies.push(m[2]);
  }
  return bodies.join("\n");
}

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("Mise en page — pleine largeur", () => {
  it("`.content` occupe toute la largeur (aucun max-width centré)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    const content = declarationsFor(css, ".content");
    expect(content).toMatch(/width:\s*100%/);
    expect(content).not.toMatch(/max-width/);
    expect(content).not.toMatch(/margin:\s*0\s+auto/);
  });

  it("`.panel` aussi (aucune colonne étroite par section)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    const panel = declarationsFor(css, ".panel");
    expect(panel).toMatch(/width:\s*100%/);
    expect(panel).not.toMatch(/max-width/);
  });
});
