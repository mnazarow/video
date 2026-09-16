#!/usr/bin/env bash
# =====================================================================================
#  CorpVideo — установка одной командой на чистый сервер Linux.
#
#  Примеры:
#    sudo ./install.sh                                  # интерактивно (Docker Compose)
#    sudo ./install.sh --mode native --domain video.corp.ru --ssl letsencrypt \
#         --email it@corp.ru --admin-email admin@corp.ru --admin-password 'Секрет123' --yes
#    curl -fsSL https://…/install.sh | sudo bash -s -- --repo https://git.corp.ru/corpvideo.git --yes
#
#  Параметры:
#    --mode docker|native      способ установки (по умолчанию docker)
#    --domain HOST             домен (или IP) портала
#    --ssl letsencrypt|selfsigned|none|custom   режим HTTPS (custom — свои сертификаты в DATA_DIR/ssl)
#    --email EMAIL             e-mail для Let's Encrypt
#    --admin-email EMAIL       администратор портала
#    --admin-password PASS     пароль администратора
#    --admin-name NAME         имя администратора
#    --allow-domain DOMAIN     разрешённый домен почты для регистрации (по умолчанию домен администратора)
#    --data-dir DIR            каталог данных (по умолчанию /var/lib/corpvideo)
#    --app-dir DIR             каталог приложения (по умолчанию /opt/corpvideo)
#    --http-port N / --https-port N   порты nginx (docker)
#    --mediamtx-version X.Y.Z  версия сервера трансляций
#    --repo URL | --source FILE.tar.gz   откуда взять исходники, если скрипт запущен не из папки проекта
#    --no-firewall             не открывать порты в ufw/firewalld
#    --yes                     без вопросов (значения по умолчанию / из параметров)
# =====================================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/lib/common.sh" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/scripts/lib/common.sh"
  SOURCE_DIR="$SCRIPT_DIR"
else
  SOURCE_DIR=""
fi

# --- Аргументы -------------------------------------------------------------------------
CV_MODE="${CV_MODE:-}"; CV_DOMAIN="${CV_DOMAIN:-}"; CV_SSL="${CV_SSL:-}"; CV_LE_EMAIL="${CV_LE_EMAIL:-}"
CV_ADMIN_EMAIL="${CV_ADMIN_EMAIL:-}"; CV_ADMIN_PASSWORD="${CV_ADMIN_PASSWORD:-}"; CV_ADMIN_NAME="${CV_ADMIN_NAME:-}"
CV_ALLOW_DOMAIN="${CV_ALLOW_DOMAIN:-}"; CV_YES="${CV_YES:-0}"; CV_REPO="${CV_REPO:-}"; CV_SOURCE="${CV_SOURCE:-}"
CV_HTTP_PORT="${CV_HTTP_PORT:-80}"; CV_HTTPS_PORT="${CV_HTTPS_PORT:-443}"; CV_NO_FIREWALL="${CV_NO_FIREWALL:-0}"; CV_MEDIAMTX_VERSION="${CV_MEDIAMTX_VERSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) CV_MODE="$2"; shift 2 ;;
    --domain) CV_DOMAIN="$2"; shift 2 ;;
    --ssl) CV_SSL="$2"; shift 2 ;;
    --email) CV_LE_EMAIL="$2"; shift 2 ;;
    --admin-email) CV_ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) CV_ADMIN_PASSWORD="$2"; shift 2 ;;
    --admin-name) CV_ADMIN_NAME="$2"; shift 2 ;;
    --allow-domain) CV_ALLOW_DOMAIN="$2"; shift 2 ;;
    --data-dir) CV_DATA_DIR="$2"; shift 2 ;;
    --app-dir) CV_APP_DIR="$2"; shift 2 ;;
    --http-port) CV_HTTP_PORT="$2"; shift 2 ;;
    --https-port) CV_HTTPS_PORT="$2"; shift 2 ;;
    --mediamtx-version) CV_MEDIAMTX_VERSION="$2"; shift 2 ;;
    --repo) CV_REPO="$2"; shift 2 ;;
    --source) CV_SOURCE="$2"; shift 2 ;;
    --no-firewall) CV_NO_FIREWALL=1; shift ;;
    --yes|-y) CV_YES=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

# --- Получение исходников, если запущено через curl | bash ----------------------------------
if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/server/package.json" ]; then
  TMP="$(mktemp -d)"
  if [ -n "$CV_SOURCE" ]; then
    echo "==> Распаковка $CV_SOURCE"; tar -xzf "$CV_SOURCE" -C "$TMP"
  elif [ -n "$CV_REPO" ]; then
    echo "==> Клонирование $CV_REPO"; command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; } ; git clone --depth 1 "$CV_REPO" "$TMP/src"
  else
    echo "Запустите install.sh из папки проекта CorpVideo либо укажите --repo <git-url> или --source <archive.tar.gz>" >&2; exit 2
  fi
  SOURCE_DIR="$(dirname "$(find "$TMP" -maxdepth 3 -name package.json -path '*server*' | head -1)")/.."
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  # shellcheck disable=SC1091
  . "$SOURCE_DIR/scripts/lib/common.sh"
