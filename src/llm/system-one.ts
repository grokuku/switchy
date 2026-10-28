/**
 * API « System One » — SECOND type d'API géré NATIVEMENT par Switchy.
 *
 * ⚠️ Ce n'est PAS du chat : aucun message, aucun prompt, aucune génération de
 * texte. Le client envoie un `state` (texte/JSON/images) et un SCHÉMA de
 * questions typées (`questions`) ; le modèle rend une décision par question en
 * UNE passe non autorégressive (cf. `clef`, modèle de décision Cloudflare servi
 * par Ollama Cloud).
 *
 * ── Contrat implémenté (doc officielle, lue le 2026-10-28) ──────────────────
 * Sources : `docs.ollama.com/api/systemone` (référence d'endpoint),
 * `docs.ollama.com/capabilities/decision` (guide), `ollama.com/library/clef`
 * (fiche du modèle).
 *
 *   POST {base}/v1/systemone                     (⚠️ PAS `/v1/system`)
 *   Authorization: Bearer <clé du FOURNISSEUR>   (Switchy absorbe la clé client)
 *   Content-Type: application/json
 *
 *   Corps :
 *     model      string   requis — modèle entraîné pour System One
 *                         (`clef` en direct sur ollama.com, `clef:cloud` via un
 *                         Ollama local connecté à ollama.com)
 *     state      string | object | any[]  requis, NON VIDE — texte à juger, ou
 *                         objet/tableau sérialisé en JSON. Jamais interprété
 *                         comme des messages ni comme une entrée multimodale.
 *     questions  object   requis — 1 à 64 questions NOMMÉES (noms ≤ 100
 *                         caractères ASCII : lettres, chiffres, `_`, `.`, `-`
 *                         pour les modèles cloud)
 *     images     string[] optionnel — base64 PNG/JPEG/WebP, partagées par toutes
 *                         les questions, dans l'ordre de la requête (modèle
 *                         avec vision, ex. `clef`) ; URLs et data URLs refusées
 *     keep_alive string|number optionnel — LOCAL uniquement (durée de maintien
 *                         du modèle en mémoire)
 *
 *   Question (`questions.<nom>`) : `type` + `instructions` + en général `criteria`
 *     - `choice` : `criteria` = objet option → description (`null` = le nom
 *                  décrit l'option) ; réponse `{ type, choice, probabilities,
 *                  confidence }`
 *     - `noul`   : `criteria` facultatif `{ "true": …, "false": … }` ; réponse
 *                  `{ type, noul }` = probabilité que la réponse soit vraie (0..1)
 *     - `score`  : `criteria` = tableau de 2 à 10 niveaux, du plus bas au plus
 *                  haut (niveaux numérotés depuis 0) ; réponse `{ type, score,
 *                  legend, probabilities, confidence }` — `score` est la moyenne
 *                  pondérée des niveaux
 *
 *   Réponse 200 :
 *     { model, answers: { <nom>: <réponse typée> }, usage: { input_tokens,
 *       output_tokens } }
 *
 *   Erreurs : 400, 401, 402, 404, 413 (corps trop gros), 500 — corps
 *     `{ "error": "<message>" }` relayé TEL QUEL.
 *
 *   ⚠️ La doc est explicite : « Returns one JSON response; streaming, video,
 *   tools, and generation controls are not supported. » → aucun streaming, aucun
 *   `tools`, aucun `temperature`/`max_tokens`. Switchy ne fabrique donc AUCUN
 *   contrôle de génération pour ce type d'API.
 *
 * ── Ce que fait ce module ──────────────────────────────────────────────────
 *   1. VALIDE le corps tel que le client l'a écrit (messages d'erreur explicites,
 *      collecte exhaustive — même style que `catalog-store.ts`) ;
 *   2. le relaie TEL QUEL : `relayService({ api: "systemone" })` ne remplace que
 *      `model` par le modèle réel de l'étape courante du service, et n'ajoute
 *      rien d'autre (`state`, `questions`, `images`, `keep_alive` intacts) ;
 *   3. réutilise TOUT l'existant du relais : concurrence par fournisseur
 *      (`slot-queue`), journal d'appels (`calls-log`, sans `state`/`questions`),
 *      replis (`NON_FALLBACK_STATUSES`, `reason` catégorisé), affinité de cache,
 *      mode rolling, authentification et `keyName`.
 *
 * ── Ce qui N'EST PAS journalisé ────────────────────────────────────────────
 * `state` et `questions` peuvent contenir du TEXTE UTILISATEUR (ticket, e-mail,
 * appel d'outil, image) : ils ne sortent JAMAIS du relais vers le journal, pas
 * plus que les prompts d'un appel chat. Le journal ne reçoit que des
 * métadonnées (service, fournisseur, modèle, statut, motif, durée, tokens).
 */
import { ApiError } from "../utils/api-error.js";
import { relayService, type RelayApi, type RelayInput, type RelayOutput } from "./relay.js";

/** Type d'API de ce module (voir `RelayApi` dans `relay.ts`). */
export const SYSTEM_ONE_API: RelayApi = "systemone";

/** Nombre maximal de questions d'une requête System One (limite cloud documentée). */
export const SYSTEM_ONE_MAX_QUESTIONS = 64;

/** Types de question admis (vocabulaire FERMÉ de la doc). */
export const SYSTEM_ONE_QUESTION_TYPES = ["choice", "noul", "score"] as const;
export type SystemOneQuestionType = (typeof SYSTEM_ONE_QUESTION_TYPES)[number];

