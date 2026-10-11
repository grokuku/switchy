/**
 * Garde d'authentification de l'API de configuration de Switchy.
 *
 * Une requête est autorisée par DEUX origines complémentaires :
 *   1. une CLÉ D'API valide (`Authorization: Bearer` ou `X-API-Key`) — c'est le
 *      contrat des OUTILS (Pi-Web, Yuki, Kinoscribe…) : inchangé ;
 *   2. une SESSION d'administration valide (cookie `switchy_session` signé HMAC)
 *      — c'est la connexion de l'HUMAIN depuis l'interface web.
 *
 * ⚠️ Plus de « mode amorçage » : l'API n'est JAMAIS ouverte. Sans clé ni session
 * valide, la réponse est 401 `UNAUTHORIZED` (JSON, jamais l'interface).
 *
 * CSRF : les mutations autorisées par un COOKIE DE SESSION (auth « ambiante »)
 * exigent le double-submit `X-CSRF-Token` ; les appels scriptés (clé en en-tête)
 * ne sont pas concernés — leur contrat reste identique.
 *
 * Garde-fou mot de passe par défaut : tant que `isPasswordDefault` est vrai, une
 * action SENSIBLE demandée DEPUIS UNE SESSION est refusée en 403
 * `PASSWORD_NOT_CHANGED`. Les accès scriptés restent inchangés ; se connecter,
 * lire et changer le mot de passe restent permis.
 */
import { type Request, type Response, type NextFunction } from "express";
import { extractApiKeys, validateKey, resolveIdentity, recordUsage } from "../switchy-auth.js";
import { getSessionFromRequest, hasSessionCookie, verifyCsrfToken, isPasswordDefault } from "../session-store.js";

/** Vrai si la requête porte une clé d'API valide OU une session admin valide. */
export function isApiAuthorized(req: Request): boolean {
  if (extractApiKeys(req).some((key) => validateKey(key))) return true;
  return getSessionFromRequest(req) !== null;
}

/** Exige une clé d'API valide OU une session admin ; 401 sinon. */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  for (const candidate of extractApiKeys(req)) {
    if (validateKey(candidate)) {
      const identity = resolveIdentity(candidate);
      if (identity) recordUsage(identity.id);
      next();
      return;
    }
  }
  if (getSessionFromRequest(req) !== null) {
    next();
    return;
  }
  res.status(401).json({
    error: "Authentication required",
    code: "UNAUTHORIZED",
    authRequired: true,
  });
}

/** Exige le double-submit CSRF (en-tête `X-CSRF-Token` == cookie `switchy_csrf`). */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!verifyCsrfToken(req)) {
    res.status(403).json({ error: "Invalid or missing CSRF token", code: "CSRF_FAILED" });
    return;
  }
  next();
}

/**
 * Exige le CSRF UNIQUEMENT quand l'authentification repose sur un cookie de
 * session (auth ambiante). Les appels scriptés (clé en en-tête) n'ont pas de
 * cookie : ils passent — leur contrat reste inchangé.
 */
export function requireCsrfForSession(req: Request, res: Response, next: NextFunction): void {
  if (hasSessionCookie(req)) {
    requireCsrf(req, res, next);
    return;
  }
  next();
}

/**
 * Garde-fou « mot de passe par défaut » : refuse une action sensible demandée
 * depuis une session tant que le mot de passe admin est resté le défaut.
 */
export function rejectDefaultPassword(req: Request, res: Response, next: NextFunction): void {
  if (getSessionFromRequest(req) !== null && isPasswordDefault()) {
    res.status(403).json({
      error: "The default admin password must be changed before performing this action",
      code: "PASSWORD_NOT_CHANGED",
    });
    return;
  }
  next();
}