fi
export SOURCE_DIR CV_MODE CV_DOMAIN CV_SSL CV_LE_EMAIL CV_ADMIN_EMAIL CV_ADMIN_PASSWORD CV_ADMIN_NAME CV_ALLOW_DOMAIN CV_YES CV_HTTP_PORT CV_HTTPS_PORT CV_NO_FIREWALL CV_MEDIAMTX_VERSION CV_APP_DIR CV_DATA_DIR

print_banner
require_root "$@"
detect_os
mkdir -p "$CV_LOG_DIR"; touch "$CV_LOG"
step "Проверка системы"
info "ОС: $OS_NAME ($OS_FAMILY, $ARCH)"
[ "$OS_FAMILY" != "unknown" ] || die "Поддерживаются Ubuntu/Debian и семейство RHEL (Rocky/Alma/CentOS/Fedora)"
CV_VERSION="$(cat "$SOURCE_DIR/VERSION" 2>/dev/null || echo 1.0.0)"
info "Версия CorpVideo: $CV_VERSION, исходники: $SOURCE_DIR"
check_distribution "$SOURCE_DIR"
if [ -f "$CV_CONF" ]; then
  load_conf
  warn "Обнаружена существующая установка ($MODE, $(env_get "$CV_CONF" INSTALLED_AT))."
  confirm "Продолжить? Существующие данные сохранятся, приложение будет обновлено." || exit 0
  CV_MODE="${CV_MODE:-$MODE}"; CV_DOMAIN="${CV_DOMAIN:-$DOMAIN}"; CV_SSL="${CV_SSL:-$SSL_MODE}"
fi
free_mb=$(df -Pm "${CV_DATA_DIR%/*}" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)
[ "${free_mb:-0}" -ge 5000 ] || warn "Свободно менее 5 ГБ на диске — для видео потребуется больше места"
mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$mem_mb" -ge 1800 ] || warn "Оперативной памяти меньше 2 ГБ — транскодирование будет медленным"

# --- Режим установки и параметры --------------------------------------------------------------
if [ -z "$CV_MODE" ]; then
  if [ "$CV_YES" = "1" ]; then CV_MODE=docker; else
    echo; echo "Способ установки:"; echo "  1) Docker Compose — рекомендуется (любой дистрибутив, изоляция, простое обновление)"; echo "  2) Нативно — nginx, PostgreSQL, Node.js и systemd на этом сервере (Ubuntu/Debian)"
    read -r -p "Выберите [1]: " m; CV_MODE=$([ "${m:-1}" = "2" ] && echo native || echo docker)
  fi
fi
[[ "$CV_MODE" =~ ^(docker|native)$ ]] || die "--mode должен быть docker или native"
if [ "$CV_MODE" = "native" ] && [ "$OS_FAMILY" != "debian" ]; then die "Нативная установка поддерживается на Ubuntu/Debian. Для $OS_NAME используйте --mode docker"; fi

default_domain="$(hostname -f 2>/dev/null || hostname)"
ask CV_DOMAIN "Домен или IP-адрес портала" "$default_domain"
CV_DOMAIN="${CV_DOMAIN,,}"
is_ip=0; [[ "$CV_DOMAIN" =~ ^[0-9.]+$ ]] && is_ip=1
if [ -z "$CV_SSL" ]; then
  if [ "$is_ip" = "1" ] || [[ "$CV_DOMAIN" != *.* ]]; then CV_SSL=selfsigned; else CV_SSL=letsencrypt; fi
  if [ "$CV_YES" != "1" ]; then
    echo; echo "HTTPS:"; echo "  1) letsencrypt — бесплатный сертификат (нужен публичный DNS и открытые порты 80/443)"; echo "  2) selfsigned  — самоподписанный сертификат (закрытая сеть; браузер покажет предупреждение)"; echo "  3) none        — только HTTP (за внешним обратным прокси или для тестов)"; echo "  4) custom      — свои сертификаты (положить fullchain.pem и privkey.pem в $CV_DATA_DIR/ssl)"
    def=$([ "$CV_SSL" = letsencrypt ] && echo 1 || echo 2)
    read -r -p "Выберите [$def]: " s; case "${s:-$def}" in 1) CV_SSL=letsencrypt ;; 2) CV_SSL=selfsigned ;; 3) CV_SSL=none ;; 4) CV_SSL=custom ;; esac
  fi
