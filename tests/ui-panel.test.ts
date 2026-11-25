/**
 * Interface du mode « PANEL » — vérifications STATIQUES (pas de navigateur).
 *
 * Ce que ces tests verrouillent :
 *   - la section vit DANS la fenêtre de service existante (`openServiceForm`),
 *     entre « Étapes d'appel » et « Capacités » — aucun onglet nouveau ;
 *   - la case est DÉCOCHÉE par défaut, le corps masqué quand elle l'est ;
 *   - les 3 lignes A/B/C + la ligne « juge » réutilisent `buildStepsEditor` en
 *     NOMBRE FIXE (pas de glisser, pas d'ajout, pas de retrait) ;
 *   - quorum, langue et (repliés) délais sont présents ;
 *   - la carte affiche les pilules `panel`, `quorum`, `lang` et le garde-fou ;
 *   - tout est en français et n'emploie que les couleurs `--switchy-*`.
 *
 * Aucun accès réseau : la source servie est lue par HTTP sur l'app de test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: string;
let css: string;

beforeEach(async () => {
  env = makeTestEnv();
  app = (await request(env.app).get("/app.js")).text;
  css = (await request(env.app).get("/styles.css")).text;
});

afterEach(() => env.cleanup());

/** Extrait un bloc délimité par deux ancres (pour cibler la section panel). */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("interface — section Panel de la fenêtre de service", () => {
  it("la section est dans la modale de service, entre « Étapes d'appel » et « Capacités »", () => {
    expect(app.match(/function openServiceForm\(/g)?.length ?? 0).toBe(1);
    const stepsAt = app.indexOf('formSection("Étapes d\'appel")');
    const panelAt = app.indexOf('formSection("Panel")');
    const capsAt = app.indexOf('formSection("Capacités")');
    expect(stepsAt).toBeGreaterThan(0);
    expect(panelAt).toBeGreaterThan(stepsAt);
    expect(capsAt).toBeGreaterThan(panelAt);
    // Aucun onglet nouveau : les onglets restent ceux de l'index.
    expect(app).not.toContain('data-tab="panel"');
  });

  it("case décochée par défaut et corps masqué quand elle l'est", () => {
    const section = between(app, 'formSection("Panel")', 'formSection("Capacités")');
    expect(section).toContain("Mode panel (3 proposeurs + 1 juge)");
    // Cochée seulement si le service édité a déjà un panel.
    expect(section).toContain("const existingPanel = editing && service.panel ? service.panel : null;");
    expect(section).toContain("checkbox(!!existingPanel,");
    expect(section).toContain("panelBody.hidden = !existingPanel;");
    expect(section).toContain("panelBody.hidden = !panelBox.input.checked;");
  });

  it("3 lignes A/B/C + 1 juge en NOMBRE FIXE (réutilisation de buildStepsEditor)", () => {
    const section = between(app, 'formSection("Panel")', 'formSection("Capacités")');
    expect(section).toContain("fixedCount: 3");
    expect(section).toContain("fixedCount: 1");
    expect(section).toContain('"proposition A"');
    expect(section).toContain('"proposition C"');
    expect(section).toContain('roleLabel: () => "juge"');
    // Le mode fixe n'expose ni poignée, ni flèches, ni ajout.
    expect(app).toContain("if (fixedCount === 0) li.append(stepGrip(role));");
    expect(app).toContain("if (fixedCount === 0) attachStepReordering(rows, move);");
    expect(app).toContain('rows.classList.add("steps-editor--fixed")');
  });

  it("quorum, langue, et délais dans un <details> replié", () => {
    const section = between(app, 'formSection("Panel")', 'formSection("Capacités")');
    expect(section).toContain('"quorum",');
    expect(section).toContain("inputNumber(existingPanel ? existingPanel.quorum : 2, 1, 3)");
    expect(section).toContain('"langue des consignes"');
    expect(section).toContain('h("details", { class: "panel-advanced" })');
    expect(section).toContain('{ text: "réglages avancés" }');
    expect(section).toContain("délai d'une proposition (ms)");
    expect(section).toContain("délai du juge (ms)");
    expect(section).toContain("memberTimeoutMs");
    expect(section).toContain("judgeTimeoutMs");
  });

  it("garde-fou « panel inopérant » et pilules de la carte", () => {
    expect(app).toContain("refreshPanelWarn");
    expect(app).toContain('badge("panel inopérant", "warn")');
    expect(app).toContain("pills.append(badge(`panel ${members.length}+1`");
    expect(app).toContain("pills.append(badge(`quorum ${s.panel.quorum}/${members.length}`");
    expect(app).toContain("pills.append(badge(`lang ");
  });

  it("le corps envoyé porte `panel` (null = extinction explicite)", () => {
    expect(app).toContain("let panel = null;");
    expect(app).toContain("if (panelBox.input.checked) {");
    expect(app).toContain("enabled: enabledBox.input.checked,\n          panel,");
  });

  it("styles : bloc plein largeur et couleurs --switchy-* uniquement", () => {
    const block = between(css, ".panel-config {", "/* Éditeur à NOMBRE FIXE");
    expect(block).toContain("grid-column: 1 / -1;");
    expect(block).toContain("var(--switchy-border)");
    expect(block).toContain("var(--switchy-bg-raised)");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain(".steps-editor--fixed .step-editor-row {");
  });
});
