/**
 * Étapes d'appel d'un service — fonctions PURES (aucun réseau, aucun DOM) :
 * déplacement dans la liste ordonnée, libellés renumérotés, conversion
 * liste ordonnée ↔ `{ principal, fallbacks }` du catalogue.
 */
import { describe, it, expect } from "vitest";
import {
  dropToIndex,
  moveStep,
  nonEmptySteps,
  serviceToSteps,
  stepRoleLabel,
  stepsToServiceShape,
} from "../public/service-steps.js";

/** Trois étapes distinctes (objets réels, avec leurs réglages). */
function sampleSteps() {
  return [
    { providerId: "ollama-pro", model: "gemma4:31b", reasoning: "off" },
    { providerId: "ollama-free-1", model: "gemma4:31b", reasoning: "low" },
    { providerId: "ollama-free-2", model: "gemma4:31b", reasoning: "high" },
  ];
}

const models = (steps) => steps.map((s) => s.model + "/" + s.providerId);

describe("stepRoleLabel — renumérotation", () => {
  it("0 = principal, n = repli n", () => {
    expect(stepRoleLabel(0)).toBe("principal");
    expect(stepRoleLabel(1)).toBe("repli 1");
    expect(stepRoleLabel(7)).toBe("repli 7");
  });

  it("index invalide → libellé neutre (jamais d'exception)", () => {
    expect(stepRoleLabel(-1)).toBe("étape");
    expect(stepRoleLabel(1.5)).toBe("étape");
    expect(stepRoleLabel("x")).toBe("étape");
    expect(stepRoleLabel(undefined)).toBe("étape");
  });
});

describe("moveStep — déplacements valides", () => {
  it("vers le bas (principal → repli 2) : les objets suivent, rien n'est reconstruit", () => {
    const steps = sampleSteps();
    const refs = steps.slice();
    const next = moveStep(steps, 0, 2);
    expect(models(next)).toEqual([
      "gemma4:31b/ollama-free-1",
      "gemma4:31b/ollama-free-2",
      "gemma4:31b/ollama-pro",
    ]);
    // Identité des objets préservée (réglages par étape intacts).
    expect(next[2]).toBe(refs[0]);
    expect(next[0]).toBe(refs[1]);
    expect(next[1]).toBe(refs[2]);
  });

  it("vers le haut (repli 2 → principal)", () => {
    const next = moveStep(sampleSteps(), 2, 0);
    expect(models(next)[0]).toBe("gemma4:31b/ollama-free-2");
    expect(next[0].reasoning).toBe("high");
  });

  it("d'un cran vers le haut / vers le bas", () => {
    expect(models(moveStep(sampleSteps(), 1, 0))[0]).toBe("gemma4:31b/ollama-free-1");
    expect(models(moveStep(sampleSteps(), 1, 2))[2]).toBe("gemma4:31b/ollama-free-1");
  });

  it("en tête et en fin", () => {
    expect(models(moveStep(sampleSteps(), 1, 0))).toEqual([
      "gemma4:31b/ollama-free-1",
      "gemma4:31b/ollama-pro",
      "gemma4:31b/ollama-free-2",
    ]);
    expect(models(moveStep(sampleSteps(), 0, 2))).toEqual([
      "gemma4:31b/ollama-free-1",
      "gemma4:31b/ollama-free-2",
      "gemma4:31b/ollama-pro",
    ]);
  });

  it("ne modifie JAMAIS le tableau d'entrée", () => {
    const steps = sampleSteps();
    const before = models(steps);
    moveStep(steps, 0, 2);
    expect(models(steps)).toEqual(before);
  });
});

