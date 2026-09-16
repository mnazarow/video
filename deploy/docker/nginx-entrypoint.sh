#!/bin/bash
# Рендер конфигурации сайта из шаблона при старте контейнера nginx.
set -e
: "${SERVER_NAME:=_}"
: "${API_UPSTREAM:=api:3000}"
: "${MEDIAMTX_WEBRTC:=mediamtx:8889}"
: "${MEDIA_ROOT:=/data/media}"
: "${WEB_ROOT:=/usr/share/corpvideo/web}"
: "${SSL_MODE:=none}"
: "${SSL_CERT:=/etc/corpvideo/ssl/fullchain.pem}"
: "${SSL_KEY:=/etc/corpvideo/ssl/privkey.pem}"
: "${UPLOAD_CHUNK_LIMIT:=64m}"
export SERVER_NAME API_UPSTREAM MEDIAMTX_WEBRTC MEDIA_ROOT WEB_ROOT SSL_MODE SSL_CERT SSL_KEY UPLOAD_CHUNK_LIMIT
# HTTP/2: образ nginx:1.27 поддерживает директиву «http2 on;» (для nginx < 1.25.1 использовался бы параметр listen … http2)
NGX_MAJOR="$(nginx -v 2>&1 | sed -n 's/.*nginx\/\([0-9]*\)\.\([0-9]*\).*/\1\2/p')"
if [ "${NGX_MAJOR:-127}" -ge 125 ]; then LISTEN_HTTP2=""; HTTP2_DIRECTIVE="http2 on;"; else LISTEN_HTTP2=" http2"; HTTP2_DIRECTIVE=""; fi

render() {
  # Подстановка только известных переменных (nginx использует $var для своих нужд)
  sed -e "s|\${SERVER_NAME}|$SERVER_NAME|g" -e "s|\${API_UPSTREAM}|$API_UPSTREAM|g" -e "s|\${MEDIAMTX_WEBRTC}|$MEDIAMTX_WEBRTC|g" \
      -e "s|\${MEDIA_ROOT}|$MEDIA_ROOT|g" -e "s|\${WEB_ROOT}|$WEB_ROOT|g" -e "s|\${SSL_CERT}|$SSL_CERT|g" -e "s|\${SSL_KEY}|$SSL_KEY|g" \
      -e "s|\${UPLOAD_CHUNK_LIMIT}|$UPLOAD_CHUNK_LIMIT|g" -e "s|\${LISTEN_HTTP2}|$LISTEN_HTTP2|g" -e "s|\${HTTP2_DIRECTIVE}|$HTTP2_DIRECTIVE|g" "$1"
}

TEMPLATE=/etc/corpvideo/site.conf.template
OUT=/etc/nginx/conf.d/corpvideo.conf
rm -f /etc/nginx/conf.d/default.conf
render /etc/corpvideo/locations.conf.template > /etc/nginx/corpvideo-locations.conf
if [ "$SSL_MODE" != "none" ] && [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
  render "$TEMPLATE" | sed -e '/#--HTTP-ONLY-START--/,/#--HTTP-ONLY-END--/d' > "$OUT"
else
  # Без SSL: удаляем блок HTTPS и редирект
  render "$TEMPLATE" | sed -e '/#--HTTPS-START--/,/#--HTTPS-END--/d' -e '/#--REDIRECT-START--/,/#--REDIRECT-END--/d' > "$OUT"
fi
# Без IPv6 в системе убираем listen [::]
[ -f /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$OUT"
echo "nginx: конфигурация сгенерирована (SSL_MODE=$SSL_MODE, server_name=$SERVER_NAME)"
