# GraphQL

Endpoint: `POST /graphql` (JSON). Esquema: [`src/graphql/schema.graphql`](../src/graphql/schema.graphql).
En local, con la introspección encendida, `GET /graphql` en el navegador abre el landing (el
GraphQL Playground que trae `@nestjs/apollo`).

## Por qué GraphQL aquí

Las tres lecturas son **públicas, de solo lectura y se piden juntas**: el marketplace busca vuelos,
y para cada segmento que muestra quiere el mapa de asientos y, a veces, el estado del vuelo. Con REST
son una petición por cada cosa y el frontend decide qué hacer con campos que no usa; con GraphQL el
cliente describe el árbol que necesita en una consulta y recibe solo eso. El BFF, además, evita
pedir al core lo que la consulta no selecciona.

## Las consultas

| Consulta                                                                | Operación del core                                       | Notas                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `searchFlights(input: SearchInput!): SearchResult!`                     | `POST /search` · `SearchFlights`                         | Exige la cabecera `X-Device-Fingerprint`. Límite: 20 por minuto e IP  |
| `seatMap(offerId: ID!, segmentId: ID!): SeatMap!`                       | `GET /offers/{offerId}/seatmap` · `GetSeatMap`           | El `offerId` vence con la oferta (30 min). Límite: 60 por minuto e IP |
| `flightStatus(flightNumber: String!, date: Date!): FlightStatusDetail!` | `GET /flights/{flightNumber}/status` · `GetFlightStatus` | `date` es la fecha local de salida. Límite: 60 por minuto e IP        |

Extra de agregación: **`FlightSegment.seatMap: SeatMap`**, el mapa de asientos de ese segmento. Es
perezoso: solo cuesta una llamada al core si la consulta lo pide, con el `offerId` de su oferta; el
mismo `offerId` y `segmentId` pedido de dos maneras es una sola llamada (DataLoader por petición).
Cada mapa cuenta contra `CORE_MAX_LLAMADAS_POR_CONSULTA` (10 por defecto): una búsqueda más 9
segmentos distintos es el tope.

Reglas del esquema: el dinero es siempre `String` (`"73.92"`); `Date` es `YYYY-MM-DD` y `DateTime`
ISO 8601 UTC, los dos validados; lo que el contrato permite `null` es nullable; los enums van sin
prefijo (`SCHEDULED`) y un valor que el BFF no conoce llega como `null` donde el contrato lo permite.

## Un ejemplo simple

```bash
curl -s localhost:4000/graphql -H 'content-type: application/json' -d '{
  "query": "{ flightStatus(flightNumber: \"AV1500\", date: \"2026-10-22\") { flightNumber status departure { iataCode scheduledAt estimatedAt } } }"
}'
```

```json
{
  "data": {
    "flightStatus": {
      "flightNumber": "AV1500",
      "status": "DELAYED",
      "departure": {
        "iataCode": "UIO",
        "scheduledAt": "2026-10-22T12:30:00.000Z",
        "estimatedAt": "2026-10-22T12:50:00.000Z"
      }
    }
  }
}
```

## Un ejemplo agregado: búsqueda y mapa de asientos en una consulta

