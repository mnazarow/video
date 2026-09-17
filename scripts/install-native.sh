#!/usr/bin/env bash
# CorpVideo — нативная установка на Ubuntu/Debian (nginx + PostgreSQL + Node.js + ffmpeg + MediaMTX + systemd).
# Подключается из install.sh; переменные CV_* уже заданы.

ensure_node() {
  if has_cmd node && version_ge "$(node -v | tr -d v)" "20.0.0"; then ok "Node.js $(node -v)"; return; fi
  info "Устанавливаем Node.js $CV_NODE_MAJOR (NodeSource)…"
  pkg_install curl ca-certificates gnupg
  if curl -fsSL "https://deb.nodesource.com/setup_${CV_NODE_MAJOR}.x" -o /tmp/nodesource.sh 2>>"$CV_LOG"; then
    bash /tmp/nodesource.sh >>"$CV_LOG" 2>&1 || warn "Скрипт NodeSource завершился с ошибкой"
    pkg_install nodejs
  fi
  if ! has_cmd node || ! version_ge "$(node -v | tr -d v)" "20.0.0"; then
    warn "NodeSource недоступен — пробуем пакет nodejs из дистрибутива"
    pkg_install nodejs npm
  fi
  has_cmd node && version_ge "$(node -v | tr -d v)" "20.0.0" || die "Требуется Node.js 20+. Установите вручную: https://nodejs.org/"
  ok "Node.js $(node -v)"
}

ensure_mediamtx() {
  local ver="$CV_MEDIAMTX_VERSION" dir="$CV_APP_DIR/mediamtx"
  mkdir -p "$dir"
  if [ -x "$dir/mediamtx" ] && "$dir/mediamtx" --version 2>/dev/null | grep -q "$ver"; then ok "MediaMTX $ver уже установлен"; return; fi
  info "Загрузка MediaMTX $ver…"
  local url="https://github.com/bluenviron/mediamtx/releases/download/v${ver}/mediamtx_v${ver}_linux_${ARCH_DL}.tar.gz"
  if curl -fsSL --max-time 120 "$url" -o /tmp/mediamtx.tar.gz 2>>"$CV_LOG"; then
    tar -xzf /tmp/mediamtx.tar.gz -C "$dir" mediamtx && chmod +x "$dir/mediamtx" && ok "MediaMTX $ver установлен"
  else
    warn "Не удалось скачать MediaMTX ($url). Трансляции не будут работать, пока файл $dir/mediamtx не появится (см. руководство)."
  fi
}

# Последние строки лога в сообщении об ошибке: без них причина сбоя остаётся невидимой
build_fail() { echo >&2; echo "${C_DIM}--- последние строки $CV_LOG ---${C_RESET}" >&2; tail -n 25 "$CV_LOG" 2>/dev/null >&2 || true; echo "${C_DIM}--- конец фрагмента ---${C_RESET}" >&2; die "$1"; }

# Установка зависимостей с повтором: одна сетевая ошибка не должна прерывать установку или обновление портала
npm_install_retry() { # $1 — подпись для лога, дальше аргументы npm
  local label="$1"; shift
  local try
  for try in 1 2 3; do
    if npm "$@" >>"$CV_LOG" 2>&1; then return 0; fi
    warn "$label: попытка $try не удалась (сеть или registry) — повтор через 5 с"
    sleep 5
  done
  return 1
}

