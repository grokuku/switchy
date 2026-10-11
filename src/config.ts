/**
 * Configuration de Switchy — lecture PARESSEUSE et À CHAUD des réglages.
 *
 * Les getters relisent l'environnement à chaque appel (et consultent le fichier
 * de réglages `$SWITCHY_DATA_DIR/config.json` en repli) : les tests peuvent donc
 * isoler chaque suite dans un répertoire de données temporaire sans recharger
 * les modules, et une valeur écrite via l'API de configuration est prise en
 * compte SANS redémarrage. Modèle de résolution : `env ?? fichier ?? défaut`.
 *
 * ⚠️ Réglages « redémarrage requis » (lus UNE fois au démarrage, hors getters) :
 * SWITCHY_HOST, SWITCHY_PORT, SWITCHY_RATE_LIMIT_PER_MIN et SWITCHY_DATA_DIR.
 */
import path from "path";
import { resolveSetting } from "./settings-store.js";

function readEnv(name: string, fallback: string): string {
  return resolveSetting(name, fallback);
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

/** Fichier de la collection fournisseurs + services (source de vérité versionnable). */
export function getCatalogFile(): string {
  return path.resolve(readEnv("SWITCHY_CATALOG_FILE", path.join(getDataDir(), "catalog.json")));
}

/** Fichier JSON des clés d'API de Switchy. */
export function getKeysFile(): string {
  return path.resolve(readEnv("SWITCHY_KEYS_FILE", path.join(getDataDir(), "switchy-keys.json")));
}

/**
 * Clé d'API optionnelle fournie par l'environnement (secret), acceptée pour les
 * OUTILS en plus des clés nommées créées depuis l'interface. Aucun « mode
 * amorçage » : sans clé valide NI session admin, l'API répond 401.
 */
export function getApiKey(): string {
  return readEnv("SWITCHY_API_KEY", "");
}

export function getLogLevel(): string {
  return readEnv("SWITCHY_LOG_LEVEL", "info");
}

/**
 * Plafond de concurrence PAR DÉFAUT d'un fournisseur qui ne précise pas son
 * `ProviderRecord.maxConcurrency` (relu à chaud).
 *
 * ⚠️ Ce n'est PLUS une limite globale unique : la concurrence est comptée PAR
 * FOURNISSEUR (chaque compte a son seau). Cette valeur est le simple défaut
 * (Ollama Cloud Pro autorise 3 requêtes simultanées par compte, toutes clés
 * confondues) ; un fournisseur précis peut la surcharger. On ne garde PAS de
 * plafond global « toutes enseignes » : il réintroduirait exactement le couplage
 * entre fournisseurs que ce changement supprime.
 */
export function getConcurrency(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_CONCURRENCY", "3"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

/**
 * Nombre maximal de demandes en attente d'un slot LLM (0 = pas d'attente :
 * 429 immédiat dès que la limite globale est atteinte).
 */
export function getQueueMax(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_QUEUE_MAX", "100"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
}

/** Attente maximale d'un slot LLM dans la file, en millisecondes (0 = illimité). */
export function getQueueTimeoutMs(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_QUEUE_TIMEOUT_MS", "3600000"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_600_000;
}

/**
 * Délai au-delà duquel un slot LLM est libéré de FORCE par le watchdog, en
 * millisecondes (0 = watchdog désactivé). Filet de sécurité : un client planté
 * ne doit pas bloquer définitivement une place de la limite globale.
 */
export function getSlotWatchdogMs(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_SLOT_WATCHDOG_MS", "1800000"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1_800_000;
}

/** Mode du journal d'appels : « off », « summary » (défaut) ou « full ». */
export function getCallsLogMode(): string {
  return readEnv("SWITCHY_CALLS_LOG_MODE", "summary");
}

/** Durée de rétention du journal d'appels, en jours (0 = aucune purge). */
export function getCallsLogRetentionDays(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_CALLS_LOG_RETENTION_DAYS", "7"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
}

/** Nombre maximal d'entrées conservées dans le journal d'appels (0 = illimité). */
export function getCallsLogMaxEntries(): number {
  const parsed = Number.parseInt(readEnv("SWITCHY_CALLS_LOG_MAX_ENTRIES", "10000"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000;
}

/** Fichier du journal d'appels (JSONL). */
export function getCallsLogFile(): string {
  return path.resolve(readEnv("SWITCHY_CALLS_LOG_FILE", path.join(getDataDir(), "calls.jsonl")));
}
