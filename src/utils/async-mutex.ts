/**
 * Mutex FIFO minimal (chaîne de promesses) — AUCUNE dépendance ajoutée.
 *
 * Sert à SÉRIALISER les mutations de fichiers qui font un
 * « lire → modifier → écrire » : deux mutations concurrentes qui lisent le même
 * état puis écrivent chacune le leur perdent la première modification
 * (dernier écrivain gagnant). Avec le mutex, la seconde attend que la première
 * ait fini (écriture comprise) avant de relire.
 *
 * `run` ne rejette jamais pour cause de file d'attente : une tâche en échec
 * n'empêche pas les suivantes de s'exécuter (l'erreur est propagée à
 * l'appelant de CETTE tâche uniquement).
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Exécute `fn` quand la file est libre ; retourne son résultat (ou son erreur). */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // La queue ne doit jamais rester « rejetée » (sinon les tâches suivantes
    // seraient sautées) : on l'aplatit en succès.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