fi
[[ "$CV_SSL" =~ ^(letsencrypt|selfsigned|none|custom)$ ]] || die "--ssl: letsencrypt | selfsigned | none | custom"
if [ "$CV_SSL" = "letsencrypt" ]; then
  [ "$is_ip" = "0" ] || die "Let's Encrypt не выдаёт сертификаты на IP-адрес — используйте --ssl selfsigned"
  ask CV_LE_EMAIL "E-mail для уведомлений Let's Encrypt" "admin@${CV_DOMAIN#*.}"
fi
ask CV_ADMIN_EMAIL "E-mail администратора портала" "admin@$([ "$is_ip" = "1" ] && echo example.com || echo "${CV_DOMAIN#*.}")"
ask_secret CV_ADMIN_PASSWORD "Пароль администратора (не короче 8 символов)"
ask CV_ADMIN_NAME "Имя администратора" "Администратор"
ask CV_ALLOW_DOMAIN "Разрешённый домен почты для регистрации сотрудников" "${CV_ADMIN_EMAIL#*@}"
[ -n "$CV_MEDIAMTX_VERSION" ] || CV_MEDIAMTX_VERSION="$(mediamtx_latest_version)"
if [ "$CV_SSL" = "none" ]; then
  CV_BASE_URL="http://$CV_DOMAIN"; [ "$CV_HTTP_PORT" = 80 ] || CV_BASE_URL="$CV_BASE_URL:$CV_HTTP_PORT"
else
  CV_BASE_URL="https://$CV_DOMAIN"; [ "$CV_HTTPS_PORT" = 443 ] || CV_BASE_URL="$CV_BASE_URL:$CV_HTTPS_PORT"
fi
export CV_BASE_URL CV_VERSION is_ip

echo
info "Режим: $CV_MODE • Домен: $CV_DOMAIN • HTTPS: $CV_SSL • Адрес: $CV_BASE_URL"
info "Администратор: $CV_ADMIN_EMAIL • Разрешённый домен: @$CV_ALLOW_DOMAIN • Данные: $CV_DATA_DIR"
[ "$CV_YES" = "1" ] || { confirm "Начать установку?" || exit 0; }

# --- Установка ---------------------------------------------------------------------------------
save_conf MODE "$CV_MODE"; save_conf APP_DIR "$CV_APP_DIR"; save_conf DATA_DIR "$CV_DATA_DIR"; save_conf DOMAIN "$CV_DOMAIN"
save_conf SSL_MODE "$CV_SSL"; save_conf BASE_URL "$CV_BASE_URL"; save_conf VERSION "$CV_VERSION"; save_conf INSTALLED_AT "$(date -Is)"; save_conf LE_EMAIL "$CV_LE_EMAIL"
# shellcheck disable=SC1091
. "$SOURCE_DIR/scripts/install-$CV_MODE.sh"
install_"$CV_MODE"

# --- Утилита командной строки -------------------------------------------------------------------
install -m 755 "$SOURCE_DIR/scripts/corpvideo-cli.sh" /usr/local/bin/corpvideo
ok "Установлена утилита: corpvideo (status | logs | restart | update | backup | cli …)"
[ "$CV_NO_FIREWALL" = "1" ] || open_firewall

# --- Итог ----------------------------------------------------------------------------------------
echo
echo "${C_GREEN}${C_BOLD}Установка завершена!${C_RESET}"
echo
echo "  Портал:            ${C_BOLD}$CV_BASE_URL${C_RESET}"
echo "  Администратор:     $CV_ADMIN_EMAIL"
echo "  Панель управления: $CV_BASE_URL/admin"
echo "  Разрешённый домен: @$CV_ALLOW_DOMAIN (изменяется в панели: Домены и приглашения)"
echo "  Трансляции (OBS):  rtmp://$CV_DOMAIN:1935/live  + ключ из студии"
echo "  Каталог данных:    $CV_DATA_DIR    Конфигурация: $CV_CONF_DIR"
echo "  Управление:        corpvideo status | corpvideo logs | corpvideo update | corpvideo backup"
[ "$CV_SSL" = "selfsigned" ] && echo "  ${C_YELLOW}Сертификат самоподписанный — при первом входе подтвердите исключение в браузере.${C_RESET}"
[ "$CV_SSL" = "none" ] && echo "  ${C_YELLOW}HTTPS выключен: эфир из браузера (WebRTC) и часть функций плеера требуют HTTPS.${C_RESET}"
echo
echo "  Следующие шаги: войдите под администратором → Настройки → Почта (SMTP), LDAP, автосубтитры; проверьте домены регистрации."
echo
