#!/usr/bin/env bash
# CorpVideo — общие функции для скриптов установки/обновления/удаления.
# shellcheck disable=SC2034

set -Eeuo pipefail

CV_NAME="CorpVideo"
CV_APP_DIR="${CV_APP_DIR:-/opt/corpvideo}"
CV_DATA_DIR="${CV_DATA_DIR:-/var/lib/corpvideo}"
CV_CONF_DIR="/etc/corpvideo"
CV_CONF="$CV_CONF_DIR/install.conf"
CV_ENV="$CV_CONF_DIR/corpvideo.env"
CV_LOG_DIR="/var/log/corpvideo"
CV_LOG="$CV_LOG_DIR/install.log"
CV_USER="corpvideo"
CV_MEDIAMTX_DEFAULT="1.9.3"
CV_NODE_MAJOR=22

# --- Вывод ---------------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

_log_file() { if [ -d "$CV_LOG_DIR" ] || mkdir -p "$CV_LOG_DIR" 2>/dev/null; then printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$CV_LOG" 2>/dev/null || true; fi; }
step()  { echo; echo "${C_BOLD}${C_BLUE}==> $*${C_RESET}"; _log_file "STEP $*"; }
info()  { echo "${C_CYAN}   • $*${C_RESET}"; _log_file "INFO $*"; }
ok()    { echo "${C_GREEN}   ✔ $*${C_RESET}"; _log_file "OK $*"; }
warn()  { echo "${C_YELLOW}   ! $*${C_RESET}" >&2; _log_file "WARN $*"; }
die()   { echo; echo "${C_RED}${C_BOLD}ОШИБКА: $*${C_RESET}" >&2; _log_file "ERROR $*"; echo "${C_DIM}Подробности: $CV_LOG${C_RESET}" >&2; exit 1; }

on_error() {
  local code=$? line=${BASH_LINENO[0]} cmd=${BASH_COMMAND}
  echo >&2
  echo "${C_RED}${C_BOLD}Сбой на строке $line: $cmd (код $code)${C_RESET}" >&2
  _log_file "TRAP line=$line code=$code cmd=$cmd"
  if type -t cv_rollback >/dev/null 2>&1; then
    warn "Выполняется откат…"
    cv_rollback || true
  fi
  echo "${C_DIM}Журнал: $CV_LOG${C_RESET}" >&2
  exit "$code"
}
trap on_error ERR

# --- Проверки окружения -------------------------------------------------------------------
require_root() { [ "$(id -u)" -eq 0 ] || die "Запустите скрипт от root: sudo $0 $*"; }

detect_os() {
  [ -f /etc/os-release ] || die "Не удалось определить операционную систему (нет /etc/os-release)"
  # os-release читаем в подоболочке: он задаёт VERSION/NAME и затирал бы наши переменные
  # shellcheck disable=SC1091
  eval "$(. /etc/os-release; printf 'OS_ID=%q; OS_VERSION=%q; OS_LIKE=%q; OS_NAME=%q\n' "${ID:-unknown}" "${VERSION_ID:-}" "${ID_LIKE:-}" "${PRETTY_NAME:-${ID:-unknown}}")"
  case "$OS_ID $OS_LIKE" in
    *debian*|*ubuntu*) OS_FAMILY=debian ;;
    *rhel*|*fedora*|*centos*|*rocky*|*alma*) OS_FAMILY=rhel ;;
    *) OS_FAMILY=unknown ;;
  esac
  ARCH="$(uname -m)"
  case "$ARCH" in x86_64|amd64) ARCH_DL=amd64 ;; aarch64|arm64) ARCH_DL=arm64 ;; *) ARCH_DL="$ARCH" ;; esac
}

has_cmd() { command -v "$1" >/dev/null 2>&1; }

pkg_update() {
  case "$OS_FAMILY" in
    debian) DEBIAN_FRONTEND=noninteractive apt-get update -qq >>"$CV_LOG" 2>&1 || warn "apt-get update завершился с ошибкой (продолжаем)" ;;
    rhel) (dnf -q makecache >>"$CV_LOG" 2>&1 || yum -q makecache >>"$CV_LOG" 2>&1) || true ;;
  esac
}
pkg_install() {
  info "Установка пакетов: $*"
  case "$OS_FAMILY" in
    debian) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >>"$CV_LOG" 2>&1 || die "Не удалось установить пакеты: $*" ;;
    rhel) if has_cmd dnf; then dnf install -y -q "$@" >>"$CV_LOG" 2>&1 || die "Не удалось установить пакеты: $*"; else yum install -y -q "$@" >>"$CV_LOG" 2>&1 || die "Не удалось установить пакеты: $*"; fi ;;
    *) die "Неподдерживаемая ОС: $OS_NAME" ;;
  esac
}

