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

/**
 * Uniformité des cartes (fournisseurs ET services, même gabarit `.item-card`).
 *
 * Régression historique : `.card + .card { margin-top }` (prévu pour des cartes
 * EMPILÉES) s'appliquait aussi dans la grille — les cartes 2..n étaient donc
 * poussées vers le bas alors que la 1re ne l'était pas : la 1re carte paraissait
 * plus grande et son contenu décalé. Ces vérifications statiques verrouillent :
 *   – l'exclusion des cartes de grille de la marge d'empilement ;
 *   – le titre sur une seule ligne (hauteur d'en-tête constante).
 */
describe("Mise en page — cartes de grille uniformes", () => {
  it("la marge d'empilement ne fuit pas dans la grille", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    // Plus aucune règle d'empilement visant n'importe quelle carte…
    expect(declarationsFor(css, ".card + .card")).toBe("");
    // …mais l'empilement des vraies cartes empilées (onglet Réglages) subsiste.
    expect(declarationsFor(css, ".card + .card:not(.item-card)")).toMatch(
      /margin-top:\s*var\(--switchy-gap\)/,
    );
    // Et les cartes de grille sont explicitement sans marge.
    expect(declarationsFor(css, ".cards-grid > .item-card")).toMatch(/margin:\s*0/);
  });

  it("le titre d'une carte reste sur UNE ligne (hauteur d'en-tête constante)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    const title = declarationsFor(css, ".item-title");
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/flex:\s*1 1 100%/);
  });

  it("la grille étire les cartes d'une même ligne (aucun align-items divergent)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    const grid = declarationsFor(css, ".cards-grid");
    expect(grid).toMatch(/display:\s*grid/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill/);
    expect(grid).not.toMatch(/align-items:\s*(start|end|center)/);
  });
});
