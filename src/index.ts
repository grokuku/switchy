/**
 * Point d'entrée du service Switchy.
 *
 * Express : limitation de débit, route de santé `/health` (alignée sur les
 * autres services de l'écosystème) et interface web statique. `createApp()`
 * est exporté pour les tests ; le serveur n'écoute que si le fichier est
 * exécuté directement.
 *
 * Le cœur de la passerelle (services LLM nommés, relais vers les fournisseurs,
 * comptage global des appels en vol, journal d'appels) se montera sous
 * `/api/*`, AVANT le service statique — jamais l'inverse.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { getHost, getPort, getRateLimitPerMin } from "./config.js";
import { catalogCounts } from "./catalog-store.js";
import { checkDataDir } from "./settings-store.js";
import { describeAdminPasswordState } from "./session-store.js";
import { errorBody } from "./utils/api-error.js";
import { requireApiAuth } from "./middleware/api-auth.js";
import sessionRouter from "./routes/session.js";
import providersRouter from "./routes/providers.js";
import servicesRouter from "./routes/services.js";
import settingsRouter from "./routes/settings.js";
import keysRouter from "./routes/keys.js";
import { llmRouter, openaiRouter } from "./routes/llm.js";
import { systemOneRouter, systemOneRootRouter } from "./routes/system-one.js";
import nativeRouter from "./routes/native.js";
import callsRouter from "./routes/calls.js";
import dashboardRouter from "./routes/dashboard.js";
import { attachActivityWs } from "./live/ws.js";

/** Version du package, lue à côté du point d'entrée (src/ comme dist/). */
export const version: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  // ── Limitation de débit ──
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: getRateLimitPerMin(),
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  // ── Santé (liveness, aligné sur les services de l'écosystème) ──
  // Compteurs utiles sans casser la forme { service, status, version }.
  app.get("/health", (_req: Request, res: Response) => {
    const counts = catalogCounts();
    res.json({
      service: "switchy",
      status: "ok",
      version,
      providers: counts.providers,
      services: counts.services,
    });
  });

  // ── Connexion / session (Lot 4) — PUBLIQUE (aucune clé ni session exigée) ──
  // POST /api/session/login, POST /api/session/logout, GET /api/session,
  // POST /api/session/password. Monté AVANT les routes protégées : c'est le
  // point d'entrée de l'HUMAIN (mot de passe + cookie de session signé HMAC).
  app.use("/api/session", sessionRouter);

  // ── API de configuration (Lot 2) — session d'admin OU clé d'API des outils ──
  // Montée AVANT le statique : `/api/*` garde toujours la priorité (aucune
  // route API n'est capturée par le service de fichiers). La clé d'API
  // (`Authorization: Bearer` / `X-API-Key`) reste le contrat des outils ; la
  // session (cookie) est celui du navigateur.
  app.use("/api/providers", requireApiAuth, providersRouter);
  app.use("/api/services", requireApiAuth, servicesRouter);
  app.use("/api/settings", requireApiAuth, settingsRouter);
  app.use("/api/keys", requireApiAuth, keysRouter);

  // ── Cœur du gateway (Lot 3) ──
  // Relais LLM (services nommés + replis + concurrence globale + journal),
  // relais de l'API NATIVE des fournisseurs (découverte des modèles), et
  // consultation du journal d'appels.
  app.use("/api/llm", requireApiAuth, llmRouter);
  // Second TYPE D'API, géré NATIVEMENT (aucune conversion vers le chat) :
  // `POST /api/system/:service` et `POST /v1/systemone` (`model` = nom du
  // service). Même auth, même journal, mêmes replis que le relais chat.
  app.use("/api/system", requireApiAuth, systemOneRouter);
  app.use("/v1/systemone", requireApiAuth, systemOneRootRouter);
  // `/v1` = surface compatible OpenAI : POST /chat/completions (relais) ET
  // GET /models + GET /models/:id (liste des services activés). Un SEUL routeur
  // monté : aucun ordre de handler à surveiller entre les deux familles.
  app.use("/v1", requireApiAuth, openaiRouter);
  app.use("/api/native", requireApiAuth, nativeRouter);
  app.use("/api/calls", requireApiAuth, callsRouter);
  // Tableau de bord d'activité : une SEULE requête pour tout l'onglet.
  app.use("/api/dashboard", requireApiAuth, dashboardRouter);

  // ── Interface web statique (coquille de configuration) ──
  // Montée APRÈS le rate-limit et APRÈS /health et /api/* : `public/` est
  // embarqué par le Dockerfile (COPY public) ; résolu depuis src/ comme
  // depuis dist/. Sans fallback SPA : une route inconnue retombe sur le 404
  // d'Express.
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir));

  // ── Erreurs TOUJOURS en JSON ──
  // Sans ce gestionnaire, une exception hors d'une route (ex. écriture
  // impossible dans le dossier de données) produisait une page HTML 500
  // « Error: EACCES… » que l'interface ne savait pas lire : elle l'affichait
  // comme « mot de passe incorrect ». Ici, toute erreur devient un corps JSON
  // { error, code } homogène (503 STORAGE_NOT_WRITABLE compris).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const { status, body } = errorBody(err);
    if (status >= 500) console.error("[switchy] request failed:", err);
    res.status(status).json(body);
  });

  return app;
}

export const app = createApp();

// N'écoute que si exécuté directement (`node dist/index.js`), pas à l'import.
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  const port = getPort();
  const host = getHost();
  const dataDir = checkDataDir();
  if (dataDir.ok) {
    console.log(`[switchy] data dir: ${dataDir.dir}`);
  } else {
    console.warn(
      `[switchy] WARNING: data directory "${dataDir.dir}" is not writable (${dataDir.error}). ` +
        `Login and saving settings WILL FAIL. Fix ownership/permissions ` +
        `(Docker: chown -R 10001:10001 on the data folder).`,
    );
  }
  console.log(`[switchy] admin password: ${describeAdminPasswordState()}`);
  const server = app.listen(port, host, () => {
    console.log(`[switchy] listening on http://${host}:${port} (version ${version})`);
  });
  // Direct de l'onglet « Activité » : WebSocket `/ws/activity`, même auth que
  // l'API (session OU clé). Branché sur le serveur HTTP réel — le `upgrade`
  // n'existe pas dans Express. Les agrégats restent servis par `/api/dashboard`.
  attachActivityWs(server);
}
