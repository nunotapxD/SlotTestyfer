# Imagem que corre lint, build e testes num ambiente igual em qualquer máquina.
# Na Fase 3 este ficheiro passa a multi-stage (build + runtime) para a API.
FROM node:22-alpine

WORKDIR /app
RUN chown node:node /app

# Tudo a partir daqui corre sem privilégios de root e os ficheiros pertencem ao utilizador node.
USER node
RUN mkdir -p packages/engine packages/simulator

# Copiar só os manifestos primeiro para aproveitar a cache de camadas do Docker.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/engine/package.json packages/engine/
COPY --chown=node:node packages/simulator/package.json packages/simulator/
RUN npm ci

COPY --chown=node:node . .

CMD ["npm", "run", "check"]
