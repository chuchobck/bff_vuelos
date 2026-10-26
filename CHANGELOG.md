# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/). El detalle de cada fase (decisiones, hallazgos y commits)
está en [docs/PLAN.md](docs/PLAN.md).

## [0.2.0] - 2026-10-21

El BFF adopta el estándar de observabilidad que definió el gateway (fase 7b del Reto 2). Sin cambios
en el esquema GraphQL ni en las respuestas; los logs pasan a ser una línea JSON.

### Fase 7b · Observabilidad

- **Módulo del estándar:** `src/observabilidad/{traceparent,atributos,trazas,metricas}.ts` copiados
  tal cual del gateway, con las mismas dependencias (`@opentelemetry/api`, `sdk-trace-node`,
  `exporter-trace-otlp-http`, `resources` y `prom-client`) y sin instrumentaciones automáticas.
- **Variables:** `OTEL_SERVICE_NAME` (`quinde-bff`), `OTEL_EXPORTER_OTLP_ENDPOINT` (opcional),
  `OTEL_TRACES_SAMPLER_ARG` (1 en desarrollo, 0.1 en production), `TRACE_TRUST_INCOMING` (`true`) y
  `METRICS_PORT` (9464; 0 lo apaga), validadas al arrancar sin mostrar su valor.
- **Spans:** SERVER por petición (`POST /graphql`, hijo del `traceparent` del gateway), INTERNAL por
  operación GraphQL (tipo y nombres de los campos raíz del esquema) y CLIENT por cada llamada real al
  core, después del DataLoader (`rpc.system`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`).
- **Propagación al core:** `traceparent` nuevo (mismo trace-id, parent = el span CLIENT) en la metadata
  gRPC, o en la cabecera con REST, junto a `x-request-id`; `tracestate` intacto si cabe. Se propaga
  aunque no haya exportador o la traza no se muestree.
- **Logs y respuesta:** JSON con `requestId`, `traceId` y `spanId` en cada línea; `X-Trace-Id` en la
  respuesta (también en los errores de CORS y del parser) y expuesta por CORS.
- **Métricas** en `METRICS_PORT`, aparte del puerto público: las comunes del estándar,
  `http_client_request_duration_seconds{upstream="core"}` con la RPC y el código gRPC, y las propias
  `graphql_root_fields_total{field}`, `graphql_errors_total{code}` y `bff_core_calls_per_query`.
- **Prohibido y probado:** ni el texto de la consulta, las variables, un `offerId`, la huella ni una IP
  salen en un span, un log o una métrica; mil nombres de operación, alias o rutas inventados no crean
  series nuevas.
- **Pruebas:** `test/trazas.spec.ts`, `spans-graphql.spec.ts`, `propagacion-core.spec.ts` y
  `escaneo-observabilidad.spec.ts`, con un recolector OTLP falso, y `npm run test:mutaciones`.

## [0.1.0] - 2026-10-15

Primera versión: el BFF GraphQL de la fase R2-2. Resuelve las tres lecturas públicas del core de
vuelos (búsqueda, mapa de asientos y estado de vuelo) por gRPC, con REST de respaldo. Sin
autenticación; la compra autenticada sigue por REST directo al core.

### Fase R2-2 · BFF GraphQL

- **Base:** proyecto NestJS 10 + TypeScript, ESLint, Prettier, husky y commitlint (Conventional
  Commits en español) como el core; `CLAUDE.md` con las reglas. El entorno se valida al arrancar y el
  error nombra la variable, nunca su valor (`CORE_TRANSPORT`, `CORE_GRPC_URL`, `CORE_REST_URL`,
  `CORE_TIMEOUT_MS`, `CORE_MAX_LLAMADAS_POR_CONSULTA`, `CORS_ORIGINS`, `TRUST_PROXY`,
  `GRAPHQL_INTROSPECTION`, `RATE_LIMIT_*`).
- **Contrato:** `contracts/proto/flights/v1/flights.proto` copiado del core, con `npm run proto:sync`
  y `npm run proto:check`.
- **Puerto y adaptadores:** `NucleoVuelos` con `buscarVuelos`, `mapaAsientos` y `estadoVuelo`.
  `NucleoGrpc` (mismas opciones de carga que el core, un canal, plazo por llamada, `x-request-id` y
  `x-device-fingerprint` como metadata) y `NucleoRest` (fetch nativo, `X-Request-Id` y
  `X-Device-Fingerprint`), con la misma forma de salida y los mismos errores de dominio.
- **GraphQL schema-first:** `searchFlights`, `seatMap` y `flightStatus`; escalares `Date` y
  `DateTime` validados; dinero como `String`; enums sin prefijo; `FlightSegment.seatMap` perezoso.
- **Contexto por petición:** request id, huella, contador de llamadas al core (`QUERY_TOO_EXPENSIVE`)
  y DataLoader de mapas de asientos.
- **Errores:** `extensions { code, problemCode, status, requestId, retryAfter?, invalidParams? }`
  con `NOT_FOUND`, `BAD_USER_INPUT`, `SERVICE_UNAVAILABLE`, `GATEWAY_TIMEOUT`, `TOO_MANY_REQUESTS` e
  `INTERNAL_SERVER_ERROR` genérico, sin stack ni mensajes internos del core.
- **Trazabilidad:** `X-Request-Id` al core, a la respuesta, a los errores y a una línea de log de
  acceso por petición. `X-Device-Fingerprint` obligatoria en `searchFlights`, nunca en logs ni errores.
- **Protecciones:** helmet, CORS por lista, cuerpo de hasta 100 kB, límite de peticiones por IP y por
  operación raíz (100 global; `searchFlights` 20, `seatMap` 60, `flightStatus` 60 por minuto) con un
  limitador propio que usa el `Reloj`, profundidad máxima 8, sin lotes, e introspección y landing del
  sandbox apagados en `production` salvo `GRAPHQL_INTROSPECTION=true`.
- **Salud:** `GET /health` (liveness) y `GET /health/ready` (503 si el core no responde).
- **Pruebas:** un solo juego parametrizado contra los dos adaptadores con un core falso por gRPC
  (construido desde el mismo proto) y por REST.
- **Compatibilidad:** `npm run schema:breaking` con `@graphql-inspector/cli`.
- **Entrega:** `Dockerfile` multi-etapa, `.github/workflows/ci.yml`, `render.yaml`
  (`quinde-vuelos-bff`, plan free, `CORE_TRANSPORT=rest`), `scripts/smoke.sh` y la documentación
  (`docs/ARQUITECTURA.md`, `GRAPHQL.md`, `DEPLOY.md`, `VERIFICACION-LOCAL.md`, `PLAN.md`).
