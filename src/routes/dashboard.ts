/**
 * Tableau de bord d'activité — `GET /api/dashboard` (protégée par la clé ou la
 * session admin).
 *
 * Réponse UNIQUE pour tout l'onglet « Activité » : l'interface se rafraîchit
 * toutes les ~5 s et évite ainsi de multiplier les appels. Aucune donnée
 * sensible (le journal ne contient ni clé, ni prompt, ni corps).
 */
import { Router, type Request, type Response } from "express";
import { buildDashboard } from "../llm/dashboard.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json(buildDashboard());
});

export default router;
