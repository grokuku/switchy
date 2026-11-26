/**
 * Onglet « Activité » — variante A « Dense par bandes ».
 *
 * Verrouille la structure servie (le projet n'embarque pas de DOM de test) :
 * huit KPI dans le bandeau, trois cartes dans la grille supérieure, douze
 * appels au maximum, badge de motif conservé et direct toujours incrémental.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { DASHBOARD_RECENT_LIMIT } from "../src/llm/dashboard.js";

let env: TestEnv;
let js = "";
let css = "";

beforeEach(async () => {
  env = makeTestEnv();
  js = (await request(env.app).get("/app.js")).text;
  css = (await request(env.app).get("/styles.css")).text;
});

afterEach(() => env.cleanup());

/** Corps d'une fonction déclarée par `function nom(...) { … }`. */
function bodyOf(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  expect(start, `fonction ${name}`).toBeGreaterThan(-1);
  const open = js.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") {
      depth--;
      if (depth === 0) return js.slice(open, i + 1);
    }
  }
  throw new Error(`corps non terminé : ${name}`);
}

/** Déclarations d'un sélecteur CSS exact. */
function declarationsFor(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim()).includes(selector))
    .map((match) => match[2])
    .join("\n");
}

describe("Activité — bandeau et grille denses", () => {
  it("expose les huit KPI du bandeau, dont tokens et concurrence", () => {
    const body = bodyOf("renderSummaryBlock");
    expect((body.match(/dashboardStat\(/g) ?? [])).toHaveLength(8);
    for (const label of [
      "Appels · 24 h",
      "Réussite",
      "Replis",
      "Sautés charge",
      "Affinité cache",
      "Latence moy. / max",
      "Tokens · 24 h",
      "En cours / attente",
    ]) {
      expect(body, label).toContain(`"${label}"`);
    }
    expect(declarationsFor(".kpi-grid")).toMatch(/grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("place En ce moment, 24 h + clés et Tokens dans les trois colonnes", () => {
    const body = bodyOf("renderDashboard");
    expect(body).toContain('class: "dash-row dash-row--top"');
    expect(body).toMatch(/row\.append\(liveHost\);[\s\S]*row\.append\(keyHost\);[\s\S]*row\.append\(renderTokensBlock/);
    expect(bodyOf("renderKeyBlock")).toContain('class: "stats-grid"');
    expect(declarationsFor(".dash-row--top")).toMatch(/grid-template-columns:\s*1\.05fr\s+1\.12fr\s+1\.35fr/);
  });

  it("borne le tableau à douze appels et conserve sa densité de 22 px", () => {
    expect(DASHBOARD_RECENT_LIMIT).toBe(12);
    expect(js).toContain("const RECENT_LIMIT = 12");
    expect(bodyOf("renderRecentBlock")).toContain(".slice(0, RECENT_LIMIT)");
    expect(declarationsFor(".calls-table td")).toMatch(/height:\s*22px/);
    expect(declarationsFor(".calls-table td")).toMatch(/line-height:\s*14px/);
  });

  it("garde le badge de motif, son infobulle et le code HTTP", () => {
    const row = bodyOf("recentRow");
    expect(row).toContain("reason-badge");
    expect(row).toContain("reasonTitle(entry)");
    expect(js).toContain("const REASON_LABELS = {");
    expect(bodyOf("resultBadge")).toContain("entry.status");
  });

  it("garde la densité verticale qui fait tenir l'onglet dans 1440×900", () => {
    // Marge verticale du conteneur plus serrée que l'horizontale, et en-tête de
    // l'onglet limité à deux lignes : c'est ce qui supprime le défilement.
    expect(declarationsFor(".content")).toMatch(/padding:\s*clamp\(12px,\s*1\.7vw,\s*18px\)/);
    expect(declarationsFor("#panel-activity .panel-hint")).toMatch(/max-width:\s*1100px/);
    expect(declarationsFor("#panel-activity .panel-head")).toMatch(/margin-bottom:\s*7px/);
  });
});

describe("Activité — direct incrémental sous la nouvelle structure", () => {
  it("une frame live ne reconstruit pas toute la carte En ce moment", () => {
    const body = bodyOf("paintLiveBlock");
    expect(body).toContain("if (!list || !sameShape)");
    expect(body).toContain('querySelector(".cap-count")');
    expect(body).toContain('querySelector(".kpi-live-value")');
    expect(bodyOf("applyLiveFrame")).toContain("paintLiveBlock(isSnapshot)");
  });

  it("une frame live ne réécrit que la cellule en cours de chaque clé", () => {
    const body = bodyOf("paintKeyBlock");
    expect(body).toContain('querySelector("td.key-inflight")');
    expect(body).toContain("if (!tbody || !sameShape)");
  });

  it("une frame call prépende une ligne et plafonne le corps du tableau", () => {
    const body = bodyOf("paintRecent");
    expect(body).toContain("tbody.prepend(recentRow(entry))");
    expect(body).toContain("while (tbody.children.length > RECENT_LIMIT)");
  });
});