# Зависимости и сборка. build_app <каталог приложения> [каталог дистрибутива с готовым web/dist]
build_app() {
  local app="$1" prebuilt="${2:-}"
  local WEB_DEPS_OK=1 PREBUILT_WEB=0 mem_mb
  step "Зависимости и сборка (несколько минут)"
  # Долгие таймауты и повторы: в корпоративных сетях npm часто отваливается по ETIMEDOUT на середине установки
  export NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-5}"
  export NPM_CONFIG_FETCH_RETRY_MINTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:-20000}"
  export NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:-120000}"
  export NPM_CONFIG_FETCH_TIMEOUT="${NPM_CONFIG_FETCH_TIMEOUT:-600000}"


  info "Зависимости сервера…"
  cd "$app/server"
  npm_install_retry "npm ci (server)" ci --omit=dev --no-audit --no-fund \
    || build_fail "Не удалось установить зависимости сервера — проверьте доступ к registry.npmjs.org (см. $CV_LOG)"

  info "Зависимости веб-интерфейса…"
  cd "$app/web"
  WEB_DEPS_OK=1
  if ! npm_install_retry "npm ci (web)" ci --no-audit --no-fund; then
    # Отдельно пробуем npm install: он переживает и рассинхрон lock-файла, и пропажу optional-пакетов (@rollup/*, @esbuild/*)
    warn "npm ci (web) не удался — пробуем npm install"
    rm -rf node_modules
    npm_install_retry "npm install (web)" install --no-audit --no-fund || WEB_DEPS_OK=0
  fi
  if [ "$WEB_DEPS_OK" = "0" ]; then
    if [ -n "${prebuilt:-}" ] && [ -f "$prebuilt/index.html" ]; then
      warn "Зависимости веб-интерфейса не скачались — берём готовый web/dist из дистрибутива"
      rm -rf "$app/web/dist" && mkdir -p "$app/web" && cp -a "$prebuilt" "$app/web/dist"
      PREBUILT_WEB=1
    else
      build_fail "Не удалось установить зависимости веб-интерфейса — проверьте доступ к registry.npmjs.org. Если доступа в интернет нет, соберите web/dist на машине с интернетом (cd web && npm ci && npm run build) и скопируйте каталог web/dist в $app/web/ (см. $CV_LOG)"
    fi
  fi

  info "Сборка веб-интерфейса…"
  # Сборке Vite нужно около 1 ГБ; на маленьких серверах ограничиваем кучу, чтобы не получить OOM-kill
  mem_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${mem_mb:-0}" -gt 0 ] && [ "$mem_mb" -lt 1400 ]; then
    warn "Свободно всего ${mem_mb} МБ — сборка может не хватить памяти; при сбое добавьте swap (см. docs)"
    export NODE_OPTIONS="--max-old-space-size=$(( mem_mb > 700 ? mem_mb - 200 : 512 ))"
  fi
  if [ "${PREBUILT_WEB:-0}" = "1" ]; then
    ok "Взят готовый web/dist (сборка пропущена)"
  elif ! npm run build >>"$CV_LOG" 2>&1; then
    if tail -n 200 "$CV_LOG" 2>/dev/null | grep -qE "out of memory|Killed|ENOMEM"; then
      build_fail "Сборке веб-интерфейса не хватило памяти. Добавьте swap: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile — и запустите установку повторно"
    fi
    build_fail "Сборка веб-интерфейса не удалась (см. $CV_LOG)"
  fi
  [ -f "$app/web/dist/index.html" ] || build_fail "Веб-интерфейс не собран: нет web/dist/index.html (см. $CV_LOG)"
  unset NODE_OPTIONS
  rm -rf "$app/web/node_modules"
  ok "Сервер и веб-интерфейс собраны"
}

cv_rollback() {
  systemctl stop corpvideo-api corpvideo-worker corpvideo-mediamtx 2>/dev/null || true
  warn "Установка не завершена. База данных и файлы в $CV_DATA_DIR сохранены; повторный запуск install.sh продолжит установку."
}

