/**
 * Validation de `PanelConfig` (`src/catalog-store.ts`).
 *
 * Décisions verrouillées ici :
 *   - `panel` est un champ OPTIONNEL : un client antérieur qui renvoie le corps
 *     d'un service sans `panel` ne doit JAMAIS éteindre le mode par accident ;
 *   - une configuration INVALIDE est refusée en 400 avec des messages explicites
 *     (bornes `quorum` 1..3, délais encadrés, `lang` fr|en, 3 membres) — jamais
 *     corrigée ni écrasée en silence ;
 *   - `panel: null` est la SEULE extinction explicite ;
 *   - un fournisseur utilisé par un panel ne peut pas être supprimé.
 *
 * Aucun réseau : uniquement des appels d'API sur un catalogue de test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { api, makeTestEnv, seedProvider, seedService, step, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => {
  env.cleanup();
});

/** Service minimal sans panel (catalogue valide). */
function serviceBody(panel?: unknown): Record<string, unknown> {
  return {
    name: "panel-svc",
    description: "panel",
    principal: step("p1", "m-principal"),
    fallbacks: [],
    contextWindow: 8192,
    maxOutputTokens: 1024,
    vision: false,
    prioritaire: false,
    rolling: false,
    enabled: true,
    ...(panel === undefined ? {} : { panel }),
  };
}

function panelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    members: [step("p1", "m-a"), step("p1", "m-b"), step("p1", "m-c")],
    judge: step("p1", "m-judge"),
    quorum: 2,
    memberTimeoutMs: 60_000,
    judgeTimeoutMs: 90_000,
    lang: "fr",
    ...overrides,
  };
}

function errorText(res: { body: unknown }): string {
  return JSON.stringify(res.body);
}

describe("panel — validation de la configuration", () => {
  beforeEach(async () => {
    await seedProvider(env.app, {
      id: "p1",
      label: "P1",
      type: "openai-compatible",
      baseUrl: "http://p.test/v1",
    });
  });

  it("accepte une configuration valide et comble les DÉFAUTS absents", async () => {
    const res = await api(env.app)
      .post("/api/services")
      .send(serviceBody({ members: [step("p1", "m-a"), step("p1", "m-b"), step("p1", "m-c")], judge: step("p1", "m-judge") }));

    expect(res.status).toBe(201);
    expect(res.body.service.panel).toMatchObject({
      quorum: 2,
      memberTimeoutMs: 60_000,
      judgeTimeoutMs: 90_000,
      lang: "fr",
    });
    expect(res.body.service.panel.members).toHaveLength(3);

    const list = await api(env.app).get("/api/services");
    const found = (list.body.services ?? list.body) as Array<Record<string, unknown>>;
    expect(JSON.stringify(found)).toContain("\"panel\"");
  });

  it("refuse un quorum hors bornes (0 et 4)", async () => {
    const tooBig = await api(env.app).post("/api/services").send(serviceBody(panelBody({ quorum: 4 })));
    expect(tooBig.status).toBe(400);
    expect(errorText(tooBig)).toContain("panel.quorum");

    const tooSmall = await api(env.app).post("/api/services").send(serviceBody(panelBody({ quorum: 0 })));
    expect(tooSmall.status).toBe(400);
    expect(errorText(tooSmall)).toContain("panel.quorum");

    const notInt = await api(env.app).post("/api/services").send(serviceBody(panelBody({ quorum: 2.5 })));
    expect(notInt.status).toBe(400);
  });

  it("refuse une langue inconnue", async () => {
    const res = await api(env.app).post("/api/services").send(serviceBody(panelBody({ lang: "de" })));
    expect(res.status).toBe(400);
    expect(errorText(res)).toContain("panel.lang");
    expect(errorText(res)).toContain("fr, en");
  });

  it("refuse un nombre de membres autre que 3", async () => {
    const res = await api(env.app)
      .post("/api/services")
      .send(serviceBody(panelBody({ members: [step("p1", "m-a"), step("p1", "m-b")] })));
    expect(res.status).toBe(400);
    expect(errorText(res)).toContain("exactly 3");
  });

  it("refuse des délais hors bornes", async () => {
    const tooShort = await api(env.app)
      .post("/api/services")
      .send(serviceBody(panelBody({ memberTimeoutMs: 10 })));
    expect(tooShort.status).toBe(400);
    expect(errorText(tooShort)).toContain("panel.memberTimeoutMs");

    const tooLong = await api(env.app)
      .post("/api/services")
      .send(serviceBody(panelBody({ judgeTimeoutMs: 700_000 })));
    expect(tooLong.status).toBe(400);
    expect(errorText(tooLong)).toContain("panel.judgeTimeoutMs");
  });

  it("refuse un fournisseur inconnu dans un membre ou chez le juge", async () => {
    const member = await api(env.app)
      .post("/api/services")
      .send(serviceBody(panelBody({ members: [step("p1", "m-a"), step("ghost", "m-b"), step("p1", "m-c")] })));
    expect(member.status).toBe(400);
    expect(errorText(member)).toContain("unknown provider");

    const judge = await api(env.app)
      .post("/api/services")
      .send(serviceBody(panelBody({ judge: step("ghost", "m-judge") })));
    expect(judge.status).toBe(400);
    expect(errorText(judge)).toContain("unknown provider");
  });

  it("PUT sans `panel` ne touche pas au panel (rétro-compatibilité), `null` l'éteint", async () => {
    await seedService(env.app, serviceBody(panelBody()));

    // Corps d'un client ANTÉRIEUR : aucun champ `panel` → configuration intacte.
    const kept = await api(env.app).put("/api/services/panel-svc").send({
      principal: step("p1", "m-principal"),
      contextWindow: 8192,
      maxOutputTokens: 1024,
    });
    expect(kept.status).toBe(200);
    expect(kept.body.service.panel?.quorum).toBe(2);
    expect(kept.body.service.panel?.members).toHaveLength(3);

    // `null` = extinction EXPLICITE.
    const off = await api(env.app).put("/api/services/panel-svc").send({ panel: null });
    expect(off.status).toBe(200);
    expect(off.body.service.panel).toBeUndefined();
  });

  it("un PUT invalide est refusé en 400 SANS écraser la configuration existante", async () => {
    await seedService(env.app, serviceBody(panelBody({ quorum: 3 })));

    const res = await api(env.app).put("/api/services/panel-svc").send({ panel: panelBody({ quorum: 9 }) });
    expect(res.status).toBe(400);
    expect(errorText(res)).toContain("panel.quorum");

    const after = await api(env.app).get("/api/services");
    const service = ((after.body.services ?? after.body) as Array<Record<string, unknown>>).find(
      (s) => s.name === "panel-svc",
    );
    expect((service?.panel as { quorum: number }).quorum).toBe(3);
  });

  it("un fournisseur utilisé par un PANEL ne peut pas être supprimé", async () => {
    await seedProvider(env.app, {
      id: "p2",
      label: "P2",
      type: "openai-compatible",
      baseUrl: "http://p2.test/v1",
    });
    // Le panel n'utilise QUE p2 (principal/fallbacks restent sur p1).
    await seedService(env.app, serviceBody(panelBody({ judge: step("p2", "m-judge") })));

    const res = await api(env.app).delete("/api/providers/p2");
    expect(res.status).toBe(409);
    expect(errorText(res)).toContain("panel-svc");
  });
});
