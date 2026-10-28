# Switchy — contrat d'API

Documente le contrat **réel** du service. Lot 2 : santé, configuration
(fournisseurs, services, réglages, clés). Le contrat de la passerelle
(`/api/*` de relais, streaming, journal) sera spécifié au Lot 3.

## Authentification

Toutes les routes `/api/*` sont protégées par la **clé d'API Switchy**, présentée
en `Authorization: Bearer <clé>` ou `X-API-Key: <clé>`. En cas d'absence ou de
clé invalide :

```json
{ "error": "Invalid or missing API key", "code": "UNAUTHORIZED", "authRequired": true }
```

**Mode amorçage** : tant qu'AUCUNE clé n'existe (ni dans le fichier de clés, ni
via `SWITCHY_API_KEY`), l'API est **ouverte**. C'est ce qui permet de tout
configurer depuis l'interface dès la première ouverture. Dès qu'une clé existe
(fichier ou environnement), l'accès est exigé.

## GET /health

Liveness, aligné sur les autres services de l'écosystème. Public, sans clé.

```json
{ "service": "switchy", "status": "ok", "version": "0.1.0", "providers": 0, "services": 0 }
```

- `service` / `status` / `version` : forme historique, inchangée.
- `providers` / `services` : compteurs du catalogue (Lot 2).

## Fournisseurs — `/api/providers`

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `GET` | `/api/providers` | Liste (clé jamais réaffichée) |
| `POST` | `/api/providers` | Création |
| `PUT` | `/api/providers/:id` | Mise à jour |
| `DELETE` | `/api/providers/:id` | Suppression (refusée `409` si un service l'utilise) |
| `GET` | `/api/providers/:id/models` | Modèles du fournisseur (`?refresh=1` pour forcer) |
| `GET` | `/api/providers/:id/models/:model` | Capacités d'un modèle (contexte, vision, outils, réflexion) |

**Fournisseur** : `id`, `label`, `type` (`openai-compatible` \| `ollama-native` \|
`anthropic` \| `google`), `baseUrl` (URL `/v1`), `nativeUrl?` (URL native, ex.
Ollama `/api/tags`), `systemOneUrl?` (URL **complète** de l'endpoint System One ;
absente = dérivée de `baseUrl` : `…/v1` → `…/v1/systemone`),
**`maxConcurrency?`** (appels simultanés du **compte** ;
absent = défaut global `SWITCHY_CONCURRENCY`, min 1 — `0` refusé),
`apiKey` (**secret**), `enabled`.

Les deux routes `/models` interrogent le fournisseur avec **sa clé** (OpenAI-
compatible `GET {baseUrl}/models` ; Ollama natif `GET {nativeUrl}/api/tags` et
`POST {nativeUrl}/api/show`), avec cache court ; fournisseur injoignable → `502`,
clé refusée → `502` `PROVIDER_AUTH_ERROR`.

⚠️ **La clé d'API d'un fournisseur n'est JAMAIS renvoyée en clair** : la vue
publique la remplace par `{ "configured": bool, "preview": "••••" }`.

Sémantique du champ `apiKey` :
- **absent ou chaîne vide** → inchangé ;
- `null` → efface la clé (sentinelle explicite) ;
- chaîne non vide → remplace la clé.

## Services — `/api/services`

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `GET` | `/api/services` | Liste des services nommés |
| `POST` | `/api/services` | Création |
| `PUT` | `/api/services/:name` | Mise à jour |
| `DELETE` | `/api/services/:name` | Suppression |

**Service** : `name`, `description`, `principal` `{providerId, model, reasoning, enabled}`,
`fallbacks[]` (mêmes champs, ordonnés), `contextWindow`, `maxOutputTokens`,
`vision`, **`prioritaire`** (booléen : ses appels passent avant les autres quand
une place se libère chez le fournisseur), **`rolling`** (ne pas patienter : une
étape pleine est sautée) et `enabled`.

**`enabled` d'une ÉTAPE** (principal comme repli) : défaut `true`, booléen
**strict** (`"false"` → `400`). Une étape à `false` est **conservée** (position,
libellé `principal`/`repli n`, réglages) mais **sautée** à l'exécution, avec le
motif de journal `step_disabled` — distinct de `saturated` (charge) et des
erreurs fournisseur. Le `enabled` du SERVICE reste **maître** : service éteint =
rien n'est appelé. Le principal peut être éteint sans casser le service (la
chaîne démarre sur le premier repli actif) ; **toutes** les étapes éteintes →
`503` `NO_ENABLED_STEP`, sans aucun appel fournisseur.

