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
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY packs ./packs
COPY validation ./validation
COPY tests ./tests
USER node
EXPOSE 3002
# Liveness only: readiness (/readyz) also checks the database and file storage.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO /dev/null http://127.0.0.1:3002/healthz || exit 1
CMD ["node", "dist/server.js"]
