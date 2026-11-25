/**
 * Zone « Tester les modèles » — cibles du PANEL (vérifications STATIQUES).
 *
 * Décision utilisateur : les membres du panel et le juge doivent être testables
 * depuis l'interface, avec des libellés qui ne se confondent PAS avec les étapes
 * de la chaîne de repli. Ce que ces tests verrouillent :
 *   - le sélecteur d'étape propose les membres (`A — modèle`, `B — …`, `C — …`)
 *     et le juge (`Juge — modèle`) dès que le service a un panel ;
 *   - ces cibles vivent dans un groupe DISTINCT (`optgroup`) de la chaîne
 *     (principal / repli 1…), dont les libellés restent inchangés ;
 *   - la requête envoyée porte `panel: "member"` + `panelIndex` ou
 *     `panel: "judge"` — jamais `stepIndex` pour une cible de panel (contrat
 *     additif, rétro-compatible) ;
 *   - un verdict de panel n'est PAS peint sur une ligne de carte (seules les
 *     étapes de la chaîne ont une ligne).
 *
 * Aucun accès réseau : la source servie est lue par HTTP sur l'app de test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: string;

beforeEach(async () => {
  env = makeTestEnv();
  app = (await request(env.app).get("/app.js")).text;
});

afterEach(() => env.cleanup());

/** Extrait un bloc délimité par deux ancres. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("zone de test — cibles du panel dans le sélecteur", () => {
  it("les membres et le juge sont proposés, dans un groupe distinct de la chaîne", () => {
    const block = between(app, "function renderTestStepSelect()", "function readTestTarget(");
    // Groupe de la CHAÎNE : libellés historiques conservés.
    expect(block).toContain('label: "chaîne d\'appel (principal + replis)"');
    expect(block).toContain("capitalizeRole(stepRoleLabel(index))");
    // Groupe du PANEL : membres A/B/C + juge, valeurs `panel:*`.
    expect(block).toContain('if (service.panel) {');
    expect(block).toContain('label: "panel (propositions A/B/C + juge)"');
    expect(block).toContain("`${letter} — ${step.model || \"(modèle vide)\"}${off}`");
    expect(block).toContain("`Juge — ${judge.model || \"(modèle vide)\"}${off}`");
    expect(block).toContain("attrs: { value: `panel:${index}` }");
    expect(block).toContain('attrs: { value: "panel:judge" }');
    expect(app).toContain('const PANEL_MEMBER_LETTERS = ["A", "B", "C"];');
  });

  it("la cible lue dans le sélecteur produit le contrat `panel`/`panelIndex`", () => {
    const block = between(app, "function readTestTarget(rawValue)", "function capitalizeRole(");
    expect(block).toContain('value.startsWith("panel:")');
    expect(block).toContain('if (rest === "judge") return { panel: "judge" };');
    expect(block).toContain('return { panel: "member", panelIndex: index };');
    expect(block).toContain("return { stepIndex };");
  });

  it("la requête de la zone envoie la cible lue (jamais `stepIndex` pour un panel)", () => {
    const block = between(app, "async function runZoneTest()", "function renderTestOutcome(");
    expect(block).toContain("const target = readTestTarget(stepSelect.value);");
    expect(block).toContain("body: { ...target, prompt, maxTokens },");
    // Un verdict de panel n'a pas de ligne de carte à peindre.
    expect(block).toContain("if (!target.panel) stepTestResults.set(stepTestKey(serviceName, stepIndex), result);");
  });

  it("le résultat nomme la cible testée (proposition A/B/C ou juge du panel)", () => {
    const block = between(app, "function renderTestOutcome(data, out)", "function renderServiceCard(");
    expect(block).toContain('row("cible", isJudge ? "juge du panel" : `proposition ${PANEL_MEMBER_LETTERS[data.panel.index] || data.panel.index + 1} du panel`);');
    expect(block).toContain('row("étape", `${capitalizeRole(stepRoleLabel(stepIndex))}');
  });
});
