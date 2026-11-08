/**
 * Dernière passe d'endurcissement de l'INTERFACE (statique, sans navigateur) :
 *
 *  [8]  retour d'onglet → aucune requête sans session (`state.authenticated`) ;
 *  [12] repli `fetch` : `init.timeout` honoré (AbortController) ;
 *  [13] focus conservé après re-render des listes ;
 *  [15] deep-link d'onglet cohérent (`replaceState` + `hashchange`) ;
 *  [14] état du direct annoncé (`role="status"` + `aria-live`) ;
 *  [18] motif ARIA « tabs » : flèches + roving `tabindex`.
 *
 * On lit le balisage/le script SERVIS (aucun accès réseau, aucun LLM).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let js: string;
let html: string;

beforeEach(async () => {
  env = makeTestEnv();
  js = (await request(env.app).get("/app.js")).text;
  html = (await request(env.app).get("/")).text;
});

afterEach(() => env.cleanup());

/** Tranche de code entre deux bornes textuelles (repère stable, non fragile). */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) return "";
  const to = source.indexOf(end, from);
  return to < 0 ? source.slice(from) : source.slice(from, to);
}

describe("[8] retour d'onglet — garde d'authentification", () => {
  it("`visibilitychange` ne relit les agrégats que si la session est ouverte", () => {
    const block = /document\.addEventListener\("visibilitychange"[\s\S]*?\n  \}\);/.exec(js)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).toContain("state.authenticated");
    expect(block).toContain("loadDashboard()");
  });
});

describe("[12] repli `fetch` — le délai est honoré", () => {
  it("`nativeRequest` traduit `init.timeout` en AbortController et nettoie le timer", () => {
    const body = between(js, "async function nativeRequest", "function apiRequest");
    expect(body).not.toBe("");
    expect(body).toContain("AbortController");
    expect(body).toContain("init.timeout");
    expect(body).toContain("clearTimeout");
    expect(body).toContain("AbortError");
  });
});

describe("[13] focus conservé après re-render des listes", () => {
  it("les trois rendus mémorisent puis restaurent le focus", () => {
    expect(js).toContain("function captureFocusKey(");
    expect(js).toContain("function restoreFocusKey(");
    for (const fn of ["function renderProviders()", "function renderServices()", "function renderKeys()"]) {
      const body = between(js, fn, "\n  }");
      expect(body, fn).toContain("captureFocusKey(list)");
      expect(body, fn).toContain("restoreFocusKey(list, focusMemo)");
    }
  });

  it("le bouton de bascule d'un service porte une clé de focus stable", () => {
    const body = between(js, "function serviceToggleButton(", "\n  }");
    expect(body).toContain("data-focus-key");
    expect(body).toContain(":toggle");
  });
});

describe("[15] deep-link d'onglet cohérent", () => {
  it("`activate()` met l'ancre à jour sans empiler d'historique", () => {
    const body = between(js, "function activate(name)", "// ── Thème");
    expect(body).toContain("history.replaceState");
  });

  it("un changement d'ancre change d'onglet (`hashchange` écouté)", () => {
    expect(js).toContain('addEventListener("hashchange"');
  });
});

describe("[14] l'état du direct est annoncé", () => {
  it("`#live-conn` est une zone de statut polie", () => {
    const span = /<span[^>]*id="live-conn"[^>]*>/.exec(html)?.[0] ?? "";
    expect(span).not.toBe("");
    expect(span).toContain('role="status"');
    expect(span).toContain('aria-live="polite"');
  });
});

describe("[18] onglets — navigation clavier ARIA", () => {
  it("seul l'onglet actif est atteignable par Tab (roving tabindex)", () => {
    const activityTab = /<button[^>]*id="tab-activity"[^>]*>/.exec(html)?.[0] ?? "";
    const servicesTab = /<button[^>]*id="tab-services"[^>]*>/.exec(html)?.[0] ?? "";
    expect(activityTab).not.toContain('tabindex="-1"');
    expect(servicesTab).toContain('tabindex="-1"');
    expect(js).toContain("tab.tabIndex = selected ? 0 : -1");
  });

  it("←/→/Home/End déplacent le focus et activent l'onglet", () => {
    const body = between(js, "function onTabKeydown(event)", "\n  }");
    expect(body).toContain("ArrowRight");
    expect(body).toContain("ArrowLeft");
    expect(body).toContain("Home");
    expect(body).toContain("End");
    expect(body).toContain("target.focus()");
  });
});
