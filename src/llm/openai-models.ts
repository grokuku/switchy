/**
 * Vue « OpenAI » des services Switchy — alimente `GET /v1/models`.
 *
 * Un SERVICE du catalogue est ce qu'un client OpenAI appelle un « modèle » :
 * c'est exactement la valeur qu'il place dans `body.model` de
 * `POST /v1/chat/completions`. Cette vue est donc la SEULE source de la
 * correspondance service → modèle OpenAI (aucune duplication ailleurs).
 *
 * ⚠️ SÉCURITÉ : la réponse ne contient JAMAIS la clé d'un fournisseur, son
 * `baseUrl`, son `nativeUrl` ni son identifiant interne. `owned_by` reste
 * générique (`switchy`) : le client n'a pas à savoir qui sert le service, et
 * l'étape de repli peut changer d'un appel à l'autre.
 *
 * ⚠️ Seuls les services `enabled` sont exposés : un service désactivé n'existe
 * pas du point de vue d'un client (il est 404 en détail, absent en liste).
 */
import { listServices, getService, type ServiceRecord } from "../catalog-store.js";

/** Propriétaire générique annoncé au client (jamais un identifiant interne). */
const OWNER = "switchy";

/**
 * Métadonnées propres à Switchy, ajoutées EN PLUS des champs standard
 * d'OpenAI (jamais à leur place : un client strict les ignore sans casser).
 */
export interface OpenAiModelCapabilities {
  /** Le service accepte-t-il des images en entrée ? */
  vision: boolean;
}

export interface OpenAiModel {
  /** Nom du service — la valeur à mettre dans `body.model`. */
  id: string;
  object: "model";
  /** Epoch (secondes) de création du service ; 0 si la date est illisible. */
  created: number;
  owned_by: string;
  /** Description libre saisie par l'humain (utile à un sélecteur de modèle). */
  description: string;
  /** Taille de contexte déclarée (depuis `contextWindow`). */
  context_length: number;
  /** Plafond de sortie déclaré (depuis `maxOutputTokens`). */
  max_output_tokens: number;
  capabilities: OpenAiModelCapabilities;
}

/** `createdAt` ISO → epoch secondes (0 si la valeur est absente ou invalide). */
function epochSeconds(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Vue publique d'un service au format « modèle » OpenAI. */
export function toOpenAiModel(service: ServiceRecord): OpenAiModel {
  return {
    id: service.name,
    object: "model",
    created: epochSeconds(service.createdAt),
    owned_by: OWNER,
    description: service.description,
    context_length: service.contextWindow,
    max_output_tokens: service.maxOutputTokens,
    capabilities: { vision: service.vision },
  };
}

/** Liste des services ACTIVÉS, au format `{ object: "list", data: [...] }`. */
export function listOpenAiModels(): { object: "list"; data: OpenAiModel[] } {
  return {
    object: "list",
    data: listServices()
      .filter((service) => service.enabled)
      .map(toOpenAiModel),
  };
}

/** Un service ACTIVÉ par son nom ; `null` s'il est inconnu OU désactivé. */
export function getOpenAiModel(name: string): OpenAiModel | null {
  const service = getService(name);
  if (!service || !service.enabled) return null;
  return toOpenAiModel(service);
}
