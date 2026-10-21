# Verificación local contra el core real

Esta fase se probó con un core **falso** (un servidor gRPC construido desde el mismo proto y un
servidor HTTP con las rutas REST) porque en el entorno donde se escribió no se pudo levantar el core
con su base de datos. Esta guía es para correrlo tú, contra el core de verdad, por gRPC y por REST,
y comprobar que las dos dan lo mismo.

Los comandos son de bash (Linux, macOS, Git Bash o WSL). En PowerShell, en lugar de
`VARIABLE=valor comando` usa `$env:VARIABLE='valor'; comando`.

## 1. El core (terminal 1)

Necesitas Node 20.19 o superior, Docker con Compose y Git.

```bash
git clone https://github.com/chuchobck/backend_vuelos.git
cd backend_vuelos
git checkout feat/r2-grpc      # mientras R2-1 no esté en main; después, main
npm ci
cp .env.example .env
```

Edita `.env`: pon `JWT_SECRET` y `WEBHOOK_SECRET_KEY` (32 caracteres o más y distintas; genera cada
una con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) y
**`GRPC_ENABLED=true`**. Luego:

```bash
docker compose up -d           # PostgreSQL 18 en :5432
./db/reset.sh                  # esquemas y semilla (90 días desde hoy)
npm run start:dev              # HTTP en :3000 y gRPC en :50051
```

En el log del core debe aparecer `[gRPC] Activo en 0.0.0.0:50051 (quinde.flights.v1.FlightsService)`.
Comprueba el HTTP: `curl localhost:3000/flights/v1/health` → `200`.

## 2. El BFF con gRPC (terminal 2)

```bash
git clone https://github.com/chuchobck/bff_vuelos.git
cd bff_vuelos
git checkout feat/r2-bff       # mientras no esté en main
nvm use                        # Node >= 20.19 (.nvmrc)
npm ci
npm run build
NODE_ENV=development CORE_TRANSPORT=grpc CORE_GRPC_URL=localhost:50051 PORT=4000 \
  node dist/main.js
```

Debe imprimir `Escuchando en el puerto 4000 (core por grpc)`. Comprueba:

```bash
curl -s localhost:4000/health          # {"status":"UP"}
curl -s localhost:4000/health/ready    # {"status":"UP","core":{"transport":"grpc","status":"UP"}}
```

Si `/health/ready` da 503, el BFF no llega al gRPC del core: revisa `GRPC_ENABLED=true` y el puerto.

## 3. Las tres consultas

```bash
BFF=http://localhost:4000
FECHA=$(date -d '+7 days' +%F)         # en macOS: date -v+7d +%F
HUELLA=verificacion-local-0001
gql() { curl -s -D /dev/stderr "$BFF/graphql" -H 'content-type: application/json' "$@"; }
```

### 3.1 `searchFlights`

```bash
gql -H "x-device-fingerprint: $HUELLA" -H 'x-request-id: verif-busqueda-0001' -d '{
  "query": "{ searchFlights(input: { itineraries: [{ origin: \"UIO\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { totalOffers offers { offerId grandTotal { currency total } itineraries { segments { segmentId flightNumber status departure { iataCode at } } } } } }"
}' | tee /tmp/busqueda.json
```

**Esperado:** HTTP 200 y cabecera `X-Request-Id: verif-busqueda-0001`; `data.searchFlights.totalOffers`
es un número (≥ 1 si hay salidas UIO→GYE ese día; si es 0, prueba otra fecha); cada oferta trae un
`offerId` uuid, `grandTotal.total` como **texto** (`"73.92"`, entre comillas), segmentos con
`flightNumber` y `status` en inglés sin prefijo (`SCHEDULED`) o `null`. No hay `errors`. En la
terminal del core, una línea de acceso con ese id:
`[gRPC] [verif-busqueda-0001] /quinde.flights.v1.FlightsService/SearchFlights OK`.

### 3.2 `seatMap`

Toma un `offerId` y un `segmentId` de la respuesta anterior (con `jq`, si lo tienes):

```bash
OFERTA=$(jq -r '.data.searchFlights.offers[0].offerId' /tmp/busqueda.json)
SEGMENTO=$(jq -r '.data.searchFlights.offers[0].itineraries[0].segments[0].segmentId' /tmp/busqueda.json)
gql -d '{
  "query": "{ seatMap(offerId: \"'"$OFERTA"'\", segmentId: \"'"$SEGMENTO"'\") { segmentId cabins { cabinClass rows { rowNumber seats { seatNumber isAvailable characteristics } } } } }"
}'
```