```graphql
query BuscarConMapas {
  searchFlights(
    input: {
      itineraries: [{ origin: "UIO", destination: "GYE", departureDate: "2026-10-22" }]
      passengers: { adults: 1 }
    }
  ) {
    totalOffers
    offers {
      offerId
      grandTotal {
        currency
        total
      }
      itineraries {
        segments {
          flightNumber
          status
          seatMap {
            cabins {
              cabinClass
              rows {
                rowNumber
                seats {
                  seatNumber
                  isAvailable
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Va con la cabecera `X-Device-Fingerprint: <8 a 128 letras, dígitos o . _ : + / = ->`. Respuesta
(recortada; con los datos de ejemplo de las pruebas, los reales dependen de la semilla del core):

```json
{
  "data": {
    "searchFlights": {
      "totalOffers": 2,
      "offers": [
        {
          "offerId": "0f5e8a64-1c63-4c6f-9a07-3c1d6a2b7e10",
          "grandTotal": { "currency": "USD", "total": "73.92" },
          "itineraries": [
            {
              "segments": [
                {
                  "flightNumber": "AV1500",
                  "status": "SCHEDULED",
                  "seatMap": {
                    "cabins": [
                      {
                        "cabinClass": "ECONOMY",
                        "rows": [
                          {
                            "rowNumber": 12,
                            "seats": [
                              { "seatNumber": "12A", "isAvailable": true },
                              { "seatNumber": "12B", "isAvailable": false }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

Si quitas el bloque `seatMap { ... }`, el BFF hace **una** llamada al core (`SearchFlights`) y
ninguna a `GetSeatMap`. Con él, hace una por segmento distinto.

## Errores

Todo error lleva la misma forma, venga del core, de GraphQL o del BFF:

```json
{
  "errors": [
    {
      "message": "Flight ZZ9999 was not found on 2026-10-22",
      "path": ["flightStatus"],
      "extensions": {
        "code": "NOT_FOUND",
        "problemCode": "FLIGHT_STATUS_NOT_AVAILABLE",
        "status": 404,
        "requestId": "9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
      }
    }
  ],
  "data": null
}
```

`code` es el que decide el cliente; `problemCode` es el `code` del ProblemDetails del core (o uno del
BFF si el core no lo mandó); `status`, el HTTP equivalente; `requestId`, el mismo de la cabecera
`X-Request-Id` (y el de los logs); `retryAfter` (segundos) aparece en `SERVICE_UNAVAILABLE` y
`TOO_MANY_REQUESTS`; `invalidParams` (`[{ name, reason }]`), en `BAD_USER_INPUT` del core. Nunca hay
stack ni mensajes internos del core.

| `code`                                              | Cuándo                                                                                                                               | `status`          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `NOT_FOUND`                                         | El core no encontró la oferta, el segmento o el vuelo                                                                                | 404               |
| `BAD_USER_INPUT`                                    | Argumento inválido (lo dice el core o el escalar `Date`), falta o es inválida `X-Device-Fingerprint`, JSON roto, lote de operaciones | 400               |
| `SERVICE_UNAVAILABLE`                               | El core no responde o dice 503/502 (con `retryAfter`; 5 s si no dijo)                                                                | 503               |
| `GATEWAY_TIMEOUT`                                   | El core no contestó en `CORE_TIMEOUT_MS`                                                                                             | 504               |
| `TOO_MANY_REQUESTS`                                 | Pasaste un límite del BFF (HTTP 429 con `Retry-After`) o el core te limitó                                                           | 429               |
| `QUERY_TOO_EXPENSIVE`                               | La consulta necesita más de `CORE_MAX_LLAMADAS_POR_CONSULTA` llamadas al core                                                        | 400               |
| `QUERY_TOO_DEEP`                                    | Más de 8 niveles de campos anidados                                                                                                  | 400               |
| `GRAPHQL_PARSE_FAILED`, `GRAPHQL_VALIDATION_FAILED` | Consulta mal escrita o que no cumple el esquema                                                                                      | 400               |
| `INTERNAL_SERVER_ERROR`                             | Cualquier otra cosa del core (409, 422, 5xx...), una respuesta del core con la forma rota o una excepción: mensaje genérico          | el del core o 500 |

Un error en un campo nullable (`FlightSegment.seatMap`) deja ese campo en `null` con su error en
`errors[].path`, y el resto de la respuesta llega. Un error en un campo `!` sube hasta el primer
padre nullable (en las consultas raíz, `data: null`).

## Límites y protecciones

Profundidad máxima **8** (la consulta legítima más honda, búsqueda con mapas, llega justo a 8: los
campos hoja no cuentan); sin lotes (un arreglo en el cuerpo es 400); cuerpo máximo 100 kB;
introspección y sandbox apagados en `production` salvo `GRAPHQL_INTROSPECTION=true`; límites por IP
(100 por minuto en total y 20/60/60 por operación). Un alias repetido cuenta como una operación más:
`a: seatMap(...) b: seatMap(...)` son dos.

## Observabilidad

El BFF sigue el estándar de observabilidad de Quinde (fase 7a, `docs/OBSERVABILIDAD.md` del
gateway): trazas W3C, métricas Prometheus y logs JSON. El gateway abre la traza y la manda en
`traceparent`; el BFF la continúa (`TRACE_TRUST_INCOMING=true`: solo lo llama el gateway) y la pasa
al core.

**Spans** (siempre hay trace-id y propagación; los spans solo se exportan con
`OTEL_EXPORTER_OTLP_ENDPOINT`):

```text
POST /graphql                                         SERVER    (hijo del span del gateway)
└─ graphql query searchFlights                        INTERNAL  graphql.operation.type, graphql.root_fields
   ├─ quinde.flights.v1.FlightsService/SearchFlights  CLIENT    rpc.system=grpc, rpc.method, rpc.grpc.status_code
   ├─ quinde.flights.v1.FlightsService/GetSeatMap     CLIENT    (uno por segmento DISTINTO: el DataLoader junta los iguales)
   └─ quinde.flights.v1.FlightsService/GetSeatMap     CLIENT
```

- Nunca llevan el texto de la consulta, las variables, los argumentos, un alias, el
  `operationName`, un `offerId`, la huella ni una IP. `graphql.root_fields` lista solo los campos raíz
  **del esquema** (`searchFlights,seatMap`); cualquier otro nombre es `__other__`.
- Un error del cliente (`NOT_FOUND`, `BAD_USER_INPUT`...) no marca el span; uno del servicio
  (`GATEWAY_TIMEOUT` → `error.type=timeout`, `SERVICE_UNAVAILABLE` → `unavailable`, `INTERNAL_SERVER_ERROR`
  → `500`) sí, siempre sin el mensaje.
- El core recibe en la metadata `traceparent` un valor **nuevo** (mismo trace-id, parent = el span CLIENT
  de esa llamada) junto a `x-request-id`; con REST, la cabecera `traceparent`. Se propaga aunque no haya
  exportador y aunque la traza no se muestree (bit `00`). `tracestate` pasa intacto si el gateway lo mandó y
  cabe en el tope de W3C.
- La respuesta lleva `X-Trace-Id` (el trace-id); `requestId`, `traceId` y `spanId` van en cada línea de
  log.

**Métricas**, en `METRICS_PORT` (aparte del puerto público; el ingress no lo expone), solo `GET /metrics`:

| Métrica                                                              | Etiquetas                                                                                                                                                                          | Qué mide                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `http_server_request_duration_seconds`, `http_server_requests_total` | `method`, `route` (`/graphql`, `/health`, `/health/ready` o `__unmatched__`), `status`                                                                                             | Peticiones HTTP atendidas                                                                 |
| `http_client_request_duration_seconds`                               | `upstream="core"`, `method` = la RPC (`SearchFlights`, `GetSeatMap`, `GetFlightStatus`), `status` = el código gRPC (`0` OK, `5` NOT_FOUND, `14` UNAVAILABLE...) o el HTTP con REST | Cada llamada real al core                                                                 |
| `graphql_root_fields_total`                                          | `field`: `searchFlights`, `seatMap`, `flightStatus` o `__other__`                                                                                                                  | Campos raíz ejecutados                                                                    |
| `graphql_errors_total`                                               | `code`: uno de la lista del apartado Errores o `__other__`                                                                                                                         | Errores devueltos                                                                         |
| `bff_core_calls_per_query`                                           | (histograma, cubetas 0 a 100)                                                                                                                                                      | Cuántas llamadas al core hizo cada consulta; sirve para el análisis de latencia (fase 7d) |
| `quinde_build_info`, `process_*`, `nodejs_*`                         |                                                                                                                                                                                    | Estándar                                                                                  |

Cubetas de duración: las del estándar (5 ms a 60 s). Ninguna etiqueta toma un valor del cliente: mil
nombres de operación, alias, campos o rutas inventados son las mismas series.

Probar: `npm test` (`test/trazas.spec.ts`, `spans-graphql.spec.ts`, `propagacion-core.spec.ts` y
`escaneo-observabilidad.spec.ts`, con un core gRPC falso y un recolector OTLP falso) y
`npm run test:mutaciones` (rompe a propósito la propagación, la plantilla de ruta, las etiquetas y
el puerto de `/metrics`, y exige que una prueba falle).

## Dónde GraphQL NO conviene (y se queda REST)

Todo lo que no es una lectura pública se queda por **REST directo al core** (contrato OpenAPI
1.5.0.0), no por este BFF:

- **La compra autenticada: hold, reservas, pagos, postventa, check-in.** Son escrituras con efectos
  (cupo, dinero, boletos) que dependen de `Idempotency-Key`, de un token con scopes por operación
  y de una respuesta HTTP que significa algo (`201`, `202` con pago pendiente, `409` conflicto, `410`
  vencido, `422`). GraphQL responde `200` con `errors` y esconde esa semántica; reintentar con
  seguridad una mutación es más difícil que repetir un `POST` idempotente.
- **Los webhooks.** Es el core llamando a un tercero, firmado y reintentado: no es una consulta de un
  cliente.
- **La administración del catálogo y la auditoría.** CRUD interno con scopes de administrador, sin
  nada que agregar.
- **Lo cacheable por HTTP.** Una lectura simple (`GET` de un estado) se cachea en CDN y navegador por
  URL; un `POST /graphql` no, salvo que se cambie la estrategia.

Y dentro de lo público, GraphQL aporta poco si el cliente solo necesita **una** de las tres lecturas
con todos sus campos: ahí REST directo es igual de simple y se ahorra un salto.
