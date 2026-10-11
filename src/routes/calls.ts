/**
 * Consultation du journal d'appels — `GET /api/calls` (protégée par la clé).
 *
 * Pagination : `limit` (défaut 50, max 500), `offset` (défaut 0). Filtres
 * facultatifs : `service` (nom exact), `result` (`ok` | `error` | `aborted` |
 * `skipped`). Le plus récent d'abord. La réponse porte aussi un `summary`
 * (bilan des replis, non filtré) : compteur total / dernières 24 h et
 * répartitions par service et par fournisseur de repli sollicité.
 */
import { Router, type Request, type Response } from "express";
import { readCallsLog } from "../llm/calls-log.js";

function intParam(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const page = readCallsLog({
    limit: intParam(req.query.limit),
    offset: intParam(req.query.offset),
    service: typeof req.query.service === "string" && req.query.service !== "" ? req.query.service : undefined,
    result: typeof req.query.result === "string" && req.query.result !== "" ? req.query.result : undefined,
  });
  res.json(page);
});

export default router;
