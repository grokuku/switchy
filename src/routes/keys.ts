/**
 * Routes des clés d'API de Switchy — `/api/keys` (protégées par
 * `requireApiAuth` : session d'administration OU clé d'API).
 *
 *   GET    /api/keys       → liste (aperçu masqué, jamais le secret ni le hash)
 *   POST   /api/keys       → création ; renvoie le SECRET UNE SEULE FOIS
 *   DELETE /api/keys/:id   → révocation
 *
 * ⚠️ Ces clés sont destinées aux OUTILS (Pi-Web, Yuki, Kinoscribe…). Elles se
 * créent désormais APRÈS connexion depuis l'interface. Mutations depuis une
 * session : CSRF exigé, et refusées tant que le mot de passe admin est le
 * défaut (403 `PASSWORD_NOT_CHANGED`).
 */
import { Router, type Request, type Response } from "express";
import { listKeys, createKey, revokeKey } from "../switchy-auth.js";
import { requireCsrfForSession, rejectDefaultPassword } from "../middleware/api-auth.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ keys: listKeys() });
});

router.post("/", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return res.status(400).json({ error: "name is required", code: "VALIDATION_ERROR" });
  }
  try {
    const { key, secret } = createKey(body.name);
    res.status(201).json({ key, secret });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message, code: "VALIDATION_ERROR" });
  }
});

router.delete("/:id", requireCsrfForSession, rejectDefaultPassword, (req: Request, res: Response) => {
  if (!revokeKey(String(req.params.id))) {
    return res.status(404).json({ error: "key not found", code: "NOT_FOUND" });
  }
  res.status(204).end();
});

export default router;
