/**
 * Routes des services — `/api/services` (protégées par la clé d'API).
 *
 *   GET    /api/services             → liste des services nommés
 *   POST   /api/services             → création (validation : nom unique, providerId existant, bornes)
 *   PUT    /api/services/:name       → mise à jour
 *   DELETE /api/services/:name       → suppression
 *   POST   /api/services/:name/test  → TEST d'une étape (ou de la chaîne), résultat structuré
 *
 * ⚠️ Le test passe par le MÊME chemin de relais que la production
 * (`testServiceStep` → `relayServiceChat`/`attemptStep`) : aucune duplication de
 * la logique fournisseur, et l'appel est journalisé comme les autres.
 */
import { Router, type Request, type Response } from "express";
import {
  listServices,
  createService,
  updateService,
  deleteService,
  getService,
  runCatalogMutation,
} from "../catalog-store.js";
import { testServiceStep, TEST_TIMEOUT_MS } from "../llm/relay.js";
import type { PanelTestTarget } from "../llm/panel.js";
import { requestKeyName, requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";
import { ApiError, errorBody } from "../utils/api-error.js";

const router = Router();

// ── Bornes du test manuel d'étape (⚠️ c'est du QUOTA utilisateur) ──

/** Prompt par défaut : court, sans ambiguïté, facile à vérifier à l'œil. */
export const TEST_DEFAULT_PROMPT = "Réponds uniquement : ok";

/** Longueur maximale acceptée pour le prompt de test (garde-fou anti-dérive). */
export const TEST_MAX_PROMPT_CHARS = 4_000;

/** `max_tokens` par défaut et PLAFOND ABSOLU imposé côté serveur. */
export const TEST_DEFAULT_MAX_TOKENS = 64;
export const TEST_MAX_TOKENS = 256;

function testBody(body: unknown): {
  prompt: string;
  maxTokens: number;
  stepIndex?: number;
  panel?: PanelTestTarget;
} {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const errors: string[] = [];

  let prompt = TEST_DEFAULT_PROMPT;
  if (record.prompt !== undefined) {
    if (typeof record.prompt !== "string") errors.push("prompt: doit être une chaîne");
    else if (record.prompt.trim() === "") errors.push("prompt: ne peut pas être vide");
    else if (record.prompt.length > TEST_MAX_PROMPT_CHARS) {
      errors.push(`prompt: ${TEST_MAX_PROMPT_CHARS} caractères maximum`);
    } else prompt = record.prompt;
  }

  let maxTokens = TEST_DEFAULT_MAX_TOKENS;
  if (record.maxTokens !== undefined) {
    if (typeof record.maxTokens !== "number" || !Number.isFinite(record.maxTokens) || !Number.isInteger(record.maxTokens)) {
      errors.push("maxTokens: doit être un entier");
    } else if (record.maxTokens < 1) {
      errors.push("maxTokens: doit être supérieur ou égal à 1");
    } else {
      // Plafond SILENCIEUX vers le haut : une interface généreuse ne peut jamais
      // faire exploser la facture du fournisseur.
      maxTokens = Math.min(TEST_MAX_TOKENS, record.maxTokens);
    }
  }

  let stepIndex: number | undefined;
  if (record.stepIndex !== undefined && record.stepIndex !== null) {
    if (typeof record.stepIndex !== "number" || !Number.isInteger(record.stepIndex) || record.stepIndex < 0) {
      errors.push("stepIndex: doit être un entier positif ou nul");
    } else stepIndex = record.stepIndex;
  }

  // ── Cible PANEL (ADDITIF) : `panel: "member" | "judge"` + `panelIndex` ──
  // Un client antérieur (qui n'envoie ni l'un ni l'autre) garde exactement le
  // comportement d'avant : `stepIndex` seul, ou chaîne complète.
  let panel: PanelTestTarget | undefined;
  if (record.panel !== undefined && record.panel !== null) {
    if (record.panel === "judge") panel = { role: "judge" };
    else if (record.panel === "member") {
      const rawIndex = record.panelIndex;
      if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0) {
        errors.push("panelIndex: doit être un entier positif ou nul (0 = proposition A)");
      } else panel = { role: "member", index: rawIndex };
    } else errors.push('panel: doit valoir "member" ou "judge"');
  } else if (record.panelIndex !== undefined && record.panelIndex !== null) {
    errors.push('panelIndex: n\'a de sens qu\'avec panel: "member"');
  }
  if (panel && stepIndex !== undefined) {
    errors.push("stepIndex et panel: une seule cible à la fois");
  }

  if (errors.length > 0) throw ApiError.validation(errors);
  return {
    prompt,
    maxTokens,
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    ...(panel ? { panel } : {}),
  };
}

router.get("/", (_req: Request, res: Response) => {
  res.json({ services: listServices() });
});

