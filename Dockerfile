# Fase 0: imagem que corre lint, typecheck e testes num ambiente igual em qualquer máquina.
# Na Fase 3 este ficheiro passa a multi-stage (build + runtime) para a API.
FROM node:22-alpine

WORKDIR /app

# Copiar só os manifestos primeiro para aproveitar a cache de camadas do Docker.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
RUN npm ci

# Correr como utilizador sem privilégios.
COPY --chown=node:node . .
USER node

CMD ["npm", "run", "check"]
