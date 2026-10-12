FROM node:22-alpine AS build
WORKDIR /repo
COPY backend/package*.json ./backend/
RUN cd backend && npm ci
COPY backend/src ./backend/src
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

FROM nginx:1.30.5-alpine
# Pick up fixed Alpine packages between nginx releases.
RUN apk upgrade --no-cache
# Rendered by the image's entrypoint into /etc/nginx/conf.d/default.conf (envsubst; only defined variables).
# API_UPSTREAM is the API's host:port as nginx reaches it: the Compose service by default, the api app's internal FQDN on Azure.
ENV API_UPSTREAM=backend:3002
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
