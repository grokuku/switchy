/**
 * Affinité de cache PAR CLÉ D'API — mémoire de processus, TTL fixe.
 *
 * ┌─ Pourquoi ? ─────────────────────────────────────────────────────────────┐
 * │ Un fournisseur garde un cache de contexte (prompt caching). En mode       │
 * │ « rolling » (`ServiceRecord.rolling`), un service répartit la charge sur  │
 * │ ses étapes : sans mémoire, une même clé d'API pourrait être servie par un │
 * │ fournisseur différent à chaque appel et casser son cache à chaque fois.   │
 * │ On retient donc le DERNIER fournisseur qui a RÉPONDU pour cette clé et on │
 * │ le reprend en priorité s'il est une étape du service et qu'une place y    │
 * │ est libre.                                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Règles tenues ici :
 *   - mémoire EN PROCESSUS uniquement (aucune écriture disque, aucune reprise
 *     au redémarrage) : c'est une optimisation, pas une donnée de service ;
 *   - TTL FIXE de 5 minutes (`KEY_AFFINITY_TTL_MS`) : garde-fou VOULU — au-delà,
 *     l'affinité expire et le principal reprend la main (on ne colle pas
 *     indéfiniment à un repli) ;
 *   - purge PARESSEUSE (à chaque lecture/écriture) : aucun timer, donc aucun
 *     risque de retenir le process ;
 *   - ⚠️ SÉCURITÉ : on ne stocke QUE le NOM de la clé (déjà journalisé comme
 *     `keyName`) et un `providerId`. Jamais la valeur d'une clé, jamais un
 *     prompt. `"session"` / `"inconnu"` sont des noms comme les autres.
 */
/**
 * Durée de vie de l'affinité : 5 MINUTES FIXES (décision utilisateur).
 * ⚠️ Volontairement NON réglable dans l'interface pour l'instant : cette
 * constante est la seule source de vérité.
 */
export const KEY_AFFINITY_TTL_MS = 5 * 60_000;

/** Affinité mémorisée : le fournisseur et l'instant d'enregistrement (ms epoch). */
export interface KeyAffinityEntry {
  providerId: string;
  at: number;
}

/**
 * Nom de clé utilisé comme clé de mémoire — c'est DÉJÀ le seul identifiant que
 * le journal conserve (`keyName`). Un nom vide/absent n'a pas d'affinité (rien
 * à mémoriser, rien à reprendre).
 */
function storeKey(keyName: unknown): string | null {
  if (typeof keyName !== "string") return null;
  const trimmed = keyName.trim();
  return trimmed === "" ? null : trimmed;
}

/** Mémoire des affinités (une entrée par nom de clé). */
const entries = new Map<string, KeyAffinityEntry>();

/** Purge PARESSEUSE : écarte les entrées expirées (aucun timer). */
function purge(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.at >= KEY_AFFINITY_TTL_MS) entries.delete(key);
  }
}

/**
 * Mémorise le fournisseur qui vient de RÉPONDRE pour cette clé.
 * ⚠️ À n'appeler qu'après un SUCCÈS : un échec ne dit rien du cache chaud.
 */
export function rememberProvider(keyName: unknown, providerId: unknown, now: number = Date.now()): void {
  const key = storeKey(keyName);
  if (!key) return;
  if (typeof providerId !== "string" || providerId.trim() === "") return;
  purge(now);
  entries.set(key, { providerId, at: now });
}

/**
 * Fournisseur mémorisé pour cette clé, ou `null` s'il n'y en a pas (clé sans
 * historique) ou si l'affinité a EXPIRÉ (au-delà de `KEY_AFFINITY_TTL_MS`).
 * ⚠️ Ne dit RIEN de la disponibilité : l'appelant vérifie que ce fournisseur
 * est bien une étape du service ET qu'une place y est libre.
 */
export function preferredProvider(keyName: unknown, now: number = Date.now()): string | null {
  const key = storeKey(keyName);
  if (!key) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (now - entry.at >= KEY_AFFINITY_TTL_MS) {
    entries.delete(key); // expiration à la lecture
    return null;
  }
  return entry.providerId;
}

/** Oublie l'affinité d'une clé (ou de toutes) — utile aux tests et au redémarrage logique. */
export function forgetAffinity(keyName?: unknown): void {
  if (keyName === undefined) {
    entries.clear();
    return;
  }
  const key = storeKey(keyName);
  if (key) entries.delete(key);
}

/** Nombre d'entrées vivantes (diagnostic, tests). */
export function affinityCount(): number {
  return entries.size;
}

/** Remise à zéro complète (outil de test : la mémoire est partagée par process). */
export function resetKeyAffinity(): void {
  entries.clear();
}
