#!/usr/bin/env bash
# =====================================================================================
#  CorpVideo — восстановление из резервной копии.
#    sudo ./restore.sh /var/lib/corpvideo/backups/20260916-030000          # каталог копии
#    sudo ./restore.sh backup/db.dump                                       # только база данных
#    --yes — без подтверждения
#  Медиафайлы (media.tar) восстанавливаются, если присутствуют в каталоге копии.
# =====================================================================================
set -Eeuo pipefail
CONF=/etc/corpvideo/install.conf
[ -f "$CONF" ] || { echo "CorpVideo не установлен" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
# shellcheck disable=SC1090
. "$APP_DIR/scripts/lib/common.sh"
require_root "$@"
SRC=""; CV_YES="${CV_YES:-0}"
while [ $# -gt 0 ]; do case "$1" in --yes|-y) CV_YES=1; shift ;; -h|--help) sed -n '2,8p' "$0"; exit 0 ;; *) SRC="$1"; shift ;; esac; done
[ -n "$SRC" ] || { sed -n '2,8p' "$0"; exit 2; }
if [ -d "$SRC" ]; then DUMP="$SRC/db.dump"; MEDIA_TAR="$SRC/media.tar"; else DUMP="$SRC"; MEDIA_TAR=""; fi
[ -f "$DUMP" ] || die "Не найден дамп базы: $DUMP"
step "Восстановление из $SRC"
warn "Текущая база данных будет ЗАМЕНЕНА содержимым копии."
confirm "Продолжить?" || exit 0
if [ "$MODE" = "docker" ]; then
  cd "$APP_DIR"
  docker compose stop api worker >>"$CV_LOG" 2>&1
  docker compose exec -T db psql -U corpvideo -d postgres -c "DROP DATABASE IF EXISTS corpvideo" >>"$CV_LOG" 2>&1
  docker compose exec -T db psql -U corpvideo -d postgres -c "CREATE DATABASE corpvideo" >>"$CV_LOG" 2>&1
  docker compose exec -T db pg_restore -U corpvideo -d corpvideo --no-owner < "$DUMP" >>"$CV_LOG" 2>&1 || warn "pg_restore сообщил о предупреждениях (см. $CV_LOG)"
  if [ -n "$MEDIA_TAR" ] && [ -f "$MEDIA_TAR" ]; then info "Восстановление медиафайлов…"; tar -xf "$MEDIA_TAR" -C "$DATA_DIR"; chown -R 1000:1000 "$DATA_DIR/media"; fi
  docker compose start api worker >>"$CV_LOG" 2>&1
else
  systemctl stop corpvideo-api corpvideo-worker
  su - postgres -c "psql -c 'DROP DATABASE IF EXISTS corpvideo'" >>"$CV_LOG" 2>&1
  su - postgres -c "psql -c 'CREATE DATABASE corpvideo OWNER corpvideo'" >>"$CV_LOG" 2>&1
  su - postgres -c "pg_restore -d corpvideo --no-owner --role=corpvideo" < "$DUMP" >>"$CV_LOG" 2>&1 || warn "pg_restore сообщил о предупреждениях (см. $CV_LOG)"
  if [ -n "$MEDIA_TAR" ] && [ -f "$MEDIA_TAR" ]; then info "Восстановление медиафайлов…"; tar -xf "$MEDIA_TAR" -C "$DATA_DIR"; chown -R corpvideo:corpvideo "$DATA_DIR/media"; fi
  systemctl start corpvideo-api corpvideo-worker
fi
ok "Восстановление завершено"
