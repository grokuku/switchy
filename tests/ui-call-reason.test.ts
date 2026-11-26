/**
 * Motif d'abandon affiché dans « Derniers appels » (statique + bac à sable).
 *
 * Le champ `reason` était DÉJÀ transmis par `/api/dashboard` mais INVISIBLE :
 * une ligne « interrompu » restait opaque. Ce fichier vérifie que
 *
 *   [1] `REASON_LABELS` couvre TOUTES les valeurs de `CALL_REASONS`
 *       (garde-fou anti-dérive : une nouvelle valeur sans libellé fait échouer) ;
 *   [2] `recentRow` pose une pilule de motif UNIQUEMENT quand `reason` existe ;
 *   [3] une tentative `error` affiche aussi son code HTTP ;
 *   [4] l'infobulle porte `callId` + tentative + la DÉCOMPOSITION des tokens
 *       (« — » quand le fournisseur ne l'expose pas, jamais un 0 trompeur).
 *
 * Aucune fonction d'affichage n'est figée par une capture : les fonctions sont
 * EXTRAITES du script servi (`/app.js`) et exécutées sur un DOM minuscule, ce
 * qui teste le comportement réel sans navigateur ni réseau.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";
import { CALL_REASONS } from "../src/llm/calls-log.js";

let env: TestEnv;
let js = "";

beforeEach(async () => {
  env = makeTestEnv();
  js = (await request(env.app).get("/app.js")).text;
});

afterEach(() => env.cleanup());

// ── Extraction ciblée du script servi ──────────────────────────────────────

/** Bloc `{ … }` équilibré à partir de son accolade ouvrante (chaînes sans accolade). */
function braceBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("bloc non équilibré");
}

/** Source complète de `function nom(...) { … }`. */
function fnSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`fonction absente du script servi : ${name}`);
  const open = source.indexOf("{", start);
  return source.slice(start, open) + braceBlock(source, open);
}

/** Source complète de `const nom = { … };`. */
function constObjectSource(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`constante absente du script servi : ${name}`);
  const open = source.indexOf("{", start);
  return `const ${name} = ${braceBlock(source, open)};`;
}

// ── DOM minimal (uniquement ce que `h` utilise) ─────────────────────────────

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  append(...nodes: FakeNode[]): void;
}

function makeDocument(): { createElement(tag: string): FakeNode } {
  return {
    createElement(tag: string): FakeNode {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        attrs: {},
        children: [],
        setAttribute(name: string, value: string) {
          this.attrs[name] = String(value);
        },
        append(...nodes: FakeNode[]) {
          for (const node of nodes) this.children.push(node);
        },
      };
    },
  };
}

