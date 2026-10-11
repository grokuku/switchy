/**
 * Routes des fournisseurs — `/api/providers` (protégées par la clé d'API).
 *
 *   GET    /api/providers       → liste (clé jamais réaffichée)
 *   POST   /api/providers       → création
 *   PUT    /api/providers/:id   → mise à jour (champ vide = inchangé, null = efface)
 *   DELETE /api/providers/:id   → suppression (refusée si un service l'utilise)
 *
 *   GET    /api/providers/:id/models        → modèles exposés (liste déroulante)
 *   GET    /api/providers/:id/models/:model → capacités d'un modèle (contexte, vision…)
 *
 * Les deux routes de découverte interrogent le FOURNISSEUR avec SA clé (jamais
 * celle du client) et sont protégées par l'authentification de Switchy.
 */
import { Router, type Request, type Response } from "express";
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  toPublicProvider,
} from "../catalog-store.js";
import { describeProviderModel, listProviderModels } from "../llm/model-catalog.js";
import { errorBody } from "../utils/api-error.js";
import { requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ providers: listProviders().map(toPublicProvider) });
});

/** `?refresh=1` contourne le cache court (bouton « rafraîchir » de l'interface). */
function wantsRefresh(req: Request): boolean {
  const value = String(req.query.refresh ?? "").toLowerCase();
  return value === "1" || value === "true";
}

/** Décodage défensif d'un nom de modèle (le `%` littéral ne doit jamais lever). */
function decodeModel(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// GET /api/providers/:id/models — liste des modèles du fournisseur.
router.get("/:id/models", async (req: Request, res: Response) => {
  try {
    const models = await listProviderModels(String(req.params.id), { refresh: wantsRefresh(req) });
    res.json({ providerId: String(req.params.id), models });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

// GET /api/providers/:id/models/:model — capacités d'un modèle (route wildcard :
// un identifiant peut contenir `/` — ex. `vendor/model`).
router.get("/:id/models/*", async (req: Request, res: Response) => {
  try {
    const model = decodeModel(String((req.params as Record<string, unknown>)[0] ?? "")).trim();
    if (model === "") {
      res.status(400).json({ error: "model: required in the URL", code: "VALIDATION_ERROR" });
      return;
    }
    const details = await describeProviderModel(String(req.params.id), model, { refresh: wantsRefresh(req) });
    res.json({ model: details });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.post("/", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    const provider = createProvider(req.body);
    res.status(201).json({ provider: toPublicProvider(provider) });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.put("/:id", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    const provider = updateProvider(String(req.params.id), req.body);
    res.json({ provider: toPublicProvider(provider) });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.delete("/:id", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    deleteProvider(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

export default router;
