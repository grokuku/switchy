/**
 * Onglet « Activité » par défaut + temps réel dans l'interface (statique).
 *
 * Vérifications SANS navigateur : le balisage servi doit déjà placer Activité
 * comme page d'entrée (état initial, pas un clic simulé) et exposer
 * l'indicateur de connexion du direct. Le script doit viser le WebSocket
 * `/ws/activity` et avoir abandonné l'ancien rafraîchissement de 5 s.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => env.cleanup());

describe("Onglet par défaut", () => {
  it("« Activité » est l'onglet actif du balisage servi", async () => {
    const html = (await request(env.app).get("/")).text;
    const activityTab = /<button[^>]*id="tab-activity"[^>]*>/.exec(html)?.[0] ?? "";
    const servicesTab = /<button[^>]*id="tab-services"[^>]*>/.exec(html)?.[0] ?? "";

    expect(activityTab).toContain('data-tab="activity"');
    expect(activityTab).toContain('aria-selected="true"');
    expect(activityTab).toContain("is-active");
    expect(servicesTab).toContain('aria-selected="false"');
    expect(servicesTab).not.toContain("is-active");
  });

  it("le panneau Activité est visible, celui des Services masqué", async () => {
    const html = (await request(env.app).get("/")).text;
    const activityPanel = /<section[^>]*id="panel-activity"[^>]*>/.exec(html)?.[0] ?? "";
    const servicesPanel = /<section[^>]*id="panel-services"[^>]*>/.exec(html)?.[0] ?? "";

    expect(activityPanel).not.toContain("hidden");
    expect(servicesPanel).toContain("hidden");
    // Le script doit aussi partir sur Activité (état initial + ancre par défaut).
    const js = (await request(env.app).get("/app.js")).text;
    expect(js).toContain('let activeTab = "activity"');
    expect(js).toContain('return hash === "services"');
  });
});

describe("Temps réel — indicateur et transport", () => {
  it("l'indicateur de connexion est présent et démarre hors ligne", async () => {
    const html = (await request(env.app).get("/")).text;
    expect(html).toContain('id="live-conn"');
    expect(html).toContain('data-state="off"');
    expect(html).toContain('class="live-dot"');
    // Plus de case « 5 s » : le direct remplace le rafraîchissement périodique.
    expect(html).not.toContain("Rafraîchissement auto (5 s)");
    expect(html).not.toContain('id="activity-auto"');
  });

  it("le script vise /ws/activity et garde les agrégats à cadence lente", async () => {
    const js = (await request(env.app).get("/app.js")).text;
    expect(js).toContain("/ws/activity");
    expect(js).toContain("AGGREGATES_REFRESH_MS = 30000");
    expect(js).toContain("LIVE_BACKOFF_MS");
    // L'ancien minuteur de 5 s ne doit plus exister.
    expect(js).not.toContain("DASHBOARD_REFRESH_MS");
  });

  it("le CSS colore l'indicateur selon l'état (direct / reconnexion)", async () => {
    const css = (await request(env.app).get("/styles.css")).text;
    expect(css).toContain('.live-conn[data-state="live"]');
    expect(css).toContain('.live-conn[data-state="reconnecting"]');
  });
});
