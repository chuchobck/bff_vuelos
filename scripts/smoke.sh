#!/usr/bin/env bash
# Smoke del BFF contra un despliegue (o contra uno local):
#
#   scripts/smoke.sh <BASE_URL>            # p. ej. http://localhost:4000
#   SMOKE_ORIGIN=https://app.example.com scripts/smoke.sh <BASE_URL>   # además comprueba CORS
#
# Solo necesita curl. Las comprobaciones que no dependen del core corren siempre; las que sí
# (estado de un vuelo inexistente, una búsqueda) solo si /health/ready responde 200. Sale con 1
# si falla alguna. La primera llamada a un servicio gratuito de Render puede tardar medio minuto
# en despertarlo (y al core, otro tanto): por eso los plazos son largos.
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "uso: scripts/smoke.sh <BASE_URL>" >&2
  exit 2
fi
BASE="${BASE%/}"
FALLOS=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()    { printf '  ok     %s\n' "$1"; }
fallo() { printf '  FALLA  %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
info()  { printf '  info   %s\n' "$1"; }
titulo() { printf '\n%s\n' "$1"; }

# curl con plazo largo; deja el cuerpo en $TMP/cuerpo, las cabeceras en $TMP/cabeceras y
# el estado HTTP en $ESTADO
pedir() {
  ESTADO="$(curl -sS --max-time 90 -o "$TMP/cuerpo" -D "$TMP/cabeceras" -w '%{http_code}' "$@" 2>"$TMP/error")" || ESTADO="000"
}
cuerpo()    { cat "$TMP/cuerpo"; }
cabecera()  { grep -i "^$1:" "$TMP/cabeceras" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# POST /graphql con JSON; los argumentos extra van a curl (-H ...)
graphql() {
  local consulta="$1"; shift
  pedir -X POST "$BASE/graphql" -H 'content-type: application/json' "$@" --data "$consulta"
}

FECHA="$( (date -d '+7 days' +%F 2>/dev/null) || (date -v+7d +%F 2>/dev/null) || echo 2026-12-01 )"
HUELLA="smoke-$(date +%s)-huella"

titulo "Salud ($BASE)"
pedir "$BASE/health"
if [ "$ESTADO" = "200" ] && cuerpo | grep -q '"status":"UP"'; then ok "GET /health 200 UP"; else fallo "GET /health: HTTP $ESTADO"; fi

pedir "$BASE/health/ready"
LISTO=0
if [ "$ESTADO" = "200" ]; then LISTO=1; ok "GET /health/ready 200: el core responde"
elif [ "$ESTADO" = "503" ]; then info "GET /health/ready 503: el core no responde (se omiten las comprobaciones con core)"
else fallo "GET /health/ready: HTTP $ESTADO (se esperaba 200 o 503)"; fi

titulo "GraphQL sin el core"
graphql '{"query":"{ __typename }"}' -H 'x-request-id: smoke-traza-0001'
if [ "$ESTADO" = "200" ] && cuerpo | grep -q '"__typename":"Query"'; then ok "{ __typename } responde Query"; else fallo "{ __typename }: HTTP $ESTADO"; fi
if [ "$(cabecera x-request-id)" = "smoke-traza-0001" ]; then ok "X-Request-Id del cliente vuelve en la respuesta"; else fallo "X-Request-Id no vuelve ('$(cabecera x-request-id)')"; fi

graphql '{"query":"{ __typename }"}' -H 'x-request-id: mal id con espacios'
if cabecera x-request-id | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then ok "un X-Request-Id inválido se cambia por un UUID"; else fallo "X-Request-Id inválido no se reemplazó por un UUID"; fi

BUSQUEDA="{ searchFlights(input: { itineraries: [{ origin: \\\"UIO\\\", destination: \\\"GYE\\\", departureDate: \\\"$FECHA\\\" }], passengers: { adults: 1 } }) { totalOffers offers { offerId } } }"
graphql "{\"query\":\"$BUSQUEDA\"}"
if cuerpo | grep -q '"code":"BAD_USER_INPUT"' && cuerpo | grep -q '"requestId"'; then ok "searchFlights sin X-Device-Fingerprint: BAD_USER_INPUT con requestId"; else fallo "searchFlights sin huella no dio BAD_USER_INPUT: $(cuerpo | head -c 200)"; fi

graphql '{"query":"{ nada }"}'
if [ "$ESTADO" = "400" ] && cuerpo | grep -q 'GRAPHQL_VALIDATION_FAILED' && cuerpo | grep -q '"requestId"'; then ok "una consulta inválida: 400 GRAPHQL_VALIDATION_FAILED con requestId"; else fallo "consulta inválida: HTTP $ESTADO"; fi

graphql '[{"query":"{ __typename }"},{"query":"{ __typename }"}]'
if [ "$ESTADO" = "400" ]; then ok "un lote de operaciones se rechaza (400)"; else fallo "un lote debía dar 400 y dio $ESTADO"; fi

graphql '{"query":"{ __schema { queryType { name } } }"}'
if cuerpo | grep -q '"queryType"'; then info "introspección: ENCENDIDA (esperado fuera de production)"; else info "introspección: apagada (esperado en production)"; fi

if [ -n "${SMOKE_ORIGIN:-}" ]; then
  titulo "CORS ($SMOKE_ORIGIN)"
  pedir -X OPTIONS "$BASE/graphql" -H "Origin: $SMOKE_ORIGIN" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type,x-device-fingerprint,x-request-id'
  if [ "$(cabecera access-control-allow-origin)" = "$SMOKE_ORIGIN" ]; then ok "el preflight permite el origen"; else fallo "el preflight no permite $SMOKE_ORIGIN"; fi
fi

if [ "$LISTO" = "1" ]; then
  titulo "GraphQL con el core"
  graphql '{"query":"{ flightStatus(flightNumber: \"ZZ9999\", date: \"'"$FECHA"'\") { status } }"}'
  if cuerpo | grep -q '"code":"NOT_FOUND"'; then ok "flightStatus de un vuelo inexistente: NOT_FOUND"; else fallo "flightStatus ZZ9999: $(cuerpo | head -c 200)"; fi

  graphql "{\"query\":\"$BUSQUEDA\"}" -H "x-device-fingerprint: $HUELLA"
  if [ "$ESTADO" = "200" ] && cuerpo | grep -Eq '"totalOffers":[0-9]+' && ! cuerpo | grep -q '"errors"'; then
    ok "searchFlights UIO-GYE $FECHA: $(cuerpo | grep -Eo '"totalOffers":[0-9]+')"
  else
    fallo "searchFlights: HTTP $ESTADO $(cuerpo | head -c 200)"
  fi
fi

echo
if [ "$FALLOS" -eq 0 ]; then echo "Smoke OK"; else echo "Smoke con $FALLOS fallo(s)"; exit 1; fi