install_native() {
  step "Системные пакеты"
  pkg_update
  pkg_install curl ca-certificates gnupg rsync openssl jq tar nginx postgresql postgresql-contrib ffmpeg
  # yt-dlp (импорт видео со страниц видеосервисов) — необязательный: отсутствие пакета в репозитории не критично
  if ! (DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends yt-dlp >>"$CV_LOG" 2>&1); then
    warn "yt-dlp не установлен — импорт по ссылке будет работать только для прямых ссылок на файлы"
  fi
  # tesseract (текст на экране / OCR, версия 1.3) — необязательный
  if ! (DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng >>"$CV_LOG" 2>&1); then
    warn "tesseract не установлен — распознавание текста на экране (OCR) будет недоступно"
  fi
  # python3-opencv (автопоиск лиц для размытия, версия 1.9) — необязательный
  if ! (DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-opencv >>"$CV_LOG" 2>&1); then
    warn "python3-opencv не установлен — автопоиск лиц недоступен, области размытия задаются вручную"
  fi
  ensure_node
  ok "nginx $(nginx -v 2>&1 | grep -oE '[0-9.]+' | head -1), PostgreSQL $(psql --version | grep -oE '[0-9]+' | head -1), ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

  step "Пользователь и каталоги"
  id -u "$CV_USER" >/dev/null 2>&1 || useradd --system --home-dir "$CV_APP_DIR" --shell /usr/sbin/nologin "$CV_USER"
  mkdir -p "$CV_APP_DIR" "$CV_DATA_DIR"/{media,uploads,live/recordings,ssl,backups} "$CV_LOG_DIR" "$CV_CONF_DIR"
  ok "Пользователь $CV_USER, $CV_APP_DIR, $CV_DATA_DIR"

  step "База данных PostgreSQL"
  systemctl enable --now postgresql >>"$CV_LOG" 2>&1
  local dbpass
  if [ -f "$CV_ENV" ] && [ -n "$(env_get "$CV_ENV" DB_PASSWORD)" ]; then dbpass="$(env_get "$CV_ENV" DB_PASSWORD)"; else dbpass="$(random_secret 32)"; fi
  if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='corpvideo'\"" | grep -q 1; then
    su - postgres -c "psql -c \"CREATE ROLE corpvideo LOGIN PASSWORD '$dbpass'\"" >>"$CV_LOG" 2>&1
  else
    su - postgres -c "psql -c \"ALTER ROLE corpvideo LOGIN PASSWORD '$dbpass'\"" >>"$CV_LOG" 2>&1
  fi
  if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='corpvideo'\"" | grep -q 1; then
    su - postgres -c "psql -c \"CREATE DATABASE corpvideo OWNER corpvideo ENCODING 'UTF8' TEMPLATE template0\"" >>"$CV_LOG" 2>&1
  fi
  ok "База corpvideo готова"

  step "Копирование приложения"
  if [ "$(cd "$SOURCE_DIR" && pwd)" != "$(cd "$CV_APP_DIR" && pwd)" ]; then
    rsync -a --delete --exclude '.env' --exclude 'node_modules' --exclude 'web/dist' --exclude 'server/data' --exclude '.git' --exclude '/mediamtx/' "$SOURCE_DIR/" "$CV_APP_DIR/"
    # Готовый web/dist из дистрибутива не переносим сразу (он не должен затирать свежую сборку),
    # но запоминаем путь: если npm не отработает, соберём портал из него, а не из старой установки.
    [ -f "$SOURCE_DIR/web/dist/index.html" ] && CV_PREBUILT_DIST="$SOURCE_DIR/web/dist" || true
  fi
  ok "Исходники в $CV_APP_DIR"

  step "Конфигурация"
  if [ ! -f "$CV_ENV" ]; then
    cat > "$CV_ENV" <<EOF
# CorpVideo — конфигурация (создано install.sh $(date -Is))
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
BASE_URL=$CV_BASE_URL
DOMAIN=$CV_DOMAIN
SECRET_KEY=$(random_secret 64)
DATABASE_URL=postgres://corpvideo:$dbpass@127.0.0.1:5432/corpvideo
DB_PASSWORD=$dbpass
DATA_DIR=$CV_DATA_DIR
WEB_DIST=$CV_APP_DIR/web/dist
LOG_LEVEL=info
TRUST_PROXY=true
WORKER_CONCURRENCY=$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))
NGINX_ACCEL=1
MEDIAMTX_VERSION=$CV_MEDIAMTX_VERSION
MEDIAMTX_API_URL=http://127.0.0.1:9997
MEDIAMTX_HLS_URL=http://127.0.0.1:8888
MEDIAMTX_PLAYBACK_URL=http://127.0.0.1:9996
MEDIAMTX_HOOK_SECRET=$(random_secret 32)
LIVE_RTMP_URL=rtmp://$CV_DOMAIN:1935
LIVE_SRT_URL=srt://$CV_DOMAIN:8890
LIVE_WHIP_URL=$CV_BASE_URL/whip
SSL_MODE=$CV_SSL
CORPVIDEO_VERSION=$CV_VERSION
EOF
    chmod 640 "$CV_ENV"; chown root:"$CV_USER" "$CV_ENV"
    ok "Создан $CV_ENV"
  else
    env_set "$CV_ENV" BASE_URL "$CV_BASE_URL"; env_set "$CV_ENV" DOMAIN "$CV_DOMAIN"; env_set "$CV_ENV" SSL_MODE "$CV_SSL"; env_set "$CV_ENV" CORPVIDEO_VERSION "$CV_VERSION"
    env_set "$CV_ENV" DATABASE_URL "postgres://corpvideo:$dbpass@127.0.0.1:5432/corpvideo"; env_set "$CV_ENV" DB_PASSWORD "$dbpass"
    ok "Существующий $CV_ENV сохранён"
  fi

  build_app "$CV_APP_DIR" "${CV_PREBUILT_DIST:-}"

  step "Сервер трансляций MediaMTX"
  ensure_mediamtx
  API_HOST="127.0.0.1:3000"; HOOK_SECRET="$(env_get "$CV_ENV" MEDIAMTX_HOOK_SECRET)"; PUBLIC_HOST="$CV_DOMAIN"; RECORD_DIR="$CV_DATA_DIR/live/recordings"; BIND_LOCAL="127.0.0.1"
  render_template "$CV_APP_DIR/deploy/mediamtx/mediamtx.yml.template" "$CV_CONF_DIR/mediamtx.yml" API_HOST HOOK_SECRET PUBLIC_HOST RECORD_DIR BIND_LOCAL
  chown -R "$CV_USER:$CV_USER" "$CV_APP_DIR" "$CV_DATA_DIR" "$CV_LOG_DIR"

  step "Службы systemd"
  cp -f "$CV_APP_DIR"/deploy/systemd/corpvideo-*.service /etc/systemd/system/
  sed -i "s|/opt/corpvideo|$CV_APP_DIR|g; s|/var/lib/corpvideo|$CV_DATA_DIR|g" /etc/systemd/system/corpvideo-*.service
  sed -i "s|ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" /etc/systemd/system/corpvideo-api.service /etc/systemd/system/corpvideo-worker.service
  systemctl daemon-reload
  systemctl enable corpvideo-api corpvideo-worker >>"$CV_LOG" 2>&1
  [ -x "$CV_APP_DIR/mediamtx/mediamtx" ] && systemctl enable corpvideo-mediamtx >>"$CV_LOG" 2>&1 || true
  # Миграции и администратор до запуска служб
  cd "$CV_APP_DIR/server" || die "Нет каталога $CV_APP_DIR/server"
  su -s /bin/bash "$CV_USER" -c "ENV_FILE=$CV_ENV node src/cli.js migrate" >>"$CV_LOG" 2>&1 || die "Миграции БД не выполнены (см. $CV_LOG)"
  su -s /bin/bash "$CV_USER" -c "ENV_FILE=$CV_ENV node src/cli.js create-admin --email '$CV_ADMIN_EMAIL' --password '$CV_ADMIN_PASSWORD' --name '$CV_ADMIN_NAME'" >>"$CV_LOG" 2>&1 || die "Не удалось создать администратора"
  su -s /bin/bash "$CV_USER" -c "ENV_FILE=$CV_ENV node src/cli.js add-domain '$CV_ALLOW_DOMAIN'" >>"$CV_LOG" 2>&1 || true
  systemctl restart corpvideo-api corpvideo-worker
  [ -x "$CV_APP_DIR/mediamtx/mediamtx" ] && systemctl restart corpvideo-mediamtx || true
  wait_for_http "http://127.0.0.1:3000/api/health" 60 || { tail -30 "$CV_LOG_DIR/api.log" >&2; die "API не запустился (см. $CV_LOG_DIR/api.log)"; }
  ok "Службы corpvideo-api, corpvideo-worker$([ -x "$CV_APP_DIR/mediamtx/mediamtx" ] && echo ', corpvideo-mediamtx') запущены"

  step "nginx и HTTPS"
  configure_nginx_native
  ok "nginx настроен ($CV_SSL)"
}

