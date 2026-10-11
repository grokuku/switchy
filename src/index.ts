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
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { getHost, getPort, getRateLimitPerMin } from "./config.js";
import { catalogCounts } from "./catalog-store.js";
import { requireApiKey } from "./middleware/require-key.js";
import providersRouter from "./routes/providers.js";
import servicesRouter from "./routes/services.js";
import settingsRouter from "./routes/settings.js";
import keysRouter from "./routes/keys.js";

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

  // ── API de configuration (Lot 2) — protégée par la clé d'API Switchy ──
  // Montée AVANT le statique : `/api/*` garde toujours la priorité (aucune
  // route API n'est capturée par le service de fichiers).
  app.use("/api/providers", requireApiKey, providersRouter);
  app.use("/api/services", requireApiKey, servicesRouter);
  app.use("/api/settings", requireApiKey, settingsRouter);
  app.use("/api/keys", requireApiKey, keysRouter);

  // ── Interface web statique (coquille de configuration) ──
  // Montée APRÈS le rate-limit et APRÈS /health et /api/* : `public/` est
  // embarqué par le Dockerfile (COPY public) ; résolu depuis src/ comme
  // depuis dist/. Sans fallback SPA : une route inconnue retombe sur le 404
  // d'Express.
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir));

  return app;
}

export const app = createApp();

// N'écoute que si exécuté directement (`node dist/index.js`), pas à l'import.
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  const port = getPort();
  const host = getHost();
  app.listen(port, host, () => {
    console.log(`[switchy] listening on http://${host}:${port} (version ${version})`);
  });
}
