/**
 * [6] Le direct ne reconstruit plus tout le DOM.
 *
 * Vérification statique (le projet n'embarque pas de DOM de test) : sur une
 * frame `live`/`call`, `app.js` doit mettre à jour EN PLACE (prepend + ablation
 * de la dernière ligne pour « Derniers appels », cellule « en cours » seule pour
 * « Par clé ») et ne reconstruire COMPLET que sur le snapshot de reconnexion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let js = "";

beforeEach(async () => {
  env = makeTestEnv();
  js = (await request(env.app).get("/app.js")).text;
});

afterEach(() => env.cleanup());

/** Corps d'une fonction déclarée par `function nom(...) { … }` (accolades comptées). */
function bodyOf(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = js.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") {
      depth--;
      if (depth === 0) return js.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated body for ${name}`);
}

describe("[6] mise à jour en place du direct", () => {
  it("paintRecent prépende une ligne et retire la dernière", () => {
    const body = bodyOf("paintRecent");
    expect(body).toContain("prepend(");
    expect(body).toContain("lastElementChild");
    // Le rendu complet n'est qu'un REPLI (structure absente), pas la norme.
    expect(body).toContain("if (!tbody || !entry)");
  });

  it("paintKeyBlock ne réécrit que la cellule « en cours »", () => {
    const body = bodyOf("paintKeyBlock");
    expect(body).toContain('querySelector("td.key-inflight")');
    expect(body).toContain("dataset.key");
    // Rendu complet seulement en repli (snapshot ou composition changée).
    expect(body).toContain("if (!tbody || !sameShape)");
  });

  it("le snapshot (reconnexion) garde le rendu complet", () => {
    const body = bodyOf("applyLiveFrame");
    expect(body).toContain("paintKeyBlock(isSnapshot)");
    expect(body).toContain("paintRecent(true)");
    expect(body).toContain("paintRecent(false)");
  });

  it("chaque ligne « Par clé » porte son identifiant d'affichage", () => {
    expect(bodyOf("renderKeyBlock")).toContain("tr.dataset.key");
  });
});
