/**
 * Compteur d'appels EN VOL par clé d'API — mesure DIFFÉRENTE des places de
 * concurrence de `slot-queue.ts` :
 *
 *   - `slot-queue.ts` compte les places occupées PAR FOURNISSEUR (la limite
 *     appartient au compte du fournisseur) ;
 *   - ici on compte les appels en cours PAR CLÉ (qui appelle, pas où).
 *
 * Une même clé peut appeler plusieurs fournisseurs : les deux mesures restent
 * donc visibles côte à côte dans l'onglet « Activité ».
 *
 * ⚠️ Règle absolue : `end()` doit être appelé dans un `finally` couvrant TOUS
 * les chemins (succès, erreur, annulation, fermeture du client) — un compteur
 * qui fuit fausse définitivement l'affichage. `end()` est idempotent par
 * construction (le compteur ne descend jamais sous zéro).
 *
 * La clé est identifiée par son NOM (voir `requestKeyName` dans
 * `middleware/api-auth.ts`) : jamais un secret, jamais un hash.
 */
import { KEY_NAME_UNKNOWN } from "../middleware/api-auth.js";
import { notifyLiveChange } from "../live/events.js";

const counters = new Map<string, number>();

/** Normalise un nom de clé (vide → `"inconnu"`). */
function normalize(keyName: unknown): string {
  const name = typeof keyName === "string" ? keyName.trim() : "";
  return name === "" ? KEY_NAME_UNKNOWN : name;
}

/** Un appel démarre pour cette clé. */
export function beginCall(keyName: string): void {
  const name = normalize(keyName);
  counters.set(name, (counters.get(name) ?? 0) + 1);
  // Émis APRÈS la mise à jour : le direct relit `inFlightByKey()`.
  notifyLiveChange();
}

/** Un appel se termine pour cette clé (à appeler dans un `finally`). */
export function endCall(keyName: string): void {
  const name = normalize(keyName);
  const current = counters.get(name) ?? 0;
  if (current <= 1) counters.delete(name);
  else counters.set(name, current - 1);
  notifyLiveChange();
}

/** Appels en vol pour UNE clé (0 si aucun). */
export function inFlightFor(keyName: string): number {
  return counters.get(normalize(keyName)) ?? 0;
}

/** Photographie des appels en vol, par nom de clé (seules les clés actives). */
export function inFlightByKey(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of counters) if (count > 0) out[name] = count;
  return out;
}

/** Remise à zéro (outil de test : le compteur vit au niveau du process). */
export function resetInFlightCounters(): void {
  counters.clear();
}
