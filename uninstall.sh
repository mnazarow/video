#!/usr/bin/env bash
# =====================================================================================
#  CorpVideo — удаление.
#    sudo ./uninstall.sh            # остановить и удалить приложение, данные сохранить
#    sudo ./uninstall.sh --purge    # удалить всё, включая видео, базу данных и сертификаты
#    sudo ./uninstall.sh --purge --backup   # перед удалением сделать резервную копию в /root
#    --yes  — без подтверждений
# =====================================================================================
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF=/etc/corpvideo/install.conf
[ -f "$CONF" ] || { echo "CorpVideo не установлен (нет $CONF)" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
LIB="$SCRIPT_DIR/scripts/lib/common.sh"; [ -f "$LIB" ] || LIB="$APP_DIR/scripts/lib/common.sh"
# shellcheck disable=SC1090
. "$LIB"
trap - ERR
require_root "$@"
PURGE=0; BACKUP=0; CV_YES="${CV_YES:-0}"
while [ $# -gt 0 ]; do case "$1" in --purge) PURGE=1; shift ;; --backup) BACKUP=1; shift ;; --yes|-y) CV_YES=1; shift ;; *) echo "Неизвестный параметр: $1" >&2; exit 2 ;; esac; done

print_banner
step "Удаление CorpVideo ($MODE)"
info "Приложение: $APP_DIR • Данные: $DATA_DIR • Домен: $DOMAIN"
if [ "$PURGE" = "1" ]; then warn "Режим --purge: будут удалены ВСЕ видео, база данных, сертификаты и настройки!"; else info "Данные ($DATA_DIR) и база данных будут сохранены. Для полного удаления добавьте --purge"; fi
[ "$CV_YES" = "1" ] || { confirm "Продолжить удаление?" || exit 0; }
if [ "$PURGE" = "1" ] && [ "$CV_YES" != "1" ]; then read -r -p "Введите домен портала ($DOMAIN) для подтверждения: " d; [ "$d" = "$DOMAIN" ] || { echo "Отменено"; exit 1; }; fi

if [ "$BACKUP" = "1" ]; then
  step "Резервная копия"
  BK="/root/corpvideo-final-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BK"
  if [ "$MODE" = "docker" ]; then (cd "$APP_DIR" && docker compose exec -T db pg_dump -U corpvideo -Fc corpvideo > "$BK/db.dump") || warn "Не удалось сделать дамп БД"
  else su - postgres -c "pg_dump -Fc corpvideo" > "$BK/db.dump" || warn "Не удалось сделать дамп БД"; fi
  cp -f "$CV_ENV" "$BK/corpvideo.env" 2>/dev/null || true
  info "Архивирование медиафайлов (может занять время)…"; tar -czf "$BK/media.tar.gz" -C "$DATA_DIR" media 2>/dev/null || warn "Медиа не заархивированы"
  ok "Резервная копия: $BK"
fi

if [ "$MODE" = "docker" ]; then
  step "Остановка контейнеров"
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    down_args=(down --remove-orphans); [ "$PURGE" = 1 ] && down_args+=(--volumes --rmi local)
    (cd "$APP_DIR" && docker compose --profile letsencrypt "${down_args[@]}") >>"$CV_LOG" 2>&1 || true
  fi
  ok "Контейнеры остановлены"
else
  step "Остановка служб"
  systemctl disable --now corpvideo-api corpvideo-worker corpvideo-mediamtx >>"$CV_LOG" 2>&1 || true
  rm -f /etc/systemd/system/corpvideo-*.service; systemctl daemon-reload
  rm -f /etc/nginx/sites-enabled/corpvideo /etc/nginx/sites-available/corpvideo /etc/nginx/conf.d/corpvideo-maps.conf /etc/nginx/corpvideo-locations.conf
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  ok "Службы и конфигурация nginx удалены (nginx и PostgreSQL остаются установленными)"
  if [ "$PURGE" = "1" ]; then
    su - postgres -c "psql -c 'DROP DATABASE IF EXISTS corpvideo'" >>"$CV_LOG" 2>&1 || true
    su - postgres -c "psql -c 'DROP ROLE IF EXISTS corpvideo'" >>"$CV_LOG" 2>&1 || true
    ok "База данных удалена"
    if [ -d "/etc/letsencrypt/live/$DOMAIN" ] && has_cmd certbot; then certbot delete --cert-name "$DOMAIN" --non-interactive >>"$CV_LOG" 2>&1 || true; fi
  fi
fi

step "Файлы"
rm -rf "$APP_DIR"; ok "Удалён $APP_DIR"
rm -f /usr/local/bin/corpvideo
if [ "$PURGE" = "1" ]; then
  rm -rf "$DATA_DIR" /etc/corpvideo /var/log/corpvideo; ok "Удалены $DATA_DIR, /etc/corpvideo, /var/log/corpvideo"
  id -u corpvideo >/dev/null 2>&1 && userdel corpvideo 2>/dev/null || true
  echo; echo "${C_GREEN}${C_BOLD}CorpVideo полностью удалён.${C_RESET}"
else
  rm -f /etc/corpvideo/install.conf
  echo; echo "${C_GREEN}${C_BOLD}Приложение удалено.${C_RESET} Данные сохранены в $DATA_DIR, конфигурация — в /etc/corpvideo/corpvideo.env."
  echo "Повторная установка (install.sh) подхватит существующие данные и базу."
fi