**Esperado:** HTTP 200; `segmentId` igual al pedido; `cabins` con `cabinClass` (`ECONOMY`...), filas
con asientos `12A`, `isAvailable` booleano y `characteristics` (`WINDOW`, `AISLE`... o `[]`). El core
registra `GetSeatMap OK`.

### 3.3 `flightStatus`

```bash
VUELO=$(jq -r '.data.searchFlights.offers[0].itineraries[0].segments[0].flightNumber' /tmp/busqueda.json)
gql -d '{
  "query": "{ flightStatus(flightNumber: \"'"$VUELO"'\", date: \"'"$FECHA"'\") { flightNumber date status aircraft departure { iataCode terminal scheduledAt estimatedAt actualAt } arrival { iataCode scheduledAt } } }"
}'
```

**Esperado:** HTTP 200; `flightNumber` el pedido, `date` igual a `$FECHA`, `status` uno de
`SCHEDULED`, `BOARDING`... y `terminal`, `estimatedAt`, `actualAt` o `aircraft` en `null` si el core
no los tiene. El core registra `GetFlightStatus OK`.

### 3.4 La consulta agregada y la perezosa

```bash
gql -H "x-device-fingerprint: $HUELLA" -H 'x-request-id: verif-agregada-0001' -d '{
  "query": "{ searchFlights(input: { itineraries: [{ origin: \"UIO\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { offers { offerId itineraries { segments { segmentId seatMap { cabins { cabinClass rows { rowNumber seats { seatNumber isAvailable } } } } } } } } }"
}' | head -c 600
```

**Esperado:** cada segmento trae su `seatMap` con datos. En el core, **una** línea `SearchFlights` y
una `GetSeatMap` por segmento distinto, todas con el id `verif-agregada-0001`. Si repites la consulta
**sin** el bloque `seatMap { ... }` (como en 3.1), el core solo registra `SearchFlights`: nunca un
`GetSeatMap`.

## 4. Errores

```bash
# NOT_FOUND: vuelo que no existe
gql -d '{"query":"{ flightStatus(flightNumber: \"ZZ9999\", date: \"'"$FECHA"'\") { status } }"}'
# → errors[0].extensions: { code: "NOT_FOUND", problemCode: "FLIGHT_STATUS_NOT_AVAILABLE", status: 404, requestId }

# BAD_USER_INPUT: búsqueda sin X-Device-Fingerprint (el core ni se entera)
gql -d '{"query":"{ searchFlights(input: { itineraries: [{ origin: \"UIO\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { totalOffers } }"}'
# → code "BAD_USER_INPUT", invalidParams [{ name: "X-Device-Fingerprint", reason: "is required" }]

# BAD_USER_INPUT del core: IATA inválido
gql -H "x-device-fingerprint: $HUELLA" -d '{"query":"{ searchFlights(input: { itineraries: [{ origin: \"uio\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { totalOffers } }"}'
# → code "BAD_USER_INPUT", problemCode "VALIDATION_FAILED", invalidParams con el campo (nunca el valor)

# TOO_MANY_REQUESTS: 21 búsquedas seguidas desde tu IP
for i in $(seq 1 21); do gql -H "x-device-fingerprint: $HUELLA" -d '{"query":"{ searchFlights(input: { itineraries: [{ origin: \"UIO\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { totalOffers } }"}' 2>&1 >/dev/null | head -1; done | sort | uniq -c
# → HTTP/1.1 200 hasta completar 20 búsquedas en el minuto (cuentan también las de antes, aunque
#   hayan fallado) y HTTP/1.1 429 las demás, con la cabecera Retry-After y retryAfter en extensions
```

**SERVICE_UNAVAILABLE:** con el BFF corriendo, detén el core (Ctrl+C en la terminal 1) y repite
3.3: `code: "SERVICE_UNAVAILABLE"`, `problemCode: "CORE_UNAVAILABLE"`, `retryAfter: 5`, y
`/health/ready` pasa a 503 mientras `/health` sigue en 200. Vuelve a levantar el core: el BFF se
reconecta solo (en unos segundos `/health/ready` vuelve a 200).

## 5. El BFF con REST

Detén el BFF (Ctrl+C) y arráncalo contra el HTTP del core:

```bash
NODE_ENV=development CORE_TRANSPORT=rest CORE_REST_URL=http://localhost:3000 PORT=4000 \
  node dist/main.js
```

