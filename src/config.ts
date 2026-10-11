/**
 * Configuration de Switchy — lecture PARESSEUSE et À CHAUD des réglages.
 *
 * Les getters relisent l'environnement à CHAQUE appel : les tests peuvent donc
 * isoler chaque suite dans un répertoire de données temporaire sans recharger
 * les modules. Quand l'écran de configuration arrivera (Lot 2), la résolution
 * deviendra `env ?? fichier ?? défaut` (modèle Libry) — les noms de variables
 * et les défauts de ce fichier ne changeront pas.
 *
 * ⚠️ Réglages « redémarrage requis » (lus UNE fois au démarrage) :
 * SWITCHY_HOST, SWITCHY_PORT et SWITCHY_RATE_LIMIT_PER_MIN.
 */
import path from "path";

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

/** Interface d'écoute (redémarrage requis). */
export function getHost(): string {
  return readEnv("SWITCHY_HOST", "0.0.0.0");
}

/** Port d'écoute (redémarrage requis ; Pi-Web 3000/3005, WebClaw 3006, Libry 3007). */
export function getPort(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_PORT", "3008"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3008;
}

/** Répertoire racine des données persistantes (volume docker ; redémarrage requis). */
export function getDataDir(): string {
  return path.resolve(readEnv("SWITCHY_DATA_DIR", "/app/data"));
}

/** Limite de requêtes par minute et par IP (redémarrage requis : capturée au montage). */
export function getRateLimitPerMin(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_RATE_LIMIT_PER_MIN", "600"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}
