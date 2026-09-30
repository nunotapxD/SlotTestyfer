# syntax=docker/dockerfile:1
#
# Multi-stage build:
#   deps     all dependencies (for building and testing)
#   build    compiled TypeScript
#   test     runs lint, build and tests: docker build --target test
#   web      the browser interface, served by nginx without root: docker build --target web
#   runtime  the API: production dependencies and compiled output only (the default target)

FROM node:22-alpine AS base
WORKDIR /app
RUN chown node:node /app
# Everything below runs without root, and the files belong to the node user.
USER node

FROM base AS deps
RUN mkdir -p packages/engine packages/simulator packages/api packages/web
# Only the manifests first, so the npm ci layer is cached until dependencies change.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/engine/package.json packages/engine/
COPY --chown=node:node packages/simulator/package.json packages/simulator/
COPY --chown=node:node packages/api/package.json packages/api/
COPY --chown=node:node packages/web/package.json packages/web/
RUN npm ci

FROM deps AS build
COPY --chown=node:node . .
RUN npm run build

FROM build AS test
CMD ["npm", "run", "check"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

FROM base AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/slottestyfer.db \
    GAMES_DIR=/app/games

RUN mkdir -p packages/engine packages/simulator packages/api packages/web
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/engine/package.json packages/engine/
COPY --chown=node:node packages/simulator/package.json packages/simulator/
COPY --chown=node:node packages/api/package.json packages/api/
COPY --chown=node:node packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/packages/engine/dist packages/engine/dist
COPY --from=build --chown=node:node /app/packages/simulator/dist packages/simulator/dist
COPY --from=build --chown=node:node /app/packages/api/dist packages/api/dist
COPY --chown=node:node games games

# The SQLite database lives in a volume so it survives new containers.
USER root
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/api/dist/server.js"]