> Migration douce : un ancien `catalog.json` contenant `reservations` reste
> lisible — le champ est **ignoré**, `prioritaire` vaut `false` par défaut ; une
> étape **sans** `enabled` vaut `true` (activée).

**Validation** (réponses `400` `VALIDATION_ERROR` avec `errors[]`) : nom unique
(`409` `CONFLICT` si dupliqué), `providerId` existant, bornes numériques
(`contextWindow` ∈ [1, 100 000 000], `maxOutputTokens` ∈ [1, 10 000 000],
`maxConcurrency` ∈ [1, 1000], ≤ 16 replis).

## Réglages — `/api/settings`

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `GET` | `/api/settings` | Réglages groupés (valeur effective OU secret masqué) |
| `POST` | `/api/settings` | Écrit `$SWITCHY_DATA_DIR/config.json` |

Modèle de résolution : **`env ?? fichier ?? défaut`**. Chaque réglage porte sa
`source` (`env` \| `file` \| `default`), `editable` (faux si verrouillé par
l'env), `restartRequired`. Un réglage de type `secret` n'est JAMAIS réaffiché :
`{ configured, preview: "••••" }`.

Corps de `POST` : `{ "settings": { "SWITCHY_CONCURRENCY": "5", "SWITCHY_API_KEY": null } }`
(champ vide = inchangé, `null` = efface). Réglage verrouillé par l'env → `409`
`LOCKED_BY_ENV` ; valeur invalide → `400` `VALIDATION_ERROR`.

## Clés — `/api/keys`

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `GET` | `/api/keys` | Liste (aperçu masqué ; jamais le secret ni le hash) |
| `POST` | `/api/keys` | Création ; renvoie le **secret une seule fois** |
| `DELETE` | `/api/keys/:id` | Révocation |

Les clés sont hachées (**scrypt**, sel par clé) dans
`$SWITCHY_DATA_DIR/switchy-keys.json` (0600).

## Journal d'appels — `/api/calls`

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `GET` | `/api/calls` | Tentatives journalisées (plus récent d'abord) + bilan des replis |

Pagination `limit` (défaut 50, max 500) / `offset` (défaut 0) ; filtres
`service` et `result` (`ok` \| `error` \| `aborted` \| `skipped`).

Chaque **tentative** est une entrée JSONL (`$SWITCHY_DATA_DIR/calls.jsonl`) :

| Champ | Sens |
| --- | --- |
| `ts` | horodatage ISO de fin de tentative |
| `callId` | identifiant de l'**appel logique**, commun à toutes ses tentatives |
| `service` | service nommé appelé |
| `attempt` | rang : `0` = principal, `1..` = repli n° |
| `isFallback` | `true` ⇔ cette tentative EST un repli (= `attempt > 0`) |
| `provider` / `model` | fournisseur et modèle visés |
| `result` | `ok` \| `error` \| `aborted` \| `skipped` |
| `status` | code HTTP amont (absent si échec réseau) |
| `reason` | motif **catégorisé** (voir ci-dessous) |
| `durationMs`, `tokens?`, `stream?` | durée, consommation, streaming |

`reason` appartient à une **liste blanche fermée** : `quota` (quota/limite
d'usage épuisé), `rate_limit` (429 de débit), `overloaded` (503), `auth_error`
(401/403), `network_error`, `upstream_error`. **Jamais** de clé, de prompt ni de
corps fournisseur dans le journal.

La réponse porte aussi `summary` (bilan des replis, **non filtré**) :
`windowHours`, `total`, `last24h`, `byService`, `byFallbackProvider`, `reasons`.
Les entrées antérieures à ce lot (sans `callId`/`reason`/`isFallback`) restent
lisibles et comptées (`attempt > 0` ⇒ repli).

### Politique de repli

Le relais bascule du principal vers les replis sur `404`, `408`, `409`, `429`,
les `5xx` et les échecs réseau. Il **ne bascule pas** sur une erreur manifeste de
la requête (`400`, `405`, `406`, `413`, `415`, `422`) **ni sur un échec
d'authentification** (`401`, `403`) : une clé invalide/expirée ne sera pas valide
chez le fournisseur suivant, et basculer vers un repli payant masquerait un
simple problème de configuration. L'échec est alors relayé tel quel et
journalisé avec `reason: "auth_error"`.

## API « System One » — `/api/system/:service` et `/v1/systemone`

Second **type d'API**, géré **nativement** : ce n'est pas du chat. Le client
envoie un `state` (texte ou JSON) et un **schéma de questions typées** ; le
modèle de décision (ex. `clef`, Ollama Cloud) rend une décision par question en
une passe, sans générer de texte.

| Méthode | Chemin | Effet |
| --- | --- | --- |
| `POST` | `/api/system/:service` | Relais pour le service nommé (canonique) |
| `POST` | `/v1/systemone` | Même chemin que le fournisseur, `model` = nom du service |

**Corps relayé TEL QUEL** (contrat Ollama `POST /v1/systemone`) :

```json
{
  "model": "triage",
  "state": { "ticket": "…" },
  "questions": {
    "team":    { "type": "choice", "instructions": "…", "criteria": { "billing": "…", "technical": "…" } },
    "refund":  { "type": "noul", "instructions": "…" },
    "urgency": { "type": "score", "instructions": "…", "criteria": ["Routine", "Soon", "Urgent"] }
  }
}
```

- **seul `model` est remplacé** (par le modèle réel de l'étape du service) ;
- `state`, `questions`, `images?`, `keep_alive?` passent inchangés ; aucune
  conversion vers/du format chat ;
- **aucun contrôle de génération** n'est ajouté (`reasoning_effort` compris) :
  le fournisseur les refuse (`400`) ;
- **pas de streaming** (la doc Ollama ne le prévoit pas) : la réponse est un
  unique corps JSON `{ model, answers, usage }`, relayé sans transformation ;
- l'auth, les clés (jamais celle du client), la concurrence par fournisseur, les
  replis, l'affinité, le mode rolling, `keyName`, le journal et le tableau de
  bord sont **ceux du relais chat** ;
- le **journal ne contient ni `state` ni `questions`** (contenu utilisateur),
  seulement les métadonnées habituelles.

Validation locale (`400 VALIDATION_ERROR`) : `state` non vide, `questions`
(1 à 64) avec `type` ∈ `choice`/`noul`/`score` et `instructions` non vides,
`score` à 2–10 niveaux, `choice` à au moins 2 options.

## Interface web

Servie depuis `public/` (vanilla, sans build), montée **après** `/health` et
`/api/*`. Aucun **fallback SPA** : une route inconnue répond 404 (l'index n'est
jamais servi pour une URL arbitraire). Trois onglets : **Services**,
**Fournisseurs**, **Réglages** — CRUD complet, sans jamais éditer un fichier.

## À venir (Lot 4)

- Relais transparent vers les fournisseurs (streaming SSE, tool-calling) et
  relais de l'API native Ollama (`/api/tags`, capacités) : **en place**.
- Comptage des appels en vol **par fournisseur** : **en place**.
- Replis, journal d'appels et compteur de replis : **en place** (voir
  « Journal d'appels »). Reste : le tableau de bord dédié.
