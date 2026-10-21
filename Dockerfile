# ─── Switchy — image de service ───
#
# Image de base tirée du MIROIR PUBLIC GOOGLE (mirror.gcr.io) : contenu
# identique à docker.io/library/node:22-slim, seule la provenance change — et
# ce miroir n'applique pas de quota de pulls anonymes.
#
# Pourquoi PAS public.ecr.aws (utilisé avant) : ECR Public limite les pulls
# ANONYMES par adresse IP ; les runners GitHub partagent leurs IP, d'où l'échec
# « 429 Too Many Requests · toomanyrequests: Data limit exceeded » observé en CI.
# Pourquoi PAS docker.io en direct : Docker Hub rate-limite aussi les anonymes.
#
# Empreintes MESURÉES le 2026-10-21 sur mirror.gcr.io (figées ici en
# commentaire, le tag reste utilisé : un digest épinglé casse le build si le
# miroir resynchronise le tag) :
#   index multi-arch  : sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
#   linux/amd64       : sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09
#
# Build en DEUX étapes : la compilation TypeScript a besoin des devDependencies
# (typescript, @types/*), l'exécution NON.

# ─── Étape 1 : compilation TypeScript ───
FROM mirror.gcr.io/library/node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Étape 2 : exécution ───
FROM mirror.gcr.io/library/node:22-slim
ENV NODE_ENV=production
ENV SWITCHY_DATA_DIR=/app/data
ENV SWITCHY_HOST=0.0.0.0
ENV SWITCHY_PORT=3008

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Interface web statique (HTML/CSS/JS, sans étape de build) : copiée AVANT le
# chown pour que l'utilisateur non-root puisse la lire.
COPY public ./public
# Outil de SECOURS de réinitialisation du mot de passe admin (accès machine
# requis ; aucune route HTTP — voir README « Mot de passe administrateur »).
COPY scripts/reset-admin-password.mjs ./scripts/reset-admin-password.mjs

# Utilisateur NON-ROOT (uid fixe). Le répertoire de données lui appartient :
# Switchy n'écrit que dans SON volume, jamais dans celui d'un autre service.
RUN useradd -u 10001 -m -s /usr/sbin/nologin switchy \
 && mkdir -p /app/data \
 && chown -R switchy:switchy /app
USER switchy

EXPOSE 3008

# Liveness aligné sur le contrat GET /health = {"service":"switchy","status":"ok"}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SWITCHY_PORT||3008)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
