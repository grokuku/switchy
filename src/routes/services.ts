/**
 * Routes des services — `/api/services` (protégées par la clé d'API).
 *
 *   GET    /api/services        → liste des services nommés
 *   POST   /api/services        → création (validation : nom unique, providerId existant, bornes)
 *   PUT    /api/services/:name  → mise à jour
 *   DELETE /api/services/:name  → suppression
 */
import { Router, type Request, type Response } from "express";
import { listServices, createService, updateService, deleteService } from "../catalog-store.js";
import { errorBody } from "../utils/api-error.js";
import { requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ services: listServices() });
});

router.post("/", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    const service = createService(req.body);
    res.status(201).json({ service });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.put("/:name", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    const service = updateService(String(req.params.name), req.body);
    res.json({ service });
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

router.delete("/:name", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  try {
    deleteService(String(req.params.name));
    res.status(204).end();
  } catch (err) {
    const { status, body } = errorBody(err);
    res.status(status).json(body);
  }
});

export default router;