router.post("/", requireCsrfForSession, rejectDefaultPassword, async (req: Request, res: Response) => {
  try {
    const service = await runCatalogMutation(() => createService(req.body));
    res.status(201).json({ service });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.put("/:name", requireCsrfForSession, rejectDefaultPassword, async (req: Request, res: Response) => {
  try {
    const service = await runCatalogMutation(() => updateService(String(req.params.name), req.body));
    res.json({ service });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.delete("/:name", requireCsrfForSession, rejectDefaultPassword, async (req: Request, res: Response) => {
  try {
    await runCatalogMutation(() => deleteService(String(req.params.name)));
    res.status(204).end();
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

/**
 * TEST d'une étape (bouton « Tester » par étape, et zone « Tester les modèles »).
 *
 * Corps : `{ stepIndex?: number, prompt?: string, maxTokens?: number,
 *           panel?: "member" | "judge", panelIndex?: 0|1|2 }`
 *   - `stepIndex` absent et `panel` absent → CHAÎNE COMPLÈTE (principal puis
 *     replis, comme la production) ;
 *   - `stepIndex: 0` → principal SEUL ;
 *   - `stepIndex: n` → repli n-1 SEUL (aucun repli derrière : on teste bien CETTE
 *     étape) ;
 *   - `panel: "member"` + `panelIndex: 0|1|2` → UN membre du panel (A/B/C) SEUL,
 *     avec le corps EXACT de la production (squelette compris) ;
 *   - `panel: "judge"` → le JUGE SEUL, avec des propositions FACTICES — jamais
 *     les 3 membres (ce serait 4 appels pour un diagnostic).
 *
 * ⚠️ ADDITIF : `panel`/`panelIndex` sont facultatifs et exclusifs de `stepIndex`;
 * un client antérieur (chaîne complète ou `stepIndex`) n'est pas affecté.
 *
 * Réponse 200 (même en cas d'échec fournisseur — le résultat est un DIAGNOSTIC) :
 * `{ ok, status, stepIndex, providerId, model, reasoning, latencyMs,
 *    tokens: { prompt, completion, reasoning }, text?, error?: { code, reason,
 *    message }, fellBack, panel?: { role, index? } }`.
 *
 * 400 `VALIDATION_ERROR` (index hors bornes, cible panel invalide ou absente de
 * ce service, prompt vide…), 404 `NOT_FOUND` (service inconnu). ⚠️ Aucun secret,
 * aucun corps amont brut, aucune URL de fournisseur dans la réponse.
 */
router.post("/:name/test", requireCsrfForSession, rejectDefaultPassword, async (req: Request, res: Response) => {
  let parsed: ReturnType<typeof testBody>;
  try {
    parsed = testBody(req.body);
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
    return;
  }

  // Nombre d'étapes connu AVANT l'appel : un index hors bornes est une erreur de
  // requête (400), pas un appel fournisseur inutile.
  const service = getService(String(req.params.name));
  if (!service) {
    res.status(404).json({ error: `service "${req.params.name}" not found`, code: "NOT_FOUND" });
    return;
  }
  if (parsed.stepIndex !== undefined && parsed.stepIndex >= 1 + service.fallbacks.length) {
    res.status(400).json({
      error: `stepIndex: doit être un entier entre 0 et ${service.fallbacks.length}`,
      code: "VALIDATION_ERROR",
      errors: [`stepIndex: doit être un entier entre 0 et ${service.fallbacks.length}`],
    });
    return;
  }
  // Cible PANEL : refusée proprement quand le service n'a pas de panel ou quand
  // l'index de membre sort des bornes — aucun appel ne doit partir pour rien.
  if (parsed.panel) {
    const panel = service.panel;
    const members = panel ? panel.members.length : 0;
    const memberIndex = parsed.panel.role === "member" ? parsed.panel.index : undefined;
    const invalid =
      !panel ||
      (memberIndex !== undefined && (memberIndex < 0 || memberIndex >= members));
    if (invalid) {
      const errors = !panel
        ? ["panel: ce service n'a pas de mode panel"]
        : [`panelIndex: doit être un entier entre 0 et ${Math.max(0, members - 1)}`];
      res.status(400).json({ error: errors[0], code: "VALIDATION_ERROR", errors });
      return;
    }
  }

  try {
    const result = await testServiceStep({
      serviceName: service.name,
      body: {
        messages: [{ role: "user", content: parsed.prompt }],
        max_tokens: parsed.maxTokens,
      },
      ...(parsed.stepIndex !== undefined ? { stepIndex: parsed.stepIndex } : {}),
      ...(parsed.panel ? { panel: parsed.panel } : {}),
      timeoutMs: TEST_TIMEOUT_MS,
      keyName: requestKeyName(req),
      endpoint: "test",
    });
    res.json(result);
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

export default router;
