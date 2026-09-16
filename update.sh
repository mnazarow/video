#!/usr/bin/env bash
# =====================================================================================
#  CorpVideo — обновление установленной системы.
#
#    sudo ./update.sh                 # из папки с новой версией исходников
#    sudo corpvideo update            # то же, из установленной копии (git pull, если это git-репозиторий)
#    sudo ./update.sh --source corpvideo-1.3.0.tar.gz | --repo URL
#    sudo ./update.sh --no-backup     # не делать резервную копию БД перед обновлением
# =====================================================================================
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF=/etc/corpvideo/install.conf
[ -f "$CONF" ] || { echo "CorpVideo не установлен (нет $CONF). Используйте install.sh" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
LIB="$SCRIPT_DIR/scripts/lib/common.sh"; [ -f "$LIB" ] || LIB="$APP_DIR/scripts/lib/common.sh"
# shellcheck disable=SC1090
. "$LIB"
CV_APP_DIR="$APP_DIR"; CV_DATA_DIR="$DATA_DIR"
require_root "$@"; detect_os

NO_BACKUP=0; CV_REPO=""; CV_SOURCE=""; CV_YES="${CV_YES:-0}"
while [ $# -gt 0 ]; do case "$1" in --no-backup) NO_BACKUP=1; shift ;; --repo) CV_REPO="$2"; shift 2 ;; --source) CV_SOURCE="$2"; shift 2 ;; --yes|-y) CV_YES=1; shift ;; *) echo "Неизвестный параметр: $1" >&2; exit 2 ;; esac; done

# --- Откуда брать новую версию -----------------------------------------------------------
SOURCE_DIR=""
if [ -n "$CV_SOURCE" ]; then TMP="$(mktemp -d)"; tar -xzf "$CV_SOURCE" -C "$TMP"; SOURCE_DIR="$(dirname "$(find "$TMP" -maxdepth 3 -name package.json -path '*server*' | head -1)")/.."
elif [ -n "$CV_REPO" ]; then TMP="$(mktemp -d)"; git clone --depth 1 "$CV_REPO" "$TMP/src"; SOURCE_DIR="$TMP/src"
elif [ -f "$SCRIPT_DIR/server/package.json" ] && [ "$SCRIPT_DIR" != "$APP_DIR" ]; then SOURCE_DIR="$SCRIPT_DIR"
elif [ -d "$APP_DIR/.git" ]; then step "git pull в $APP_DIR"; (cd "$APP_DIR" && git pull --ff-only) || die "git pull не удался"; SOURCE_DIR="$APP_DIR"
else SOURCE_DIR="$APP_DIR"; warn "Новые исходники не указаны — пересобираем установленную версию из $APP_DIR"; fi
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
NEW_VERSION="$(cat "$SOURCE_DIR/VERSION" 2>/dev/null || echo unknown)"
print_banner
step "Обновление CorpVideo: $VERSION → $NEW_VERSION ($MODE)"
[ "$CV_YES" = "1" ] || { confirm "Продолжить?" || exit 0; }

# --- Резервная копия --------------------------------------------------------------------
if [ "$NO_BACKUP" != "1" ]; then
  step "Резервная копия базы данных"
  BK="$DATA_DIR/backups/pre-update-$(date +%Y%m%d-%H%M%S).dump"
  mkdir -p "$DATA_DIR/backups"
  if [ "$MODE" = "docker" ]; then (cd "$APP_DIR" && docker compose exec -T db pg_dump -U corpvideo -Fc corpvideo > "$BK")
  else su - postgres -c "pg_dump -Fc corpvideo" > "$BK"; fi
  ok "Сохранено: $BK ($(du -h "$BK" | cut -f1))"
fi

if [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  step "Копирование новой версии"
  rsync -a --delete --exclude '.env' --exclude 'node_modules' --exclude 'web/dist' --exclude 'server/data' --exclude '.git' --exclude '/mediamtx/' --exclude 'deploy/mediamtx/mediamtx.yml' "$SOURCE_DIR/" "$APP_DIR/"
  ok "Файлы обновлены"
fi
save_conf VERSION "$NEW_VERSION"; save_conf UPDATED_AT "$(date -Is)"

cv_rollback() { warn "Обновление прервано. Резервная копия БД: ${BK:-нет}. Восстановление: corpvideo restore <файл>"; }

if [ "$MODE" = "docker" ]; then
  cd "$APP_DIR"
  env_set .env CORPVIDEO_VERSION "$NEW_VERSION"; cp -f .env "$CV_ENV"
  API_HOST="api:3000"; HOOK_SECRET="$(env_get .env MEDIAMTX_HOOK_SECRET)"; PUBLIC_HOST="$DOMAIN"; RECORD_DIR="/data/live/recordings"; BIND_LOCAL=""
  render_template deploy/mediamtx/mediamtx.yml.template deploy/mediamtx/mediamtx.yml API_HOST HOOK_SECRET PUBLIC_HOST RECORD_DIR BIND_LOCAL
  step "Сборка образов"
  docker compose build --pull >>"$CV_LOG" 2>&1 || { tail -40 "$CV_LOG" >&2; die "Сборка не удалась"; }
  step "Перезапуск сервисов (миграции применяются автоматически)"
  profile=(); [ "$SSL_MODE" = "letsencrypt" ] && profile=(--profile letsencrypt)
  docker compose "${profile[@]}" up -d --remove-orphans >>"$CV_LOG" 2>&1
  sleep 3
  for _ in $(seq 1 60); do docker compose exec -T api curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 2; done
  docker compose exec -T api curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 || { docker compose logs --tail=50 api >&2; die "API не поднялся после обновления"; }
  docker image prune -f >>"$CV_LOG" 2>&1 || true
else
  step "Зависимости и сборка"
  cd "$APP_DIR/server" && npm ci --omit=dev --no-audit --no-fund >>"$CV_LOG" 2>&1 || die "npm ci (server)"
  cd "$APP_DIR/web" && npm ci --no-audit --no-fund >>"$CV_LOG" 2>&1 && npm run build >>"$CV_LOG" 2>&1 || die "Сборка веб-интерфейса"
  rm -rf "$APP_DIR/web/node_modules"
  # Функции нативной установки (MediaMTX, nginx); переменные CV_* — из install.conf
  # shellcheck disable=SC1091
  . "$APP_DIR/scripts/install-native.sh"
  CV_DOMAIN="$DOMAIN"; CV_SSL="$SSL_MODE"; CV_LE_EMAIL="${LE_EMAIL:-}"; CV_BASE_URL="$BASE_URL"; CV_VERSION="$NEW_VERSION"
  is_ip=0; [[ "$CV_DOMAIN" =~ ^[0-9.]+$ ]] && is_ip=1
  cv_rollback() { warn "Обновление прервано. Резервная копия БД: ${BK:-нет}. Восстановление: corpvideo restore <файл>"; }
  # Обновление MediaMTX при необходимости и перерисовка его конфигурации
  CV_MEDIAMTX_VERSION="$(env_get "$CV_ENV" MEDIAMTX_VERSION)"; CV_MEDIAMTX_VERSION="${CV_MEDIAMTX_VERSION:-$CV_MEDIAMTX_DEFAULT}"
  ensure_mediamtx || true
  API_HOST="127.0.0.1:3000"; HOOK_SECRET="$(env_get "$CV_ENV" MEDIAMTX_HOOK_SECRET)"; PUBLIC_HOST="$CV_DOMAIN"; RECORD_DIR="$DATA_DIR/live/recordings"; BIND_LOCAL="127.0.0.1"
  render_template "$APP_DIR/deploy/mediamtx/mediamtx.yml.template" "$CV_CONF_DIR/mediamtx.yml" API_HOST HOOK_SECRET PUBLIC_HOST RECORD_DIR BIND_LOCAL
  env_set "$CV_ENV" CORPVIDEO_VERSION "$NEW_VERSION"
  chown -R corpvideo:corpvideo "$APP_DIR"
  cp -f "$APP_DIR"/deploy/systemd/corpvideo-*.service /etc/systemd/system/
  sed -i "s|/opt/corpvideo|$APP_DIR|g; s|/var/lib/corpvideo|$DATA_DIR|g" /etc/systemd/system/corpvideo-*.service
  sed -i "s|ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" /etc/systemd/system/corpvideo-api.service /etc/systemd/system/corpvideo-worker.service
  systemctl daemon-reload
  step "Миграции и перезапуск"
  cd "$APP_DIR/server" && su -s /bin/bash corpvideo -c "ENV_FILE=$CV_ENV node src/cli.js migrate" >>"$CV_LOG" 2>&1 || die "Миграции не выполнены"
  systemctl restart corpvideo-api corpvideo-worker; systemctl restart corpvideo-mediamtx 2>/dev/null || true
  wait_for_http "http://127.0.0.1:3000/api/health" 60 || { tail -30 /var/log/corpvideo/api.log >&2; die "API не поднялся"; }
  step "nginx"
  configure_nginx_native
  ok "Конфигурация nginx обновлена"
fi
install -m 755 "$APP_DIR/scripts/corpvideo-cli.sh" /usr/local/bin/corpvideo
echo; echo "${C_GREEN}${C_BOLD}Обновление до $NEW_VERSION завершено.${C_RESET} Проверка: corpvideo status"
