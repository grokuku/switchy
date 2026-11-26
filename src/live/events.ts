/**
 * Bus d'événements INTERNE du temps réel (aucune dépendance, aucun I/O).
 *
 * Pourquoi un bus séparé des modules métier ? Le direct a besoin d'être notifié
 * par trois endroits déjà existants :
 *   - `llm/slot-queue.ts`      → place acquise / libérée (par fournisseur) ;
 *   - `llm/inflight-by-key.ts` → appel commencé / terminé (par clé) ;
 *   - `llm/calls-log.ts`       → une tentative vient d'être journalisée.
 *
 * Ces modules ne doivent RIEN connaître du WebSocket (sinon couplage inverse et
 * cycles d'import). Ils se contentent donc d'appeler `notifyLiveChange()` /
 * `notifyCallLogged()` : c'est `live/hub.ts` qui écoute, agrège et pousse.
 *
 * ⚠️ Les notifications sont volontairement « best effort » : un abonné qui
 * lève une exception ne doit jamais faire échouer un appel LLM (même règle que
 * le journal d'appels).
 */

/**
 * Ligne d'appel poussée en direct. Volontairement plus étroite que
 * `CallLogEntry` : NI identité d'appelant (`keyName`), NI message d'erreur
 * libre, NI prompt — le direct n'en a pas besoin (voir `hub.ts`).
 */
export interface LiveCallEvent {
  ts?: string;
  callId?: string;
  attempt?: number;
  isFallback?: boolean;
  service?: string;
  provider?: string;
  model?: string;
  result?: string;
  status?: number;
  reason?: string;
  durationMs?: number;
  tokens?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  charge?: boolean;
  affinity?: boolean;
  stream?: boolean;
}

const liveListeners = new Set<() => void>();
const callListeners = new Set<(entry: LiveCallEvent) => void>();

/** S'abonne aux changements d'état « direct » (places, appels en vol). */
export function onLiveChange(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

/** S'abonne aux tentatives qui viennent d'être journalisées. */
export function onCallLogged(listener: (entry: LiveCallEvent) => void): () => void {
  callListeners.add(listener);
  return () => callListeners.delete(listener);
}

/** Signale un changement d'état direct. Ne lève jamais. */
export function notifyLiveChange(): void {
  for (const listener of liveListeners) {
    try {
      listener();
    } catch (err) {
      console.error("[live] listener failed:", err);
    }
  }
}

/** Signale une tentative terminée. Ne lève jamais. */
export function notifyCallLogged(entry: LiveCallEvent): void {
  for (const listener of callListeners) {
    try {
      listener(entry);
    } catch (err) {
      console.error("[live] call listener failed:", err);
    }
  }
}

/** Nombre d'abonnés (outil de test : vérifie l'absence de fuite). */
export function liveListenerCount(): number {
  return liveListeners.size;
}

/** Nombre d'abonnés « call » (outil de test). */
export function callListenerCount(): number {
  return callListeners.size;
}
