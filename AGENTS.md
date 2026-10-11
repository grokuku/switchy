# AGENTS.md — Switchy

Switchy est un **service** de l'écosystème holaf, pas une brique holaf : il
n'est pas destiné à être copié dans `vendor/holaf` d'un projet.

Les conventions communes de l'écosystème (SDK Pi, façades, événements, erreurs
d'intégration, règles communes) sont la **source unique de vérité** et vivent
dans `holaf-lib`. **Ne jamais les recopier ici** : pointer vers le dossier.

- Index des conventions : `/projects/holaf-lib/docs/conventions/README.md`
- SDK Pi (notamment §6–§8, gateway LLM / façade / événements / erreurs) :
  `/projects/holaf-lib/docs/conventions/pi-sdk.md`

Avant d'introduire ou de modifier un composant, une intégration ou un outil,
consulter d'abord ces documents. Toute règle commune nouvelle se discute dans
`holaf-lib`, jamais dans Switchy.

## Spécificités de Switchy

- `name`: `switchy`, version `0.1.0`, `private: true`, ESM, Node ≥ 22.
- Dépendances runtime volontairement minimales (`express`, `express-rate-limit`).
- Port **3008** (Pi-Web 3000/3005, WebClaw 3006, Libry 3007). Écrit dans **son**
  répertoire de données (`SWITCHY_DATA_DIR`). Ne touche jamais au volume d'un
  autre service.
- **Rien n'est obligatoire** : aucun projet n'est forcé de passer par Switchy.
- Le relais doit rester **transparent** (streaming SSE, tool-calling, API
  native Ollama) et **un repli ne doit jamais être silencieux** (journal).
- L'interface de configuration fait partie de la **v1** : l'utilisateur refuse
  d'éditer des fichiers à la main.
- Les briques de `public/vendor/holaf/` sont copiées **verbatim** par le CLI
  `holaf` de `holaf-lib` — ne jamais les éditer à la main (voir README,
  « Procédure d'upgrade »).
