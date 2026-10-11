# Switchy

**Passerelle LLM centralisée** de l'écosystème **holaf** : elle expose des
**services LLM nommés** (ex. `Deepseek-Fast`) — principal + replis ordonnés,
niveau de réflexion, taille de contexte, tokens de sortie max, vision,
réservations de slots — que les autres projets (Pi-Web, Yuki, Kinoscribe,
Docky, protocore…) appellent **par nom de service**, jamais par modèle de
fournisseur.

Objectifs du service :

- **Relayer** les appels vers les fournisseurs (transparent : streaming SSE,
  tool-calling) et **relayer aussi l'API native Ollama** (`/api/tags`,
  capacités) — sans quoi la découverte des modèles côté Pi-Web serait cassée.
- **Compter les appels en vol globalement** : l'abonnement Ollama Pro autorise
  3 requêtes simultanées **par compte**, toutes clés confondues. Switchy est le
  point unique qui sait ce que font tous les outils à la fois.
- Tenir un **journal d'appels** (un repli silencieux est un changement de
  qualité invisible).

> **Rien n'est obligatoire** : chaque projet peut rester en direct. Ce n'est
> **pas** une brique holaf — les conventions communes vivent dans `holaf-lib`
> (voir [`AGENTS.md`](./AGENTS.md)).

## État actuel — Lot 1 (fondations) + Lot 2 (modèle de données & configuration)

- Socle serveur Express, limitation de débit, `GET /health`, port **3008**.
- **Modèle de données** (Lot 2) : fournisseurs et services nommés vivent dans
  `$SWITCHY_DATA_DIR/catalog.json` (source de vérité versionnable, écriture
  atomique, permissions `0600`). Réglages scalaires dans `config.json`
  (`env ?? fichier ?? défaut`). Clés d'API hachées (scrypt) dans
  `switchy-keys.json`.
- **API de configuration** (Lot 2) : `GET/POST/PUT/DELETE /api/providers`,
  `GET/POST/PUT/DELETE /api/services`, `GET/POST /api/settings`,
  `GET/POST/DELETE /api/keys` — protégées par la clé d'API Switchy (mode
  amorçage tant qu'aucune clé n'existe). Les secrets ne sont jamais réaffichés.
- Interface web **pleine largeur** servie sans build : onglets **Services**
  (CRUD, principal + replis ordonnés, capacités), **Fournisseurs** (CRUD, clé
  jamais réaffichée) et **Réglages** (badges source, « redémarrage requis »,
  secrets masqués) — **toute la configuration se fait depuis l'interface**.
- Cinq briques holaf-lib **vendorisées** (`public/vendor/holaf/`), avec
  empreintes pinnées et garde-fou CI hors réseau.
- Image Docker **non-root**, `HEALTHCHECK` sur `/health`, publiée par GitHub
  Actions sur GHCR ; le `docker-compose.yml` **tire** l'image, il ne la
  reconstruit pas en production.
- Tests vitest + supertest, **aucun accès réseau**.

À venir : **cœur du gateway** (relais transparent + comptage global, journal,
replis), **tableau de bord**, **pilote Yuki**.

## Démarrage

```bash
npm install
cp .env.example .env      # adapter si besoin
npm run dev               # tsx watch (défaut : 0.0.0.0:3008)
```

## Scripts

| Script | Rôle |
| --- | --- |
| `npm run dev` | Serveur en développement (`tsx watch`). |
| `npm run build` | Compilation TypeScript vers `dist/`. |
| `npm start` | Démarre le serveur compilé (`node dist/index.js`). |
| `npm test` | Tests (vitest). |
| `npm run typecheck` | Vérification de types sans émission. |
| `npm run check:vendor` | Empreintes des briques holaf vendorisées (CI, hors réseau). |

## Interface web & briques holaf-lib

`public/` — l'interface (vanilla, servie sans build) — consomme cinq briques de
holaf-lib, copiées **verbatim** par le CLI de la librairie dans
`public/vendor/holaf/` :

| Brique | Rôle côté Switchy | Version pinnée |
| --- | --- | --- |
| `tokens` | SEULE à poser les variables `--holaf-*` ; `styles.css` les aliase avec repli hex | 0.6.0 |
| `icons` | icônes SVG (bascule clair/sombre) | 0.1.6 |
| `modal` | modale autonome (CSS extrait en fichier) | 0.7.0 |
| `toast` | notifications (CSS extrait en fichier) | 0.8.0 |
| `fetch` | client HTTP | 0.2.0 |

Source de vérité : `/projects/holaf-lib` — ne JAMAIS éditer
`public/vendor/holaf/*.js` à la main.

### Procédure d'upgrade d'une brique

1. `printf 'y\n' | /projects/holaf-lib/scripts/holaf upgrade <brique> /projects/Switchy/public`
   (le CLI cible toujours `<DEST>/vendor/holaf`).
2. `node scripts/extract-holaf-css.mjs` — ré-extraie `holaf-modal.css` /
   `holaf-toast.css` via `getCss()` (le CLI ne copie jamais les CSS).
3. `node scripts/generate-holaf-checksums.mjs` — refige les empreintes SHA-256.
4. `npm run check:vendor` puis `npm test`. La CI exécute `check:vendor` : le
   CLI holaf n'existe pas sur GitHub, ces empreintes sont l'invariant.

