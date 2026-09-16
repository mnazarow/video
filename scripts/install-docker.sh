#!/usr/bin/env bash
# CorpVideo — установка в Docker Compose (подключается из install.sh; переменные CV_* уже заданы).

ensure_docker() {
  step "Docker"
  if docker compose version >/dev/null 2>&1; then ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), Compose $(docker compose version --short 2>/dev/null)"; return; fi
  if ! has_cmd docker; then
    info "Устанавливаем Docker Engine (get.docker.com)…"
    pkg_update; pkg_install curl ca-certificates
    if curl -fsSL https://get.docker.com -o /tmp/get-docker.sh 2>>"$CV_LOG"; then
      sh /tmp/get-docker.sh >>"$CV_LOG" 2>&1 || warn "Скрипт get.docker.com завершился с ошибкой, пробуем пакеты дистрибутива"
    fi
  fi
  if ! has_cmd docker; then
    case "$OS_FAMILY" in
      debian) pkg_install docker.io docker-compose-v2 2>/dev/null || pkg_install docker.io docker-compose-plugin ;;
      rhel) pkg_install docker docker-compose-plugin 2>/dev/null || pkg_install moby-engine docker-compose ;;
    esac
  fi
  if ! docker compose version >/dev/null 2>&1; then
    case "$OS_FAMILY" in debian) pkg_install docker-compose-v2 2>/dev/null || pkg_install docker-compose-plugin ;; rhel) pkg_install docker-compose-plugin ;; esac
  fi
  systemctl enable --now docker >>"$CV_LOG" 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 недоступен. Установите Docker вручную: https://docs.docker.com/engine/install/"
  ok "Docker готов"
}

cv_rollback() {
  if [ -f "$CV_APP_DIR/docker-compose.yml" ]; then (cd "$CV_APP_DIR" && docker compose ps -q 2>/dev/null | grep -q . && docker compose logs --tail=40 api nginx 2>/dev/null | tail -60) || true; fi
  warn "Установка не завершена. Данные в $CV_DATA_DIR сохранены; повторный запуск install.sh продолжит установку."
}

