FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# The runtime runs only `node dist/...`; drop npm, npx and corepack (and their bundled dependencies) from the image.
RUN npm ci --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY packs ./packs
COPY validation ./validation
COPY tests ./tests
USER node
EXPOSE 3002 3003
# Liveness only: readiness (/readyz) also checks the database and file storage. The agent worker
# (node dist/agents/worker-cli.js) answers on WORKER_PORT (3003) instead; Compose and Container Apps set its probes.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO /dev/null http://127.0.0.1:3002/healthz || exit 1
CMD ["node", "dist/server.js"]