configure_nginx_native() {
  local SERVER_NAME="$CV_DOMAIN" API_UPSTREAM="127.0.0.1:3000" MEDIAMTX_WEBRTC="127.0.0.1:8889" MEDIA_ROOT="$CV_DATA_DIR/media" WEB_ROOT="$CV_APP_DIR/web/dist" UPLOAD_CHUNK_LIMIT="64m"
  local SSL_CERT="$CV_DATA_DIR/ssl/fullchain.pem" SSL_KEY="$CV_DATA_DIR/ssl/privkey.pem"
  # HTTP/2: «http2 on;» появился в nginx 1.25.1, в более старых — параметр listen … http2
  local LISTEN_HTTP2="" HTTP2_DIRECTIVE="http2 on;" ngx_ver
  ngx_ver="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if ! version_ge "${ngx_ver:-0}" "1.25.1"; then LISTEN_HTTP2=" http2"; HTTP2_DIRECTIVE=""; fi
  mkdir -p /var/www/certbot
  cp -f "$CV_APP_DIR/deploy/nginx/maps.conf" /etc/nginx/conf.d/corpvideo-maps.conf
  render_template "$CV_APP_DIR/deploy/nginx/locations.conf.template" /etc/nginx/corpvideo-locations.conf API_UPSTREAM MEDIAMTX_WEBRTC MEDIA_ROOT WEB_ROOT UPLOAD_CHUNK_LIMIT
  # nginx должен читать медиа и статику
  usermod -aG "$CV_USER" www-data 2>/dev/null || true
  chmod 750 "$CV_DATA_DIR"; chmod -R g+rX "$CV_DATA_DIR/media" "$CV_APP_DIR/web/dist" 2>/dev/null || true
  chmod g+rx "$CV_DATA_DIR" "$CV_APP_DIR" "$CV_APP_DIR/web"
  local site=/etc/nginx/sites-available/corpvideo
  rm -f /etc/nginx/sites-enabled/default
  case "$CV_SSL" in
    none)
      render_template "$CV_APP_DIR/deploy/nginx/site.conf.template" "$site" SERVER_NAME SSL_CERT SSL_KEY API_UPSTREAM LISTEN_HTTP2 HTTP2_DIRECTIVE
      sed -i -e '/#--HTTPS-START--/,/#--HTTPS-END--/d' -e '/#--REDIRECT-START--/,/#--REDIRECT-END--/d' "$site" ;;
    selfsigned)
      if [ ! -f "$SSL_CERT" ]; then
        openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=$CV_DOMAIN/O=CorpVideo" -addext "subjectAltName=$([ "$is_ip" = "1" ] && echo "IP:$CV_DOMAIN" || echo "DNS:$CV_DOMAIN")" -keyout "$SSL_KEY" -out "$SSL_CERT" >>"$CV_LOG" 2>&1
        chmod 640 "$SSL_KEY"; chown root:www-data "$SSL_KEY" "$SSL_CERT"
      fi
      render_template "$CV_APP_DIR/deploy/nginx/site.conf.template" "$site" SERVER_NAME SSL_CERT SSL_KEY API_UPSTREAM LISTEN_HTTP2 HTTP2_DIRECTIVE
      sed -i '/#--HTTP-ONLY-START--/,/#--HTTP-ONLY-END--/d' "$site" ;;
    custom)
      [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ] || die "Положите fullchain.pem и privkey.pem в $CV_DATA_DIR/ssl"
      render_template "$CV_APP_DIR/deploy/nginx/site.conf.template" "$site" SERVER_NAME SSL_CERT SSL_KEY API_UPSTREAM LISTEN_HTTP2 HTTP2_DIRECTIVE
      sed -i '/#--HTTP-ONLY-START--/,/#--HTTP-ONLY-END--/d' "$site" ;;
    letsencrypt)
      # 1) HTTP-конфигурация для проверки ACME, 2) certbot, 3) HTTPS-конфигурация
      render_template "$CV_APP_DIR/deploy/nginx/site.conf.template" "$site" SERVER_NAME SSL_CERT SSL_KEY API_UPSTREAM LISTEN_HTTP2 HTTP2_DIRECTIVE
      sed -i -e '/#--HTTPS-START--/,/#--HTTPS-END--/d' -e '/#--REDIRECT-START--/,/#--REDIRECT-END--/d' "$site"
      [ -f /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$site"
      ln -sf "$site" /etc/nginx/sites-enabled/corpvideo
      nginx -t >>"$CV_LOG" 2>&1 || die "Ошибка конфигурации nginx (nginx -t)"
      systemctl enable --now nginx >>"$CV_LOG" 2>&1; systemctl reload nginx
      if [ ! -f "/etc/letsencrypt/live/$CV_DOMAIN/fullchain.pem" ]; then
        pkg_install certbot
        info "Запрос сертификата Let's Encrypt для $CV_DOMAIN…"
        certbot certonly --webroot -w /var/www/certbot -d "$CV_DOMAIN" --email "$CV_LE_EMAIL" --agree-tos --no-eff-email --non-interactive >>"$CV_LOG" 2>&1 \
          || die "Let's Encrypt не выдал сертификат: проверьте DNS $CV_DOMAIN и доступность порта 80. Повторите с --ssl selfsigned при необходимости"
        ok "Сертификат получен; автопродление — через systemd-таймер certbot"
      fi
      SSL_CERT="/etc/letsencrypt/live/$CV_DOMAIN/fullchain.pem"; SSL_KEY="/etc/letsencrypt/live/$CV_DOMAIN/privkey.pem"
      render_template "$CV_APP_DIR/deploy/nginx/site.conf.template" "$site" SERVER_NAME SSL_CERT SSL_KEY API_UPSTREAM LISTEN_HTTP2 HTTP2_DIRECTIVE
      sed -i '/#--HTTP-ONLY-START--/,/#--HTTP-ONLY-END--/d' "$site"
      # Перезагрузка nginx после продления
      mkdir -p /etc/letsencrypt/renewal-hooks/deploy
      printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/corpvideo-nginx.sh; chmod +x /etc/letsencrypt/renewal-hooks/deploy/corpvideo-nginx.sh ;;
  esac
  [ -f /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$site"   # система без IPv6
  ln -sf "$site" /etc/nginx/sites-enabled/corpvideo
  nginx -t >>"$CV_LOG" 2>&1 || { nginx -t 2>&1 | tail -5 >&2; die "Ошибка конфигурации nginx"; }
  systemctl enable --now nginx >>"$CV_LOG" 2>&1; systemctl reload nginx
}