## Déploiement (serveur)

En production, Switchy **ne se reconstruit pas sur le serveur** : il **tire**
l'image que GitHub Actions a construite, testée et publiée sur GHCR
(`ghcr.io/grokuku/switchy`). L'**ordre** des étapes est important :

1. **Pousser le code sur GitHub** (`main`). Le workflow `ci.yml` construit et
   publie une image de test (`:test`, `:sha-<court>`).
2. **Lancer la release** : onglet *Actions* → *Release image* → *Run workflow*.
   `release.yml` publie `ghcr.io/grokuku/switchy:0.1.0` (version lue dans
   `package.json`) + `:latest`. ⚠️ **Tant que cette étape n'a pas été faite, le
   tag `0.1.0` n'existe pas sur GHCR.** Pour démarrer avant la première
   release, utiliser `:test` (publié par la CI à chaque push sur `main`) dans
   `docker-compose.yml`.
3. **Sur le serveur**, tirer l'image publiée puis relancer le service :

   ```bash
   docker compose pull   # télécharge l'image de GHCR — ne compile rien
   docker compose up -d
   ```

Avant le premier démarrage, créer le dossier de données et le donner à
l'utilisateur du conteneur (uid 10001) :

```bash
mkdir -p /mnt/user/appdata-ssd/Switchy/data
chown -R 10001:10001 /mnt/user/appdata-ssd/Switchy/data
```

Tags disponibles (une seule ligne à changer dans `docker-compose.yml`) :

| Tag | Ce qu'il suit | Quand l'utiliser |
| --- | --- | --- |
| `:0.1.0` (épinglé, utilisé) | La version `0.1.0`, figée. | Déploiement stable ; aucune mise à jour surprise. |
| `:latest` | La dernière release. | Suivre les releases sans changer le compose. |
| `:test` | La dernière CI de `main`. | Tester un correctif fraîchement poussé. |
| `:sha-<court>` | Un commit précis. | Traçabilité / retour en arrière. |

### Développement local : reconstruire l'image

`docker compose build` est réservé au **développement** : dans
`docker-compose.yml`, commenter la ligne `image:` et décommenter `build:`.

## Configuration

Toutes les variables propres à Switchy sont préfixées `SWITCHY_*` (voir
`.env.example`). Aucune n'est obligatoire : le service démarre avec ses
défauts. La configuration des services LLM et de leurs clés se fera depuis
l'**interface** (v1) — jamais par édition de fichier à la main.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SWITCHY_HOST` | `0.0.0.0` | Interface d'écoute (redémarrage requis). |
| `SWITCHY_PORT` | `3008` | Port (Pi-Web 3000/3005, WebClaw 3006, Libry 3007). |
| `SWITCHY_DATA_DIR` | `/app/data` | Répertoire de données persistant (volume). |
| `SWITCHY_RATE_LIMIT_PER_MIN` | `600` | Requêtes/minute/IP. |
| `SWITCHY_API_KEY` | — | Clé d'API d'amorçage (secret ; sinon l'API est ouverte au 1er démarrage). |
| `SWITCHY_CONCURRENCY` | `3` | Limite globale de concurrence (à chaud). |
| `SWITCHY_LOG_LEVEL` | `info` | Niveau de log (à chaud). |
| `SWITCHY_CALLS_LOG_MODE` | `summary` | Journal d'appels : `off` \| `summary` \| `full`. |
| `SWITCHY_CALLS_LOG_RETENTION_DAYS` | `7` | Rétention du journal (jours). |
| `SWITCHY_CATALOG_FILE` | `$DATA_DIR/catalog.json` | Fournisseurs + services. |
| `SWITCHY_KEYS_FILE` | `$DATA_DIR/switchy-keys.json` | Clés d'API Switchy. |

Les réglages listés ci-dessus (sauf ceux marqués « redémarrage requis ») sont
**modifiables depuis l'onglet Réglages** (résolution `env ?? fichier ?? défaut`).

## Structure

```
src/
  index.ts          # serveur Express + /health (+ compteurs) + montage /api/* + statique
  config.ts         # getters de configuration (env ?? fichier ?? défaut)
  settings-store.ts # réglages scalaires ($DATA_DIR/config.json, catalogue déclaratif)
  catalog-store.ts  # fournisseurs + services ($DATA_DIR/catalog.json) + validation
  switchy-auth.ts   # clés d'API nommées/hachées/révocables (mode amorçage)
  middleware/       # garde d'authentification des routes /api
  routes/           # providers, services, settings, keys
  utils/            # hachage scrypt, erreurs HTTP typées
public/
  index.html      # onglets Services / Fournisseurs / Réglages
  styles.css      # plein largeur, alias des jetons --holaf-*
  app.js          # onglets, thème, configuration (CRUD via /api/*)
  vendor/holaf/   # briques holaf-lib copiées verbatim (pinnées)
scripts/          # toolchain vendor holaf (extraction CSS, empreintes, garde-fou)
tests/            # santé, catalogue, réglages, auth, statique, mise en page, vendor
            #   (hors réseau)
docs/api.md       # contrat d'API (santé + configuration)
```
