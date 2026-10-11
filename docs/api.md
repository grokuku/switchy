# Switchy — contrat d'API

Documente le contrat **réel** du service. À ce stade (Lot 1), l'API se limite à
la route de santé ; le contrat de la passerelle (`/api/*`) sera spécifié avec
le cœur du service, puis complété ici.

## GET /health

Liveness, aligné sur les autres services de l'écosystème. Public, sans clé.

```json
{ "service": "switchy", "status": "ok", "version": "0.1.0" }
```

- `service` : toujours `switchy`.
- `status` : `ok` tant que le processus répond.
- `version` : version de `package.json` de l'image en cours d'exécution.

## Interface web

Servie depuis `public/`, montée **après** `/health` et `/api/*`. Aucun
**fallback SPA** : une route inconnue répond 404 (l'index n'est jamais servi
pour une URL arbitraire).

## À venir (Lot 2+)

- Services LLM nommés : principal + replis ordonnés, réflexion, contexte,
  tokens de sortie, vision, réservations de slots.
- Relais transparent vers les fournisseurs (streaming SSE, tool-calling) et
  relais de l'API native Ollama (`/api/tags`, capacités).
- Comptage global des appels en vol (limite de compte, ex. Ollama Pro : 3).
- Journal d'appels.
- Réglages : `env ?? fichier ?? défaut`, secrets jamais réaffichés.