# --- Утилиты --------------------------------------------------------------------------------
# Случайная строка [A-Za-z0-9] длиной N (без SIGPIPE — важно при set -o pipefail)
random_secret() {
  local n="${1:-48}" s=""
  while [ ${#s} -lt "$n" ]; do s+="$(head -c 96 /dev/urandom | base64 | LC_ALL=C tr -dc 'A-Za-z0-9')"; done
  echo "${s:0:$n}"
}
random_password() { random_secret 20; }

# Подстановка ${VAR} для перечисленных переменных (безопасно для nginx с его $var)
render_template() {
  local src="$1" dst="$2"; shift 2
  local -a args=()
  local v val
  for v in "$@"; do
    val="${!v:-}"
    val="${val//\\/\\\\}"; val="${val//|/\\|}"; val="${val//&/\\&}"
    args+=(-e "s|\${$v}|$val|g")
  done
  sed "${args[@]}" "$src" > "$dst"
}

ask() { # ask VAR "Вопрос" "значение по умолчанию"
  local var="$1" prompt="$2" def="${3:-}"
  local cur="${!var:-}"
  if [ -n "$cur" ]; then return 0; fi
  if [ "${CV_YES:-0}" = "1" ]; then printf -v "$var" '%s' "$def"; return 0; fi
  local ans
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " ans; else read -r -p "$prompt: " ans; fi
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() {
  local var="$1" prompt="$2"
  local cur="${!var:-}"
  if [ -n "$cur" ]; then return 0; fi
  if [ "${CV_YES:-0}" = "1" ]; then printf -v "$var" '%s' "$(random_password)"; return 0; fi
  local a b
  while :; do
    read -r -s -p "$prompt: " a; echo
    read -r -s -p "Повторите: " b; echo
    [ "$a" = "$b" ] || { warn "Пароли не совпадают"; continue; }
    [ ${#a} -ge 8 ] || { warn "Не короче 8 символов"; continue; }
    break
  done
  printf -v "$var" '%s' "$a"
}
confirm() { # confirm "Вопрос" → 0/1
  if [ "${CV_YES:-0}" = "1" ]; then return 0; fi
  local ans; read -r -p "$1 [y/N]: " ans
  [[ "$ans" =~ ^[YyДд] ]]
}

wait_for_http() { # wait_for_http URL timeout_sec
  local url="$1" t="${2:-60}" i=0
  while [ $i -lt "$t" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

port_in_use() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"; }

save_conf() { # save_conf KEY VALUE
  mkdir -p "$CV_CONF_DIR"; touch "$CV_CONF"; chmod 600 "$CV_CONF"
  if grep -q "^$1=" "$CV_CONF" 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" "$CV_CONF"; else echo "$1=$2" >> "$CV_CONF"; fi
}
load_conf() { [ -f "$CV_CONF" ] && { # shellcheck disable=SC1090
  . "$CV_CONF"; } || true; }

env_get() { # env_get FILE KEY → значение (без кавычек); всегда код 0
  local v
  v="$(awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$1" 2>/dev/null)" || true
  v="${v#\"}"; v="${v%\"}"; printf '%s\n' "$v"
}
env_set() { # env_set FILE KEY VALUE
  local f="$1" k="$2" v="$3" esc
  touch "$f"
  esc="${v//\\/\\\\}"; esc="${esc//|/\\|}"; esc="${esc//&/\\&}"
  if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$esc|" "$f"; else echo "$k=$v" >> "$f"; fi
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

open_firewall() {
  if has_cmd ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    info "Открываем порты в ufw"
    for p in 80/tcp 443/tcp 1935/tcp 8890/udp 8189/udp 8189/tcp; do ufw allow "$p" >>"$CV_LOG" 2>&1 || true; done
  elif has_cmd firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    info "Открываем порты в firewalld"
    for p in 80/tcp 443/tcp 1935/tcp 8890/udp 8189/udp 8189/tcp; do firewall-cmd -q --permanent --add-port="$p" >>"$CV_LOG" 2>&1 || true; done
    firewall-cmd -q --reload >>"$CV_LOG" 2>&1 || true
  fi
}

mediamtx_latest_version() {
  local v
  v="$(curl -fsS --max-time 8 https://api.github.com/repos/bluenviron/mediamtx/releases/latest 2>/dev/null | grep -oE '"tag_name":\s*"v[0-9.]+"' | grep -oE '[0-9.]+' | head -1 || true)"
  echo "${v:-$CV_MEDIAMTX_DEFAULT}"
}

print_banner() {
  echo "${C_BOLD}${C_BLUE}"
  cat <<'EOF'
   ____                __     ___     _
  / ___|___  _ __ _ __ \ \   / (_) __| | ___  ___
 | |   / _ \| '__| '_ \ \ \ / /| |/ _` |/ _ \/ _ \
 | |__| (_) | |  | |_) | \ V / | | (_| |  __/ (_) |
  \____\___/|_|  | .__/   \_/  |_|\__,_|\___|\___/
                 |_|      корпоративный видеохостинг
EOF
  echo "${C_RESET}"
}

self_dir() { cd "$(dirname "${BASH_SOURCE[1]}")" && pwd; }
