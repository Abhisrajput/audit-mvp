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
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