/** Description d'une question, telle que le client l'envoie (relayée telle quelle). */
export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  /** `choice` : objet option → description ; `score` : tableau de niveaux ; `noul` : `{true,false}`. */
  criteria?: Record<string, string | null> | string[] | { true?: string; false?: string } | null;
}

/** Corps System One — relayé TEL QUEL (seul `model` est remplacé par le relais). */
export interface SystemOneBody {
  model?: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, SystemOneQuestion>;
  images?: string[];
  keep_alive?: string | number;
}

// ── Réponses (lecture seule côté Switchy : le corps est relayé tel quel) ──

export interface SystemOneChoiceAnswer {
  type?: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface SystemOneNoulAnswer {
  type?: "noul";
  /** Probabilité que la réponse soit VRAIE, de 0 à 1. */
  noul: number;
}

export interface SystemOneScoreAnswer {
  type?: "score";
  /** Moyenne pondérée des niveaux (numérotés depuis 0). */
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type SystemOneAnswer = SystemOneChoiceAnswer | SystemOneNoulAnswer | SystemOneScoreAnswer;

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ── Validation ──

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `state` non vide : chaîne non blanche, ou objet/tableau (sérialisé en JSON par le fournisseur). */
function isNonEmptyState(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  const obj = asRecord(value);
  return obj !== null && Object.keys(obj).length > 0;
}

/**
 * Valide un corps System One. Retourne la liste des erreurs (vide = valide).
 *
 * Seules les règles DOCUMENTÉES sont vérifiées. En particulier le JEU DE
 * CARACTÈRES des noms de questions (spécifique aux modèles cloud) et les bornes
 * d'images ne sont pas imposées localement : un Ollama local accepte davantage,
 * et refuser ici une requête que le fournisseur aurait acceptée serait une
 * trahison du pass-through.
 */
export function validateSystemOneBody(body: unknown): string[] {
  const root = asRecord(body);
  if (!root) return ["body: must be a JSON object { model, state, questions }"];

  const errors: string[] = [];

  if (!("state" in root)) {
    errors.push("state: required — the text (or JSON object/array) to judge");
  } else if (!isNonEmptyState(root.state)) {
    errors.push("state: must be a non-empty string, or a non-empty object/array");
  }

  const questions = asRecord(root.questions);
  if (!questions) {
    errors.push("questions: required — an object of 1 to 64 named questions");
  } else {
    const names = Object.keys(questions);
    if (names.length === 0) errors.push("questions: must contain at least one question");
    if (names.length > SYSTEM_ONE_MAX_QUESTIONS) {
      errors.push(`questions: at most ${SYSTEM_ONE_MAX_QUESTIONS} questions per request (got ${names.length})`);
    }
    for (const name of names) {
      const question = asRecord(questions[name]);
      if (!question) {
        errors.push(`questions.${name}: must be an object { type, instructions, criteria? }`);
        continue;
      }
      const type = question.type;
      if (typeof type !== "string" || !(SYSTEM_ONE_QUESTION_TYPES as readonly string[]).includes(type)) {
        errors.push(`questions.${name}.type: must be one of ${SYSTEM_ONE_QUESTION_TYPES.join(", ")}`);
      }
      const instructions = question.instructions;
      if (typeof instructions !== "string" || instructions.trim() === "") {
        errors.push(`questions.${name}.instructions: required, must be a non-empty string`);
      }
      const criteria = question.criteria;
      if (criteria !== undefined && criteria !== null) {
        if (type === "score") {
          if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
            errors.push(`questions.${name}.criteria: score questions need an array of 2 to 10 level descriptions`);
          }
        } else if (type === "choice" || type === "noul") {
          if (!asRecord(criteria)) {
            errors.push(`questions.${name}.criteria: ${type} questions need a criteria object`);
          } else if (type === "choice" && Object.keys(asRecord(criteria) as object).length < 2) {
            errors.push(`questions.${name}.criteria: choice questions need at least 2 options`);
          }
        }
      }
    }
  }

  if (root.images !== undefined && root.images !== null) {
    if (!Array.isArray(root.images) || root.images.some((image) => typeof image !== "string")) {
      errors.push("images: must be an array of base64-encoded image strings");
    }
  }

  if (root.keep_alive !== undefined && root.keep_alive !== null) {
    const keepAlive = root.keep_alive;
    if (typeof keepAlive !== "string" && typeof keepAlive !== "number") {
      errors.push("keep_alive: must be a duration string (e.g. 5m) or a number of seconds");
    }
  }

  return errors;
}

/**
 * Relaie un corps System One TEL QUEL vers la chaîne du service nommé.
 *
 * Seul `model` est remplacé (par le modèle réel de l'étape) ; la réponse du
 * fournisseur est renvoyée sans transformation. Aucune conversion vers/depuis
 * le format chat.
 *
 * Jette `ApiError` (corps invalide, service inconnu/désactivé), `QueueFullError`
 * / `QueueTimeoutError` (→ 429 côté route) ou `UpstreamFailure` (dernier échec,
 * à relayer tel quel).
 */
export async function relaySystemOne(input: Omit<RelayInput, "api">): Promise<RelayOutput> {
  const errors = validateSystemOneBody(input.body);
  if (errors.length > 0) throw ApiError.validation(errors);
  return relayService({ ...input, api: SYSTEM_ONE_API });
}
