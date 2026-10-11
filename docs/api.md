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

**Fournisseur** : `id`, `label`, `type` (`openai-compatible` \| `ollama-native` \|
`anthropic` \| `google`), `baseUrl` (URL `/v1`), `nativeUrl?` (URL native, ex.
Ollama `/api/tags`), `apiKey` (**secret**), `enabled`.

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

**Service** : `name`, `description`, `principal` `{providerId, model, reasoning}`,
`fallbacks[]` (mêmes champs, ordonnés), `contextWindow`, `maxOutputTokens`,
`vision`, `reservations?` `{light?, heavy?}`, `enabled`.

**Validation** (réponses `400` `VALIDATION_ERROR` avec `errors[]`) : nom unique
(`409` `CONFLICT` si dupliqué), `providerId` existant, bornes numériques
(`contextWindow` ∈ [1, 100 000 000], `maxOutputTokens` ∈ [1, 10 000 000],
réservations ∈ [0, 1000], ≤ 16 replis).

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

## Interface web

Servie depuis `public/` (vanilla, sans build), montée **après** `/health` et
`/api/*`. Aucun **fallback SPA** : une route inconnue répond 404 (l'index n'est
jamais servi pour une URL arbitraire). Trois onglets : **Services**,
**Fournisseurs**, **Réglages** — CRUD complet, sans jamais éditer un fichier.

## À venir (Lot 3+)

- Relais transparent vers les fournisseurs (streaming SSE, tool-calling) et
  relais de l'API native Ollama (`/api/tags`, capacités).
- Comptage global des appels en vol (limite de compte, ex. Ollama Pro : 3).
- Exécution des replis et journal d'appels ; tableau de bord (Lot 4).