describe("moveStep — déplacements ignorés", () => {
  it("même position → ordre inchangé", () => {
    expect(models(moveStep(sampleSteps(), 1, 1))).toEqual(models(sampleSteps()));
  });

  it("index hors bornes → ignoré (copie)", () => {
    for (const [from, to] of [
      [0, 3],
      [3, 0],
      [-1, 0],
      [0, -1],
      [9, 9],
    ]) {
      expect(models(moveStep(sampleSteps(), from, to))).toEqual(models(sampleSteps()));
    }
  });

  it("index non entiers → ignorés", () => {
    expect(models(moveStep(sampleSteps(), 0.5, 2))).toEqual(models(sampleSteps()));
    expect(models(moveStep(sampleSteps(), 0, Number.NaN))).toEqual(models(sampleSteps()));
    expect(models(moveStep(sampleSteps(), "0", 2))).toEqual(models(sampleSteps()));
  });

  it("une seule étape : aucun déplacement possible", () => {
    const one = [{ providerId: "p", model: "m", reasoning: "off" }];
    expect(models(moveStep(one, 0, 0))).toEqual(["m/p"]);
    expect(moveStep(one, 0, 1)).toEqual(one);
  });

  it("liste vide ou entrée non-tableau → tableau vide, jamais d'exception", () => {
    expect(moveStep([], 0, 1)).toEqual([]);
    expect(moveStep(null, 0, 1)).toEqual([]);
    expect(moveStep(undefined, 0, 1)).toEqual([]);
  });
});

describe("conversion liste ordonnée ↔ { principal, fallbacks }", () => {
  it("liste → principal (1re) + fallbacks (suivantes)", () => {
    const shape = stepsToServiceShape(sampleSteps());
    expect(shape.principal.providerId).toBe("ollama-pro");
    expect(shape.fallbacks.map((f) => f.providerId)).toEqual(["ollama-free-1", "ollama-free-2"]);
  });

  it("une seule étape → aucun repli", () => {
    const shape = stepsToServiceShape([{ providerId: "p", model: "m", reasoning: "off" }]);
    expect(shape.fallbacks).toEqual([]);
    expect(shape.principal.model).toBe("m");
  });

  it("liste vide → principal null (l'appelant refuse)", () => {
    expect(stepsToServiceShape([])).toEqual({ principal: null, fallbacks: [] });
  });

  it("service → liste ordonnée", () => {
    const steps = serviceToSteps({
      principal: { providerId: "a", model: "m1", reasoning: "off" },
      fallbacks: [
        { providerId: "b", model: "m2", reasoning: "low" },
        { providerId: "c", model: "m3", reasoning: "max" },
      ],
    });
    expect(steps.map((s) => s.providerId)).toEqual(["a", "b", "c"]);
  });

  it("service incomplet (replis absents, trous) → lu sans exception", () => {
    expect(serviceToSteps({ principal: { providerId: "a", model: "m", reasoning: "off" } })).toHaveLength(1);
    expect(
      serviceToSteps({
        principal: { providerId: "a", model: "m", reasoning: "off" },
        fallbacks: [null, { providerId: "b", model: "n", reasoning: "off" }],
      }),
    ).toHaveLength(2);
    expect(serviceToSteps(null)).toEqual([]);
    expect(serviceToSteps(undefined)).toEqual([]);
  });

  it("aller-retour SANS perte : service → liste → service", () => {
    const service = {
      principal: { providerId: "a", model: "m1", reasoning: "off" },
      fallbacks: [
        { providerId: "b", model: "m2", reasoning: "low" },
        { providerId: "c", model: "m3", reasoning: "xhigh" },
      ],
    };
    expect(stepsToServiceShape(serviceToSteps(service))).toEqual({
      principal: service.principal,
      fallbacks: service.fallbacks,
    });
  });

  it("aller-retour APRÈS déplacement : réglages par étape conservés", () => {
    const service = {
      principal: { providerId: "a", model: "m1", reasoning: "off" },
      fallbacks: [
        { providerId: "b", model: "m2", reasoning: "low" },
        { providerId: "c", model: "m3", reasoning: "max" },
      ],
    };
    const moved = moveStep(serviceToSteps(service), 2, 0); // le repli 2 devient principal
    const shape = stepsToServiceShape(moved);
    expect(shape.principal).toEqual({ providerId: "c", model: "m3", reasoning: "max" });
    expect(shape.fallbacks).toEqual([
      { providerId: "a", model: "m1", reasoning: "off" },
      { providerId: "b", model: "m2", reasoning: "low" },
    ]);
  });
});

