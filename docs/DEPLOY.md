# Despliegue del BFF en Render

El BFF no tiene estado ni base de datos: solo necesita llegar al core. Hasta la fase Azure, el core
desplegado en Render (`quinde-vuelos-api`) **no expone gRPC** (el tráfico público de un servicio web
de Render llega solo al puerto HTTP), así que el BFF desplegado le habla **por REST**
(`CORE_TRANSPORT=rest`). Con gRPC, el BFF solo corre junto al core en una red privada.

> Lo que se verificó está al final. El despliegue real en Render no se probó desde este
> repositorio (no hay credenciales de esa cuenta).

## 1. Servicio en Render

1. En Render: _New_ → _Blueprint_ → el repositorio `bff_vuelos`. Render lee `render.yaml` y propone
   el servicio `quinde-vuelos-bff` (runtime Node, plan free).
2. Completa la única variable `sync: false` (Render la pide al crear el Blueprint):

   | Variable       | Valor                                                                                                                         |
   | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
   | `CORS_ORIGINS` | Los orígenes del marketplace separados por coma (`https://app.example.com`), sin ruta ni `*`; vacía si ningún navegador llama |

3. _Apply_. Render compila con `npm ci --include=dev && npm run build` (el `--include=dev` hace falta
   porque `NODE_ENV=production` también rige en el build y `npm ci` omitiría `@nestjs/cli` y
   `typescript`) y arranca con `node dist/main`.
4. Render pone `PORT` solo y revisa `/health` (liveness: no mira el core, para que Render no
   reinicie el BFF cuando el core duerme).

`render.yaml` ya fija `NODE_ENV=production`, `CORE_TRANSPORT=rest`,
`CORE_REST_URL=https://quinde-vuelos-api.onrender.com`, `TRUST_PROXY=1` (Render tiene un proxy
delante: sin esto el límite por IP vería la IP del proxy) y `NODE_VERSION=22`.

## 2. Variables de entorno

Si falta una obligatoria o una es inválida, el BFF **no arranca** y el error nombra la variable
(nunca su valor). Todas están comentadas en [`.env.example`](../.env.example).

| Variable                         | Obligatoria | Por defecto                                       | Qué hace                                                                                                          |
| -------------------------------- | ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                       | sí          | —                                                 | `development`, `production` o `test`. Con `production`, la introspección y el landing del sandbox quedan apagados |
| `CORE_TRANSPORT`                 | sí          | —                                                 | `grpc` o `rest`                                                                                                   |
| `CORE_REST_URL`                  | con `rest`  | —                                                 | Origen del core, sin ruta: `https://quinde-vuelos-api.onrender.com` (el BFF agrega `/flights/v1`)                 |
| `CORE_GRPC_URL`                  | no          | `localhost:50051`                                 | `host:puerto` del gRPC del core (solo con `grpc`)                                                                 |
| `PORT`                           | no          | `4000`                                            | Puerto HTTP (Render lo inyecta)                                                                                   |
| `CORE_TIMEOUT_MS`                | no          | `8000`                                            | Plazo de cada llamada al core, de 500 a 60000                                                                     |
| `CORE_MAX_LLAMADAS_POR_CONSULTA` | no          | `10`                                              | Llamadas al core que puede costar una consulta (`QUERY_TOO_EXPENSIVE`)                                            |
| `CORS_ORIGINS`                   | no          | ninguno                                           | Orígenes de navegador permitidos; sin `*`                                                                         |
| `TRUST_PROXY`                    | no          | `false`                                           | Proxies delante (Render: `1`); `true` no se acepta                                                                |
| `GRAPHQL_INTROSPECTION`          | no          | `true` fuera de production, `false` en production | Introspección y landing del sandbox                                                                               |
| `RATE_LIMIT_WINDOW_SECONDS`      | no          | `60`                                              | Ventana de todos los límites                                                                                      |
| `RATE_LIMIT_MAX`                 | no          | `100`                                             | Peticiones por IP y ventana a `/graphql`                                                                          |
| `RATE_LIMIT_SEARCH_MAX`          | no          | `20`                                              | `searchFlights` por IP y ventana                                                                                  |
| `RATE_LIMIT_SEATMAP_MAX`         | no          | `60`                                              | `seatMap` por IP y ventana                                                                                        |
| `RATE_LIMIT_FLIGHT_STATUS_MAX`   | no          | `60`                                              | `flightStatus` por IP y ventana                                                                                   |
| `OTEL_SERVICE_NAME`              | no          | `quinde-bff`                                      | `service.name` de trazas y métricas                                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | no          | (vacía: no se exporta)                            | Base OTLP/HTTP del recolector (`http://jaeger:4318`); sin credenciales ni query                                   |
| `OTEL_TRACES_SAMPLER_ARG`        | no          | `1` fuera de production, `0.1` en production      | Fracción de trazas raíz que se registran (0 a 1)                                                                  |
| `TRACE_TRUST_INCOMING`           | no          | `true`                                            | Continuar el `traceparent` que manda el gateway                                                                   |
| `METRICS_PORT`                   | no          | `9464`                                            | Puerto aparte de `/metrics`; `0` lo apaga. Distinto de `PORT`                                                     |

