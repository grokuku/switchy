/**
 * Garde d'authentification de l'API de configuration de Switchy.
 *
 * En MODE AMORÇAGE (aucune clé configurée), toute requête passe : c'est ce qui
 * permet de créer la première clé depuis l'interface. Dès qu'au moins une clé
 * existe, présentez-la en `Authorization: Bearer <clé>` OU `X-API-Key: <clé>`.
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKeys, validateKey, resolveIdentity, recordUsage, isAuthRequired } from "../switchy-auth.js";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthRequired()) {
    next();
    return;
  }

  for (const candidate of extractApiKeys(req)) {
    if (validateKey(candidate)) {
      const identity = resolveIdentity(candidate);
      if (identity) recordUsage(identity.id);
      next();
      return;
    }
  }

  res.status(401).json({
    error: "Invalid or missing API key",
    code: "UNAUTHORIZED",
    authRequired: true,
  });
}
