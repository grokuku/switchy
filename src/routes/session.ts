/**
 * Routes de connexion / session de Switchy — `/api/session` (PUBLIQUES, hors
 * garde de clé d'API : la connexion doit rester atteignable sans authentification).
 *
 *   POST /api/session/login    → vérifie le mot de passe admin, émet la session
 *                                (cookie `switchy_session` HttpOnly/SameSite=Strict)
 *                                et le jeton CSRF. Rate-limit dédié anti-force brute.
 *   POST /api/session/logout   → vide le cookie de session.
 *   GET  /api/session          → `{authenticated, csrfToken}` ; `passwordIsDefault`
 *                                n'est révélé QUE dans une session valide.
 *   POST /api/session/password → change le mot de passe admin (vérifie `current`)
 *                                et incrémente l'époque → invalide toutes les sessions.
 *   POST /api/session/revoke   → révoque TOUTES les sessions (incrémente l'époque
 *                                de session, distincte de celle du mot de passe).
 *
 * Aucune clé d'API n'est créée ni stockée ici : les CLÉS D'API des outils restent
 * gérées par `/api/keys` (voir `routes/keys.ts`).
 */
import { Router, type Request, type Response } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { requireCsrf, requireCsrfForSession, requireSession } from "../middleware/api-auth.js";
import {
  issueSession,
  verifyAdminPassword,
  setAdminPassword,
  revokeAllSessions,
  getSessionFromRequest,
  isPasswordDefault,
  csrfTokenForRequest,
  getSessionTtlSeconds,
  sessionCookieHeader,
  clearSessionCookieHeader,
  csrfCookieHeader,
} from "../session-store.js";

const router = Router();

// ── Rate-limit DÉDIÉ du login (anti-force brute) ──
// 5 ÉCHECS/min/IP. `skipSuccessfulRequests` est essentiel : une connexion
// RÉUSSIE ne doit pas consommer le quota — sinon un utilisateur qui se connecte
// 5 fois dans la minute finissait bloqué (429) alors que son mot de passe était
// BON, et croyait que « le mot de passe ne marche pas ». Store dédié,
// réinitialisable en test.
const LOGIN_RATE_LIMIT = 5;
const loginStore = new MemoryStore();
const loginRateLimiter = rateLimit({
  store: loginStore,
  windowMs: 60_000,
  limit: LOGIN_RATE_LIMIT,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many failed login attempts, try again later", code: "LOGIN_RATE_LIMITED" },
});

/** Réinitialise le compteur du rate-limit de login (outil de test). */
export async function resetLoginRateLimitForTests(): Promise<void> {
  await loginStore.resetAll();
}

/** Durée de vie (secondes) du cookie CSRF, alignée sur la session. */
function csrfMaxAge(): number {
  return getSessionTtlSeconds() || 12 * 3600;
}

// POST /api/session/login — connexion (rate-limit dédié, CSRF double-submit).
router.post("/login", loginRateLimiter, requireCsrf, (req: Request, res: Response) => {
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || password === "") {
    return res.status(400).json({ error: "password is required" });
  }
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({
      error: "Invalid password",
      code: "INVALID_PASSWORD",
      hint: "The default password 'admin' is only accepted while NO password has been set in the data directory.",
    });
  }
  const session = issueSession();
  const ttl = getSessionTtlSeconds();
  res.setHeader("Set-Cookie", [
    sessionCookieHeader(req, session.token, ttl),
    csrfCookieHeader(req, session.csrfToken, csrfMaxAge()),
  ]);
  res.json({ authenticated: true, passwordIsDefault: isPasswordDefault(), csrfToken: session.csrfToken });
});

// POST /api/session/logout — déconnexion (vide le cookie de session).
router.post("/logout", requireCsrfForSession, (req: Request, res: Response) => {
  res.setHeader("Set-Cookie", clearSessionCookieHeader(req));
  res.json({ success: true });
});

// GET /api/session — état de session + jeton CSRF.
// `passwordIsDefault` n'apparaît QUE pour une session valide (jamais anonyme).
router.get("/", (req: Request, res: Response) => {
  const session = getSessionFromRequest(req);
  const csrfToken = csrfTokenForRequest(req);
  res.setHeader("Set-Cookie", csrfCookieHeader(req, csrfToken, csrfMaxAge()));
  if (session) {
    res.json({ authenticated: true, passwordIsDefault: isPasswordDefault(), csrfToken });
  } else {
    res.json({ authenticated: false, csrfToken });
  }
});

// POST /api/session/revoke — révoque TOUTES les sessions (y compris la courante).
// Incrémente l'époque de SESSION (distincte de celle du mot de passe) : tout jeton
// déjà émis — donc tout cookie intercepté — est refusé au prochain appel.
// ⚠️ Session obligatoire (une clé d'API ne peut pas révoquer la session d'un humain),
// mais PAS de garde-fou « mot de passe par défaut » : la révocation ne peut pas
// enfermer dehors (on se reconnecte avec le mot de passe courant, `admin` compris).
router.post("/revoke", requireSession, requireCsrf, (req: Request, res: Response) => {
  const epoch = revokeAllSessions();
  res.setHeader("Set-Cookie", clearSessionCookieHeader(req));
  res.json({ success: true, sessionEpoch: epoch });
});

// POST /api/session/password — change le mot de passe admin (invalide les sessions).
// ⚠️ SESSION OBLIGATOIRE (cookie) : une clé d'API est REFUSÉE ici. Sinon un
// porteur de `SWITCHY_API_KEY` pouvait changer le mot de passe admin — y compris
// pendant que le défaut `admin` était encore en vigueur.
// ⚠️ LIMITEUR de login appliqué : sans lui, un porteur de clé testait `current`
// à ~600 essais/minute (scrypt synchrone à chaque fois).
// Autorisé même tant que le mot de passe courant est le défaut (c'est la sortie) :
// l'amorçage reste possible (login `admin` → cette route).
router.post("/password", loginRateLimiter, requireSession, requireCsrf, (req: Request, res: Response) => {
  const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };
  if (typeof current !== "string" || typeof next !== "string") {
    return res.status(400).json({ error: "current and next are required" });
  }
  if (next.trim().length < 4) {
    return res.status(400).json({ error: "next password must be at least 4 characters" });
  }
  if (!verifyAdminPassword(current)) {
    return res.status(401).json({ error: "Current password is incorrect", code: "INVALID_PASSWORD" });
  }
  setAdminPassword(next);
  // L'époque a changé : le cookie courant est désormais invalide, on le vide.
  res.setHeader("Set-Cookie", clearSessionCookieHeader(req));
  res.json({ success: true });
});

export default router;
