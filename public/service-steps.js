/**
 * Switchy — ÉTAPES D'APPEL d'un service : ordre, libellés, conversion.
 *
 * ┌─ Pourquoi un module à part ? ────────────────────────────────────────────┐
 * │ Le catalogue (`src/catalog-store.ts`) range les étapes en DEUX champs :  │
 * │ `principal` (une étape) + `fallbacks[]` (les suivantes, ordonnées).      │
 * │ L'interface, elle, travaille sur UNE liste ordonnée : la 1re étape est   │
 * │ le principal, les suivantes sont les replis 1, 2… La conversion et le    │
 * │ déplacement vivent ICI, en fonctions PURES (aucun DOM, aucun réseau) —   │
 * │ la carte de service, la fenêtre « Modifier » et les tests (vitest)       │
 * │ partagent donc EXACTEMENT la même logique (source de vérité unique).     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Chargé comme module ES par `public/app.js` (`import { … } from "./service-steps.js"`).
 */

/**
 * Libellé d'une position dans la liste : `0` = principal, `n` = repli n.
 * Sert à RENUMÉROTER après chaque déplacement (aucun libellé n'est figé).
 */
export function stepRoleLabel(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return "étape";
  return n === 0 ? "principal" : `repli ${n}`;
}

/** Copie défensive : jamais de mutation de l'entrée, jamais de `null` renvoyé. */
function asStepList(steps) {
  return Array.isArray(steps) ? steps.slice() : [];
}

/**
 * Déplace UNE étape de `from` vers `to` et renvoie un NOUVEAU tableau (les
 * objets-étapes ne sont jamais copiés ni reconstruits : tous leurs réglages —
 * fournisseur, modèle, niveau de réflexion — suivent le déplacement).
 *
 * `to` est l'index FINAL dans la liste AMPUTÉE de l'étape déplacée (même
 * convention que `splice`) : `moveStep(l, 0, 2)` envoie la 1re étape en 3e
 * position. Toute position hors bornes, non entière, ou un déplacement nul est
 * IGNORÉ (le tableau renvoyé est alors une simple copie).
 */
export function moveStep(steps, from, to) {
  const list = asStepList(steps);
  // Un index doit être un NOMBRE entier (`"0"`, `null`, `undefined` sont refusés :
  // aucune coercition silencieuse, un index invalide ne déplace jamais rien).
  if (typeof from !== "number" || typeof to !== "number") return list;
  const f = from;
  const t = to;
  if (!Number.isInteger(f) || !Number.isInteger(t)) return list;
  if (f < 0 || t < 0 || f >= list.length || t >= list.length) return list;
  if (f === t) return list;
  const moved = list.splice(f, 1)[0];
  list.splice(t, 0, moved);
  return list;
}

/**
 * Position de dépôt → index FINAL pour `moveStep`.
 *
 * `insertionIndex` est la position d'insertion dans la liste ORIGINALE
 * (0 = avant la 1re étape, `length` = après la dernière) ; `moveStep`, lui,
 * attend l'index final dans la liste AMPUTÉE de l'étape déplacée. La
 * conversion vit ici (et non dans le gestionnaire de glisser) pour que la
 * carte et la fenêtre « Modifier » calculent EXACTEMENT pareil.
 *
 * Retourne `from` (déplacement nul, donc ignoré par `moveStep`) si les index
 * sont invalides.
 */
export function dropToIndex(from, insertionIndex) {
  if (typeof from !== "number" || typeof insertionIndex !== "number") return from;
  const f = from;
  const k = insertionIndex;
  if (!Number.isInteger(f) || !Number.isInteger(k) || f < 0 || k < 0) return f;
  return k > f ? k - 1 : k;
}

/** Une étape est « renseignée » dès qu'elle porte un modèle (chaîne non vide). */
function hasModel(step) {
  return !!step && typeof step === "object" && typeof step.model === "string" && step.model.trim() !== "";
}

/**
 * Une étape est-elle ACTIVÉE ? Règle UNIQUE du niveau étape, partagée par la
 * carte, la fenêtre « Modifier » et les tests : seul un `enabled: false`
 * EXPLICITE éteint l'étape. Un champ absent (catalogue antérieur) vaut ACTIVÉE —
 * une étape n'est jamais éteinte par surprise.
 *
 * ⚠️ Ce n'est PAS le `enabled` du SERVICE (bouton maître de la carte) : service
 * désactivé = rien n'est appelé, quelles que soient les étapes.
 */
export function isStepEnabled(step) {
  if (!step || typeof step !== "object") return false;
  return step.enabled !== false;
}

/**
 * Étapes RÉELLEMENT appelables d'une liste ordonnée (les autres sont conservées
 * dans la liste, mais sautées à l'exécution). Sert à compter/annoncer ce qui
 * reste actif — jamais à réordonner : la position d'une étape désactivée ne
 * bouge pas et son libellé suit l'ORDRE, pas l'état.
 */
export function enabledSteps(steps) {
  return asStepList(steps).filter(isStepEnabled);
}

/**
 * Nouvelle liste où l'étape `index` prend l'état `enabled` (booléen strict).
 * Les AUTRES étapes sont renvoyées telles quelles (même identité d'objet) ; les
 * index invalides renvoient une simple copie — jamais d'exception, jamais de
 * mutation de l'entrée (la carte en a besoin pour revenir en arrière si
 * l'enregistrement échoue).
 */
export function withStepEnabled(steps, index, enabled) {
  const list = asStepList(steps);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  const next = enabled === true;
  return list.map((step, i) => (i === index ? { ...step, enabled: next } : step));
}

/**
 * Liste ordonnée → liste RÉELLEMENT envoyable à l'API : les replis restés sans
 * modèle sont écartés (le serveur les refuserait : `fallbacks[i].model: required`).
 *
 * La PREMIÈRE étape (le principal) est TOUJOURS conservée, même vide : elle
 * n'est jamais supprimée en silence, l'appelant peut ainsi afficher une erreur
 * explicite (« l'étape principale doit avoir un modèle »).
 */
export function nonEmptySteps(steps) {
  return asStepList(steps).filter((step, i) => i === 0 || hasModel(step));
}

/**
 * Liste ordonnée → forme de l'API : `{ principal, fallbacks }`.
 * `principal` vaut `null` pour une liste vide (l'appelant doit refuser ce cas :
 * un service garde TOUJOURS au moins une étape).
 */
export function stepsToServiceShape(steps) {
  const list = asStepList(steps);
  return {
    principal: list.length > 0 ? list[0] : null,
    fallbacks: list.slice(1),
  };
}

/**
 * Service de l'API → liste ordonnée `[principal, ...replis]`.
 * Tolère un service absent (`[]`) ou des replis manquants : la lecture d'un
 * catalogue antérieur ne doit jamais échouer.
 */
export function serviceToSteps(service) {
  if (!service || typeof service !== "object") return [];
  const list = [];
  if (service.principal) list.push(service.principal);
  if (Array.isArray(service.fallbacks)) {
    for (const step of service.fallbacks) if (step) list.push(step);
  }
  return list;
}
