#!/usr/bin/env bash
# CorpVideo — утилита управления (устанавливается как /usr/local/bin/corpvideo).
set -Eeuo pipefail
CONF=/etc/corpvideo/install.conf
usage() {
  cat <<'EOF'
Использование: corpvideo <команда> [параметры]
  status              состояние служб, версия, место на диске
  logs [служба]       журналы (api | worker | mediamtx | nginx | db), Ctrl+C — выход
  restart|stop|start  управление службами
  update [...]        обновление (см. update.sh --help)
  backup [...]        резервная копия (см. backup.sh --help)
  restore <путь>      восстановление из копии
  uninstall [...]     удаление
  cli <команда>       консольные команды приложения: create-admin, set-password, add-domain, settings, status, …
  shell               оболочка в контейнере api (docker) / переход в каталог приложения
  ports               какие порты должны быть открыты
  version             версия
EOF
}
[ -f "$CONF" ] || { echo "CorpVideo не установлен (нет $CONF)" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
cmd="${1:-status}"; shift || true
dc() { (cd "$APP_DIR" && docker compose "$@"); }
case "$cmd" in
  status)
    echo "CorpVideo $VERSION ($MODE) — $BASE_URL"
    if [ "$MODE" = "docker" ]; then dc ps; else systemctl --no-pager --lines=0 status corpvideo-api corpvideo-worker corpvideo-mediamtx nginx postgresql 2>/dev/null | grep -E "●|Active:" || true; fi
    echo; df -h "$DATA_DIR" | tail -1 | awk '{print "Диск " $6 ": занято " $3 " из " $2 " (" $5 ")"}'
    echo "Медиа: $(du -sh "$DATA_DIR/media" 2>/dev/null | cut -f1 || echo '?')"
    if [ "$MODE" = "docker" ]; then dc exec -T api node server/src/cli.js status 2>/dev/null || true; else (cd "$APP_DIR/server" && sudo -u corpvideo ENV_FILE=/etc/corpvideo/corpvideo.env node src/cli.js status) 2>/dev/null || true; fi ;;
  logs)
    svc="${1:-api}"
    if [ "$MODE" = "docker" ]; then dc logs -f --tail=200 "$svc"; else
      case "$svc" in nginx) tail -f /var/log/nginx/access.log /var/log/nginx/error.log ;; db) journalctl -fu postgresql ;; *) tail -f "/var/log/corpvideo/$svc.log" ;; esac; fi ;;
  restart) if [ "$MODE" = "docker" ]; then dc restart "$@"; else systemctl restart corpvideo-api corpvideo-worker corpvideo-mediamtx 2>/dev/null; systemctl reload nginx; fi; echo "OK" ;;
  stop) if [ "$MODE" = "docker" ]; then dc stop "$@"; else systemctl stop corpvideo-api corpvideo-worker corpvideo-mediamtx 2>/dev/null; fi; echo "OK" ;;
  start) if [ "$MODE" = "docker" ]; then dc start "$@"; else systemctl start corpvideo-api corpvideo-worker corpvideo-mediamtx 2>/dev/null; fi; echo "OK" ;;
  update) exec "$APP_DIR/update.sh" "$@" ;;
  backup) exec "$APP_DIR/backup.sh" "$@" ;;
  restore) exec "$APP_DIR/restore.sh" "$@" ;;
  uninstall) exec "$APP_DIR/uninstall.sh" "$@" ;;
  cli) if [ "$MODE" = "docker" ]; then dc exec -T api node server/src/cli.js "$@"; else (cd "$APP_DIR/server" && sudo -u corpvideo ENV_FILE=/etc/corpvideo/corpvideo.env node src/cli.js "$@"); fi ;;
  shell) if [ "$MODE" = "docker" ]; then dc exec api bash; else cd "$APP_DIR" && exec bash; fi ;;
  ports) echo "80/tcp, 443/tcp — веб; 1935/tcp — RTMP (OBS); 8890/udp — SRT; 8189/udp+tcp — WebRTC (эфир из браузера)" ;;
  version) echo "$VERSION" ;;
  -h|--help|help) usage ;;
  *) echo "Неизвестная команда: $cmd"; usage; exit 2 ;;
esac
