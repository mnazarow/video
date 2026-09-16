#!/usr/bin/env bash
# =====================================================================================
#  CorpVideo — резервное копирование.
#    sudo ./backup.sh                      # база данных + конфигурация → DATA_DIR/backups/<дата>/
#    sudo ./backup.sh --media              # плюс архив всех медиафайлов (может быть очень большим)
#    sudo ./backup.sh --dest /mnt/backup   # другой каталог назначения
#    sudo ./backup.sh --keep 14            # хранить не более 14 последних копий
#  Для регулярного копирования: crontab → 0 3 * * * /usr/local/bin/corpvideo backup --keep 14
# =====================================================================================
set -Eeuo pipefail
# Дамп базы и .env содержат пароли — создаём всё доступным только root
umask 077
CONF=/etc/corpvideo/install.conf
[ -f "$CONF" ] || { echo "CorpVideo не установлен" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
# shellcheck disable=SC1090
. "$APP_DIR/scripts/lib/common.sh"
require_root "$@"
MEDIA=0; DEST="$DATA_DIR/backups"; KEEP=0
while [ $# -gt 0 ]; do case "$1" in --media) MEDIA=1; shift ;; --dest) DEST="$2"; shift 2 ;; --keep) KEEP="$2"; shift 2 ;; *) echo "Неизвестный параметр: $1" >&2; exit 2 ;; esac; done
STAMP="$(date +%Y%m%d-%H%M%S)"; OUT="$DEST/$STAMP"; mkdir -p "$OUT"; chmod 700 "$OUT"
step "Резервная копия → $OUT"
dump_failed() { rm -rf "$OUT"; echo "Не удалось сделать дамп базы — копия не создана" >&2; exit 1; }
if [ "$MODE" = "docker" ]; then (cd "$APP_DIR" && docker compose exec -T db pg_dump -U corpvideo -Fc corpvideo > "$OUT/db.dump") || dump_failed
else su - postgres -c "pg_dump -Fc corpvideo" > "$OUT/db.dump" || dump_failed; fi
chmod 600 "$OUT/db.dump"
[ -s "$OUT/db.dump" ] || dump_failed
ok "База данных: $(du -h "$OUT/db.dump" | cut -f1)"
cp -f "$CV_ENV" "$OUT/corpvideo.env"; cp -f "$CONF" "$OUT/install.conf"; chmod 600 "$OUT"/*.env "$OUT"/*.conf
[ -f "$APP_DIR/deploy/mediamtx/mediamtx.yml" ] && cp -f "$APP_DIR/deploy/mediamtx/mediamtx.yml" "$OUT/" || true
[ -f /etc/corpvideo/mediamtx.yml ] && cp -f /etc/corpvideo/mediamtx.yml "$OUT/" || true
ok "Конфигурация сохранена"
if [ "$MEDIA" = "1" ]; then
  info "Архивирование медиафайлов ($(du -sh "$DATA_DIR/media" 2>/dev/null | cut -f1))…"
  tar -cf "$OUT/media.tar" -C "$DATA_DIR" media
  chmod 600 "$OUT/media.tar"
  ok "Медиа: $(du -h "$OUT/media.tar" | cut -f1)"
else
  info "Медиафайлы не включены (добавьте --media); каталог $DATA_DIR/media можно копировать rsync'ом отдельно"
fi
if [ "$KEEP" -gt 0 ] 2>/dev/null; then
  # Каталоги копий и дампы pre-update-*.dump чистим ОТДЕЛЬНО: в общем списке имена сортируются
  # так, что первыми под нож попадали именно полноценные копии, а не дампы перед обновлением.
  prune_list() { sort | head -n -"$KEEP" | while read -r old; do [ -n "$old" ] || continue; rm -rf "$old"; info "Удалена старая копия $old"; done; }
  { ls -1d "$DEST"/20*/ 2>/dev/null || true; } | prune_list
  { ls -1 "$DEST"/pre-update-*.dump 2>/dev/null || true; } | prune_list
fi
echo "${C_GREEN}${C_BOLD}Готово: $OUT${C_RESET}"