describe("dropToIndex — position d'insertion → index de moveStep", () => {
  it("insertion AVANT l'élément cible", () => {
    // glisser la 1re (0) avant la 3e (index 2) → il devient 2e
    expect(dropToIndex(0, 2)).toBe(1);
    // glisser la 3e (2) avant la 1re (index 0) → il devient 1er
    expect(dropToIndex(2, 0)).toBe(0);
  });

  it("insertion APRÈS l'élément cible (index = n = fin de liste)", () => {
    expect(dropToIndex(0, 1)).toBe(0); // juste après soi-même : aucun effet
    expect(dropToIndex(0, 3)).toBe(2); // en fin de liste
    expect(dropToIndex(2, 3)).toBe(2); // déjà en fin : aucun effet
  });

  it("index invalides → renvoie `from` (déplacement ignoré)", () => {
    expect(dropToIndex(1, -1)).toBe(1);
    expect(dropToIndex(1, 1.5)).toBe(1);
    expect(dropToIndex(Number.NaN, 2)).toBeNaN();
  });

  it("combiné à moveStep : produit exactement l'ordre attendu", () => {
    const steps = sampleSteps();
    expect(models(moveStep(steps, 0, dropToIndex(0, 2)))).toEqual([
      "gemma4:31b/ollama-free-1",
      "gemma4:31b/ollama-pro",
      "gemma4:31b/ollama-free-2",
    ]);
    expect(models(moveStep(steps, 2, dropToIndex(2, 0)))).toEqual([
      "gemma4:31b/ollama-free-2",
      "gemma4:31b/ollama-pro",
      "gemma4:31b/ollama-free-1",
    ]);
    expect(models(moveStep(steps, 0, dropToIndex(0, 3)))).toEqual([
      "gemma4:31b/ollama-free-1",
      "gemma4:31b/ollama-free-2",
      "gemma4:31b/ollama-pro",
    ]);
  });
});

describe("nonEmptySteps — replis vides jamais envoyés à l'API", () => {
  it("écarte un repli sans modèle (le serveur le refuserait)", () => {
    const steps = [
      { providerId: "ollama-pro", model: "gemma4:31b", reasoning: "off" },
      { providerId: "ollama-free-1", model: "", reasoning: "off" },
      { providerId: "ollama-free-2", model: "gemma4:31b", reasoning: "high" },
    ];
    expect(models(nonEmptySteps(steps))).toEqual([
      "gemma4:31b/ollama-pro",
      "gemma4:31b/ollama-free-2",
    ]);
  });

  it("conserve TOUJOURS la 1re étape, même sans modèle", () => {
    const kept = nonEmptySteps([
      { providerId: "ollama-pro", model: "", reasoning: "off" },
      { providerId: "ollama-free-1", model: "", reasoning: "off" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].providerId).toBe("ollama-pro");
  });

  it("un modèle fait d'espaces compte comme vide", () => {
    const steps = [
      { providerId: "a", model: "m", reasoning: "off" },
      { providerId: "b", model: "   ", reasoning: "off" },
    ];
    expect(nonEmptySteps(steps)).toHaveLength(1);
  });

  it("liste vide / entrée invalide → tableau vide, aucune exception", () => {
    expect(nonEmptySteps([])).toEqual([]);
    expect(nonEmptySteps(null)).toEqual([]);
    expect(nonEmptySteps(undefined)).toEqual([]);
    expect(nonEmptySteps("x")).toEqual([]);
  });

  it("ne mute pas l'entrée et garde les réglages des étapes conservées", () => {
    const steps = [
      { providerId: "a", model: "m1", reasoning: "low" },
      { providerId: "b", model: "m2", reasoning: "high" },
      { providerId: "c", model: "", reasoning: "off" },
    ];
    const out = nonEmptySteps(steps);
    expect(steps).toHaveLength(3);
    expect(out).not.toBe(steps);
    expect(out[1]).toBe(steps[1]);
    expect(out[1].reasoning).toBe("high");
  });

  it("combiné à stepsToServiceShape : aucun repli sans modèle n'atteint l'API", () => {
    const shape = stepsToServiceShape(
      nonEmptySteps([
        { providerId: "a", model: "m1", reasoning: "off" },
        { providerId: "b", model: "", reasoning: "off" },
      ]),
    );
    expect(shape.principal.model).toBe("m1");
    expect(shape.fallbacks).toEqual([]);
  });
});