install_docker() {
  ensure_docker
  pkg_install curl openssl rsync >/dev/null 2>&1 || true

  step "Копирование приложения в $CV_APP_DIR"
  mkdir -p "$CV_APP_DIR"
  if [ "$(cd "$SOURCE_DIR" && pwd)" != "$(cd "$CV_APP_DIR" && pwd)" ]; then
    rsync -a --delete --exclude '.env' --exclude 'node_modules' --exclude 'web/dist' --exclude 'server/data' --exclude '.git' --exclude 'deploy/mediamtx/mediamtx.yml' "$SOURCE_DIR/" "$CV_APP_DIR/"
  fi
  ok "Исходники на месте"

  step "Конфигурация"
  local envf="$CV_APP_DIR/.env"
  mkdir -p "$CV_DATA_DIR"/{media,uploads,live/recordings,postgres,ssl,certbot,letsencrypt,backups}
  chown -R 1000:1000 "$CV_DATA_DIR/media" "$CV_DATA_DIR/uploads" "$CV_DATA_DIR/live"
  chmod 755 "$CV_DATA_DIR"   # контейнеры (node uid 1000, nginx) должны проходить в каталог
  if [ ! -f "$envf" ]; then
    cat > "$envf" <<EOF
# CorpVideo — конфигурация (создано install.sh $(date -Is))
NODE_ENV=production
BASE_URL=$CV_BASE_URL
DOMAIN=$CV_DOMAIN
SECRET_KEY=$(random_secret 64)
DB_PASSWORD=$(random_secret 32)
DATA_DIR=$CV_DATA_DIR
LOG_LEVEL=info
WORKER_CONCURRENCY=$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))
MEDIAMTX_VERSION=$CV_MEDIAMTX_VERSION
MEDIAMTX_HOOK_SECRET=$(random_secret 32)
LIVE_RTMP_URL=rtmp://$CV_DOMAIN:1935
LIVE_SRT_URL=srt://$CV_DOMAIN:8890
LIVE_WHIP_URL=$CV_BASE_URL/whip
SSL_MODE=$CV_SSL
HTTP_PORT=$CV_HTTP_PORT
HTTPS_PORT=$CV_HTTPS_PORT
CORPVIDEO_VERSION=$CV_VERSION
SSL_CERT_PATH=/etc/corpvideo/ssl/fullchain.pem
SSL_KEY_PATH=/etc/corpvideo/ssl/privkey.pem
EOF
    chmod 600 "$envf"
    ok "Создан $envf (секреты сгенерированы)"
  else
    env_set "$envf" BASE_URL "$CV_BASE_URL"; env_set "$envf" DOMAIN "$CV_DOMAIN"; env_set "$envf" SSL_MODE "$CV_SSL"; env_set "$envf" CORPVIDEO_VERSION "$CV_VERSION"
    env_set "$envf" MEDIAMTX_VERSION "$(env_get "$envf" MEDIAMTX_VERSION || echo "$CV_MEDIAMTX_VERSION")"
    ok "Существующий $envf сохранён, обновлены домен/адрес"
  fi
  cp -f "$envf" "$CV_ENV"; chmod 600 "$CV_ENV"

  # MediaMTX
  API_HOST="api:3000"; HOOK_SECRET="$(env_get "$envf" MEDIAMTX_HOOK_SECRET)"; PUBLIC_HOST="$CV_DOMAIN"; RECORD_DIR="/data/live/recordings"; BIND_LOCAL=""
  render_template "$CV_APP_DIR/deploy/mediamtx/mediamtx.yml.template" "$CV_APP_DIR/deploy/mediamtx/mediamtx.yml" API_HOST HOOK_SECRET PUBLIC_HOST RECORD_DIR BIND_LOCAL
  ok "Конфигурация MediaMTX"

  # SSL
  case "$CV_SSL" in
    selfsigned)
      if [ ! -f "$CV_DATA_DIR/ssl/fullchain.pem" ]; then
        openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=$CV_DOMAIN/O=CorpVideo" -addext "subjectAltName=$([ "$is_ip" = "1" ] && echo "IP:$CV_DOMAIN" || echo "DNS:$CV_DOMAIN")" \
          -keyout "$CV_DATA_DIR/ssl/privkey.pem" -out "$CV_DATA_DIR/ssl/fullchain.pem" >>"$CV_LOG" 2>&1
        ok "Самоподписанный сертификат на 10 лет: $CV_DATA_DIR/ssl"
      fi ;;
    custom)
      [ -f "$CV_DATA_DIR/ssl/fullchain.pem" ] && [ -f "$CV_DATA_DIR/ssl/privkey.pem" ] || die "Положите fullchain.pem и privkey.pem в $CV_DATA_DIR/ssl и повторите" ;;
    letsencrypt)
      env_set "$envf" SSL_CERT_PATH "/etc/letsencrypt/live/$CV_DOMAIN/fullchain.pem"; env_set "$envf" SSL_KEY_PATH "/etc/letsencrypt/live/$CV_DOMAIN/privkey.pem" ;;
  esac
  chmod 600 "$CV_DATA_DIR/ssl/privkey.pem" 2>/dev/null || true

  step "Сборка образов (первая сборка занимает 3–10 минут)"
  cd "$CV_APP_DIR" || die "Нет каталога $CV_APP_DIR"
  docker compose build --pull >>"$CV_LOG" 2>&1 || { tail -40 "$CV_LOG" >&2; die "Сборка образов не удалась (см. $CV_LOG). Проверьте доступ к registry-1.docker.io и registry.npmjs.org"; }
  ok "Образы собраны"

  step "Запуск сервисов"
  if [ "$CV_SSL" = "letsencrypt" ] && [ ! -f "$CV_DATA_DIR/letsencrypt/live/$CV_DOMAIN/fullchain.pem" ]; then
    # Сначала поднимаем HTTP, получаем сертификат, затем включаем HTTPS
    SSL_MODE=none docker compose up -d db api worker mediamtx nginx >>"$CV_LOG" 2>&1
    wait_for_http "http://127.0.0.1:$CV_HTTP_PORT/api/health" 120 || die "API не отвечает (docker compose logs api)"
    info "Запрос сертификата Let's Encrypt для $CV_DOMAIN…"
    docker run --rm -v "$CV_DATA_DIR/letsencrypt:/etc/letsencrypt" -v "$CV_DATA_DIR/certbot:/var/www/certbot" certbot/certbot certonly --webroot -w /var/www/certbot \
      -d "$CV_DOMAIN" --email "$CV_LE_EMAIL" --agree-tos --no-eff-email --non-interactive >>"$CV_LOG" 2>&1 \
      || die "Let's Encrypt не выдал сертификат. Проверьте, что DNS $CV_DOMAIN указывает на этот сервер и порт 80 открыт. Можно повторить с --ssl selfsigned"
    ok "Сертификат получен"
  fi
  local profile=()
  [ "$CV_SSL" = "letsencrypt" ] && profile=(--profile letsencrypt)
  docker compose "${profile[@]}" up -d --remove-orphans >>"$CV_LOG" 2>&1 || die "docker compose up завершился с ошибкой"
  local health="http://127.0.0.1:$CV_HTTP_PORT/api/health"
  [ "$CV_SSL" = "none" ] || health="https://127.0.0.1:$CV_HTTPS_PORT/api/health"
  if ! wait_for_http_k "$health" 150; then docker compose logs --tail=50 api >&2; die "API не отвечает по $health"; fi
  ok "Сервисы запущены"

  step "Администратор и домены"
  docker compose exec -T api node server/src/cli.js create-admin --email "$CV_ADMIN_EMAIL" --password "$CV_ADMIN_PASSWORD" --name "$CV_ADMIN_NAME" >>"$CV_LOG" 2>&1 || die "Не удалось создать администратора"
  docker compose exec -T api node server/src/cli.js add-domain "$CV_ALLOW_DOMAIN" >>"$CV_LOG" 2>&1 || true
  ok "Администратор $CV_ADMIN_EMAIL создан, домен @$CV_ALLOW_DOMAIN разрешён"
}

wait_for_http_k() { # с -k для самоподписанных
  local url="$1" t="${2:-60}" i=0
  while [ $i -lt "$t" ]; do
    if curl -fsSk -o /dev/null --max-time 3 "$url" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}