### Planes gratuitos: el core y el BFF duermen

En el plan free de Render un servicio se duerme tras 15 minutos sin tráfico y la primera llamada
tarda hasta medio minuto en despertarlo. Si el core duerme, la primera consulta del BFF vence su
plazo de 8 s y responde `GATEWAY_TIMEOUT` (con `SERVICE_UNAVAILABLE` si el proxy de Render contesta
antes); el reintento ya encuentra el core despierto. Para que la primera consulta espere el
arranque, sube el plazo en el panel del servicio: `CORE_TIMEOUT_MS=45000`. La contrapartida: una
consulta puede quedar colgada hasta ese plazo si el core no responde.

### Observabilidad

El BFF sigue el estándar de observabilidad del gateway (fase 7a): el SDK de trazas siempre
arranca, así que cada petición tiene un trace-id (`X-Trace-Id` en la respuesta, `traceId` y
`spanId` en los logs y `traceparent` hacia el core) aunque no se exporte nada. Los spans se
exportan solo si defines `OTEL_EXPORTER_OTLP_ENDPOINT`. `/metrics` está en `METRICS_PORT`, **aparte
del puerto público**: no es alcanzable por la URL del servicio y el ingress no debe publicarlo (en
Render, un servicio web solo publica `PORT`). Prometheus lo raspa por la red interna. Detalle en
[GRAPHQL.md](GRAPHQL.md#observabilidad).

## 3. Verificar el despliegue

```bash
scripts/smoke.sh https://quinde-vuelos-bff.onrender.com
SMOKE_ORIGIN=https://app.example.com scripts/smoke.sh https://quinde-vuelos-bff.onrender.com   # + CORS
```

Comprueba `/health`, `/health/ready`, el request id, la huella obligatoria, un error de validación,
el rechazo de lotes y, si el core responde, un `flightStatus` inexistente (`NOT_FOUND`) y una
búsqueda. Sale con 1 si falla algo. Con el core dormido, `/health/ready` da 503 y se omiten las
comprobaciones con core: vuelve a correrlo pasado un minuto.

A mano:

```bash
curl -s https://quinde-vuelos-bff.onrender.com/health
curl -s https://quinde-vuelos-bff.onrender.com/health/ready
```

## 4. Docker

El `Dockerfile` es multi-etapa (`node:22-bookworm-slim`, usuario `node`, `HEALTHCHECK` a `/health`)
y copia `contracts/proto` para el cliente gRPC:

```bash
docker build -t quinde-vuelos-bff .
docker run --rm -p 4000:4000 -e CORE_TRANSPORT=rest \
  -e CORE_REST_URL=https://quinde-vuelos-api.onrender.com quinde-vuelos-bff
# con el gRPC del core en la misma red:
docker run --rm -p 4000:4000 -e CORE_TRANSPORT=grpc -e CORE_GRPC_URL=core:50051 quinde-vuelos-bff
```

La imagen trae `NODE_ENV=production`: la introspección queda apagada salvo
`-e GRAPHQL_INTROSPECTION=true`.

## 5. La fase Azure (gRPC)

Cuando el core exponga gRPC en una red privada, basta cambiar dos variables del BFF:
`CORE_TRANSPORT=grpc` y `CORE_GRPC_URL=<host>:50051`. El gRPC del core es **sin TLS**
(`createInsecure`): exponerlo fuera de una red privada pide TLS o mTLS, y este cliente tampoco lo
habla todavía. Las respuestas GraphQL son idénticas con cualquiera de los dos transportes (hay
pruebas que lo comprueban).

## 6. Qué se verificó

- Con las dependencias de producción solas (`npm ci --omit=dev --ignore-scripts`, como la etapa de
  ejecución del `Dockerfile`), `dist/` + `contracts/proto` arrancan, `/health` responde 200 y la
  introspección está apagada en `production`.
- `scripts/smoke.sh` pasa contra el BFF compilado sin core (REST a un puerto cerrado) y contra el
  BFF con un core falso por gRPC y por REST.
- **No se verificó:** `docker build` (el entorno de desarrollo no tenía un daemon de Docker), el
  despliegue real en Render ni el core real. Ver `docs/VERIFICACION-LOCAL.md` para correrlo contra
  el core de verdad.
