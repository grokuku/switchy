/**
 * Routes des fournisseurs — `/api/providers` (protégées par la clé d'API).
 *
 *   GET    /api/providers       → liste (clé jamais réaffichée)
 *   POST   /api/providers       → création
 *   PUT    /api/providers/:id   → mise à jour (champ vide = inchangé, null = efface)
 *   DELETE /api/providers/:id   → suppression (refusée si un service l'utilise)
 */
import { Router, type Request, type Response } from "express";
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  toPublicProvider,
} from "../catalog-store.js";
import { errorBody } from "../utils/api-error.js";
import { requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ providers: listProviders().map(toPublicProvider) });
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
