# CorpVideo — образ приложения (API + воркер) и образ nginx со статикой.
# Сборка: docker compose build   (цели: app, nginx)

# --- 1. Сборка веб-интерфейса ---------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- 2. Зависимости сервера --------------------------------------------------------
FROM node:22-bookworm-slim AS server-deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- 3. Образ приложения ----------------------------------------------------------
FROM node:22-bookworm-slim AS app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini yt-dlp tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=web /build/web/dist ./web/dist
COPY VERSION ./VERSION
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    NGINX_ACCEL=1
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["node", "server/src/index.js"]

# --- 4. Образ nginx со статикой -----------------------------------------------------
FROM nginx:1.27-alpine AS nginx
RUN apk add --no-cache bash
COPY --from=web /build/web/dist /usr/share/corpvideo/web
COPY deploy/nginx/site.conf.template /etc/corpvideo/site.conf.template
COPY deploy/nginx/locations.conf.template /etc/corpvideo/locations.conf.template
COPY deploy/nginx/maps.conf /etc/nginx/conf.d/00-corpvideo-maps.conf
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/nginx-entrypoint.sh /docker-entrypoint.d/99-corpvideo.sh
RUN chmod +x /docker-entrypoint.d/99-corpvideo.sh && mkdir -p /var/www/certbot /etc/corpvideo/ssl