`/health/ready` debe dar `{"status":"UP","core":{"transport":"rest","status":"UP"}}`. Repite 3.1, 3.2,
3.3 y la sección 4: **las respuestas deben ser las mismas**. Para compararlas, guarda la salida de
cada transporte y quita los ids que cambian en cada búsqueda:

```bash
# con el BFF por gRPC (sección 2) y luego por REST, guarda en /tmp/grpc.json y /tmp/rest.json:
gql -d '{"query":"{ flightStatus(flightNumber: \"'"$VUELO"'\", date: \"'"$FECHA"'\") { flightNumber date marketingCarrier operatingCarrier aircraft status departure { iataCode terminal scheduledAt estimatedAt actualAt } arrival { iataCode terminal scheduledAt estimatedAt actualAt } } }"}' 2>/dev/null > /tmp/grpc.json
# ...cambia de transporte...
gql -d '{"query":"{ flightStatus(flightNumber: \"'"$VUELO"'\", date: \"'"$FECHA"'\") { flightNumber date marketingCarrier operatingCarrier aircraft status departure { iataCode terminal scheduledAt estimatedAt actualAt } arrival { iataCode terminal scheduledAt estimatedAt actualAt } } }"}' 2>/dev/null > /tmp/rest.json
diff /tmp/grpc.json /tmp/rest.json && echo "IGUALES"
```

En una búsqueda el `offerId` (y el `itineraryId`) son uuid nuevos en cada llamada, así que compara
`jq 'walk(if type=="object" then del(.offerId, .itineraryId) else . end)'` de las dos salidas. Con
REST, el log del core muestra `POST /search`, `GET /offers/.../seatmap` y `GET /flights/.../status`
con el mismo `X-Request-Id` que mandó el BFF.

## 6. Smoke y pruebas

```bash
scripts/smoke.sh http://localhost:4000      # con el core arriba: incluye NOT_FOUND y una búsqueda
npm test                                    # 300+ pruebas con el core falso (no necesitan nada más)
```

## 7. Trazas y métricas con el gateway

El BFF sigue el estándar de observabilidad del gateway (ver [GRAPHQL.md](GRAPHQL.md#observabilidad)). Para ver
una traza completa, con el gateway (`main`) delante y el core con `GRPC_ENABLED=true`:

```bash
# un recolector OTLP falso (el del gateway: sirve cuando no hay Jaeger) y los servicios exportando a él
RECOLECTOR_PORT=4318 RECOLECTOR_ARCHIVO=/tmp/spans.jsonl node ../gateway_vuelos/scripts/e2e/recolector-otlp.mjs &
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 METRICS_PORT=9465 \
  NODE_ENV=development CORE_TRANSPORT=grpc CORE_GRPC_URL=localhost:50051 PORT=4000 node dist/main.js
# el gateway: UPSTREAM_BFF_URL=http://localhost:4000 UPSTREAM_CORE_URL=http://localhost:3000 \
#   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 METRICS_PORT=9464 node dist/main.js

# una búsqueda con mapa de asientos, solo por el gateway (8080); el trace-id viene en X-Trace-Id
curl -si localhost:8080/graphql -H 'content-type: application/json' -H 'x-device-fingerprint: verificacion-0001' \
  -d '{"query":"{ searchFlights(input: { itineraries: [{ origin: \"UIO\", destination: \"GYE\", departureDate: \"'"$FECHA"'\" }], passengers: { adults: 1 } }) { offers { itineraries { segments { seatMap { cabins { cabinClass } } } } } } }"}' \
  | grep -i x-trace-id
node scripts/arbol-traza.mjs /tmp/spans.jsonl <trace-id>
curl -s localhost:9465/metrics | grep -E '^(graphql_|bff_core|http_client)'
```

**Esperado:** una sola traza con el SERVER y el CLIENT del gateway, el SERVER del BFF (hijo del CLIENT del gateway),
el INTERNAL `graphql query searchFlights` y, debajo, un CLIENT `SearchFlights` más uno `GetSeatMap` por oferta.
`/metrics` da 404 en el 4000 y en el 8080. El span del core aparecerá cuando termine la fase 7c.

## Qué no cubre esta guía

El plazo vencido (`GATEWAY_TIMEOUT`) y el 429 del core no se reproducen con el core real sin
manipularlo: están probados con el core falso. El despliegue en Render se verifica con
`scripts/smoke.sh` (ver [DEPLOY.md](DEPLOY.md)).