/** Tous les descendants (profondeur d'abord). */
function descendants(node: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (n: FakeNode) => {
    for (const child of n.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Cellule dont la classe contient `name`. */
function cells(node: FakeNode, name: string): FakeNode[] {
  return descendants(node).filter((n) => n.className.split(/\s+/).includes(name));
}

/** Extrait les fonctions d'affichage du script servi et les rend exécutables. */
function renderApi() {
  const sources = [
    constObjectSource(js, "REASON_LABELS"),
    ...["h", "badge", "formatCompact", "formatTokens", "formatDuration", "formatClock", "reasonLabel", "countOrDash", "reasonTitle", "resultBadge", "recentTokens", "recentRow"].map(
      (name) => fnSource(js, name),
    ),
  ];
  const factory = new Function(
    "document",
    `${sources.join("\n")}
     return { REASON_LABELS, reasonLabel, reasonTitle, resultBadge, recentRow };`,
  );
  return factory(makeDocument()) as {
    REASON_LABELS: Record<string, string>;
    reasonLabel: (reason: unknown) => string;
    reasonTitle: (entry: Record<string, unknown>) => string;
    resultBadge: (entry: Record<string, unknown>) => FakeNode;
    recentRow: (entry: Record<string, unknown>) => FakeNode;
  };
}

/** Entrée de journal minimale (forme renvoyée par `/api/dashboard`). */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-11-20T10:15:30.000Z",
    callId: "a1b2c3d4e5f6",
    service: "yuki",
    model: "qwen3",
    attempt: 1,
    result: "ok",
    durationMs: 1200,
    tokens: { promptTokens: 100, completionTokens: 20, reasoningTokens: 5 },
    ...overrides,
  };
}

// ── [1] Couverture des libellés (garde-fou anti-dérive) ────────────────────

describe("[1] libellés français des motifs d'abandon", () => {
  it("`REASON_LABELS` couvre TOUTES les valeurs de `CALL_REASONS`", () => {
    const { REASON_LABELS } = renderApi();
    // Rouge si une valeur apparaît côté serveur sans libellé côté interface :
    // sans ce garde-fou, une nouvelle cause d'abandon redeviendrait opaque.
    expect(Object.keys(REASON_LABELS).sort()).toEqual([...CALL_REASONS].sort());
  });

  it("aucun libellé orphelin ni vide (le badge ne doit jamais être vide)", () => {
    const { REASON_LABELS } = renderApi();
    for (const [reason, label] of Object.entries(REASON_LABELS)) {
      expect(label, reason).toBeTruthy();
      expect(label.trim(), reason).toBe(label);
    }
  });

  it("les libellés tiennent dans une pilule (≤ 18 caractères)", () => {
    const { REASON_LABELS } = renderApi();
    for (const [reason, label] of Object.entries(REASON_LABELS)) {
      expect(Array.from(label).length, `${reason} → ${label}`).toBeLessThanOrEqual(18);
    }
  });

  it("les deux motifs d'une interruption sont nommés sans jargon", () => {
    const { REASON_LABELS } = renderApi();
    // `client_disconnect` est le plus fréquent : c'est lui qu'il faut comprendre
    // d'abord, sans lire « client_disconnect ».
    expect(REASON_LABELS.client_disconnect).toBe("client parti");
    expect(REASON_LABELS.watchdog).toContain("watchdog");
    expect(REASON_LABELS.client_disconnect).not.toContain("_");
  });

  it("une valeur inconnue retombe sur la valeur BRUTE (aucun libellé inventé)", () => {
    const { reasonLabel } = renderApi();
    expect(reasonLabel("motif_du_futur")).toBe("motif_du_futur");
    expect(reasonLabel("")).toBe("");
    expect(reasonLabel(null)).toBe("");
    expect(reasonLabel(undefined)).toBe("");
  });
});

// ── [2] Affichage dans « Derniers appels » ─────────────────────────────────

describe("[2] pilule de motif dans la cellule d'état", () => {
  it("affiche le libellé du motif quand `reason` est présent", () => {
    const { recentRow } = renderApi();
    const row = recentRow(entry({ result: "aborted", reason: "client_disconnect" }));
    const reasons = descendants(row).filter((n) => n.className.includes("reason-badge"));
    expect(reasons).toHaveLength(1);
    expect(reasons[0].textContent).toBe("client parti");
    // La pilule vit DANS la cellule d'état : aucune colonne ajoutée au tableau.
    expect(cells(row, "calls-state")).toHaveLength(1);
    expect(cells(row, "calls-state")[0].children).toContain(reasons[0]);
  });

  it("n'affiche RIEN quand `reason` est absent (cas normal d'un succès)", () => {
    const { recentRow } = renderApi();
    const row = recentRow(entry());
    const reasons = descendants(row).filter((n) => n.className.includes("reason-badge"));
    expect(reasons).toHaveLength(0);
    // Aucune pilule vide non plus.
    const badges = cells(row, "badge");
    expect(badges.every((b) => b.textContent.trim() !== "")).toBe(true);
    expect(badges.map((b) => b.textContent)).toEqual(["OK"]);
  });

  it("la ligne garde ses six cellules (grille du tableau inchangée)", () => {
    const { recentRow } = renderApi();
    for (const data of [entry(), entry({ result: "aborted", reason: "watchdog" })]) {
      const row = recentRow(data);
      expect(cells(row, "calls-time")).toHaveLength(1);
      expect(cells(row, "calls-state")).toHaveLength(1);
      expect(cells(row, "calls-service")).toHaveLength(1);
      expect(cells(row, "calls-model")).toHaveLength(1);
      expect(cells(row, "calls-duration")).toHaveLength(1);
      expect(cells(row, "calls-tokens")).toHaveLength(1);
    }
  });

  it("chaque en-tête porte la classe de sa cellule (masquage mobile aligné)", () => {
    const block = fnSource(js, "renderRecentBlock");
    for (const cls of [
      "calls-time",
      "calls-state",
      "calls-service",
      "calls-model",
      "calls-duration",
      "calls-tokens",
    ]) {
      expect(block, cls).toContain(`"${cls}"`);
    }
    // L'en-tête est construit avec la classe de sa colonne, pas sans classe :
    // sinon, à 430 px, les valeurs glissent sous les mauvais libellés.
    expect(block).toContain('h("th", { class: cls');
  });

  it("cohabite avec la pilule REPLI (ordre état, repli, motif)", () => {
    const { recentRow } = renderApi();
    const row = recentRow(
      entry({ result: "aborted", reason: "watchdog", isFallback: true }),
    );
    const state = cells(row, "calls-state")[0];
    const texts = state.children.map((child) => child.textContent);
    expect(texts[0]).toBe("interrompu");
    expect(texts[1]).toBe("REPLI");
    expect(texts[2]).toBe("watchdog 30 min");
  });
});

// ── [3] Code HTTP d'un échec ───────────────────────────────────────────────

describe("[3] code HTTP sur une tentative en erreur", () => {
  it("affiche le code HTTP quand `result` vaut error", () => {
    const { recentRow } = renderApi();
    const row = recentRow(entry({ result: "error", status: 429, reason: "rate_limit" }));
    const state = cells(row, "calls-state")[0];
    expect(state.children[0].textContent).toBe("erreur 429");
    expect(descendants(row).some((n) => n.className.includes("reason-badge"))).toBe(true);
  });

  it("n'affiche aucun code quand `status` manque", () => {
    const { recentRow } = renderApi();
    const state = cells(recentRow(entry({ result: "error" })), "calls-state")[0];
    expect(state.children[0].textContent).toBe("erreur");
  });

  it("n'ajoute jamais de code sur un succès", () => {
    const { recentRow } = renderApi();
    const state = cells(recentRow(entry({ result: "ok", status: 200 })), "calls-state")[0];
    expect(state.children[0].textContent).toBe("OK");
  });
});

// ── [4] Infobulle : corrélation + décomposition des tokens ────────────────

describe("[4] infobulle de la pilule de motif", () => {
  /** Infobulle de la pilule de motif d'une ligne. */
  function titleOf(row: FakeNode): string {
    const badgeNode = descendants(row).find((n) => n.className.includes("reason-badge"));
    expect(badgeNode).toBeTruthy();
    return badgeNode!.attrs.title ?? "";
  }

  it("porte `callId` et le numéro de tentative", () => {
    const { recentRow } = renderApi();
    const title = titleOf(recentRow(entry({ result: "aborted", reason: "client_disconnect", attempt: 2 })));
    expect(title).toContain("a1b2c3d4e5f6");
    expect(title).toContain("tentative 2");
    expect(title).toContain("client parti");
  });

  it("porte la DÉCOMPOSITION des tokens (entrée / sortie / réflexion)", () => {
    const { recentRow } = renderApi();
    const title = titleOf(
      recentRow(
        entry({
          result: "aborted",
          reason: "client_disconnect",
          tokens: { promptTokens: 604100, completionTokens: 1200, reasoningTokens: 800 },
        }),
      ),
    );
    expect(title).toContain("entrée 604,1 k");
    expect(title).toContain("sortie 1,2 k");
    expect(title).toContain("réflexion 800");
  });

  it("affiche « — » pour chaque compteur inconnu (jamais un 0 trompeur)", () => {
    const { recentRow } = renderApi();
    const title = titleOf(recentRow(entry({ result: "aborted", reason: "watchdog", tokens: {} })));
    expect(title).toContain("entrée —");
    expect(title).toContain("sortie —");
    expect(title).toContain("réflexion —");
    expect(title).not.toMatch(/entrée 0\b/);
  });

  it("tolère une entrée sans `tokens` ni `callId`", () => {
    const { recentRow } = renderApi();
    const title = titleOf(
      recentRow({ ts: "2026-11-20T10:15:30.000Z", result: "aborted", reason: "network_error" }),
    );
    expect(title).toContain("appel — · tentative —");
    expect(title).toContain("entrée —");
  });
});

// ── [5] Mise en page : le motif ne casse pas l'alignement ─────────────────

describe("[5] mise en page du motif", () => {
  /** Déclarations des blocs dont un sélecteur porte `className` (`.a.b` inclus). */
  async function declarationsOf(className: string): Promise<string> {
    const css = (await request(env.app).get("/styles.css")).text;
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].split(",").some((s) => s.trim().split(".").includes(className)))
      .map((m) => m[2])
      .join("\n");
  }

  it("le badge de motif est tronqué proprement (ellipse) et ne déborde pas", async () => {
    const block = await declarationsOf("reason-badge");
    expect(block).toMatch(/max-width:\s*18ch/);
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
    expect(block).toMatch(/overflow:\s*hidden/);
    // `text-overflow` n'agit que sur une BOÎTE : jamais `inline-flex` ici.
    expect(block).toMatch(/display:\s*inline-block/);
    // Couleurs : uniquement les variables du thème.
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("la cellule d'état autorise le repli (deux pilules sur écran étroit)", async () => {
    const block = await declarationsOf("calls-state");
    expect(block).toMatch(/white-space:\s*normal/);
  });
});
