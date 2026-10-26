# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · BFF GraphQL de Vuelos: NestJS 10 + TypeScript, `@nestjs/graphql` 12 con `@nestjs/apollo` 12
(`@apollo/server` 4, `graphql` 16), schema-first. Sin estado ni base de datos. Resuelve las tres
lecturas públicas del core (`github.com/chuchobck/backend_vuelos`: búsqueda de vuelos, mapa de
asientos y estado de vuelo) por gRPC, con REST de respaldo (`CORE_TRANSPORT`). La compra autenticada
(hold, reservas, pagos) no pasa por aquí: sigue por REST directo al core. El estado de las fases
está en `docs/PLAN.md`; los cambios, en `CHANGELOG.md`.

## Alcance

- Solo las tres lecturas públicas: `searchFlights`, `seatMap` y `flightStatus`. Una operación nueva
  que el core no tenga pública no se agrega aquí.
- Sin autenticación en esta fase. Si llega una, el BFF solo reenvía el token; no lo guarda.

## Idioma

- Código, carpetas y comentarios en español.
- El GraphQL hacia afuera (tipos, campos, enums, errores) en inglés y con los nombres del contrato
  del core (`SearchResponse` → `SearchResult`, `offerId`, `grandTotal`, `isAvailable`...).

## Estructura

- `src/config/`: entorno validado (`entorno.ts`), CORS, proxy y seguridad HTTP.
- `src/nucleo/`: el puerto `NucleoVuelos` (`nucleo-vuelos.ts`), el tipo de dominio (`modelo.ts`), el
  error de dominio (`error-nucleo.ts`) y los dos adaptadores, `grpc/` y `rest/`. Nada fuera de
  `nucleo/` conoce gRPC ni `fetch`; los resolvers dependen solo del puerto.
- `src/graphql/`: `schema.graphql` (la fuente del contrato GraphQL), resolvers, escalares, contexto
  por petición, errores y plugins de Apollo.
- `src/limites/`: el limitador de peticiones. `src/salud/`: `/health` y `/health/ready`.
- `src/observabilidad/`: copia **tal cual** (no se edita) de `traceparent`, `atributos`, `trazas` y
  `metricas` del gateway (`gateway_vuelos`, `docs/OBSERVABILIDAD.md`: el estándar). `src/telemetria/`:
  lo del BFF encima (middleware de Express, spans de GraphQL y del core, métricas propias, logger JSON).
- `contracts/proto/flights/v1/flights.proto`: copia del proto del core. **No se edita a mano**:
  `npm run proto:sync` lo trae de `main` del core y `npm run proto:check` lo compara.

## Contrato GraphQL

- El esquema es `src/graphql/schema.graphql`. En GraphQL no se versiona la URL: un campo o valor
  nuevo se agrega; uno que sobra se marca `@deprecated(reason: "...")` y se quita después.
- Nunca quitar ni renombrar un campo, tipo o valor de enum, ni volver nulo un campo que no lo era:
  `npm run schema:breaking` lo comprueba contra `main` y falla en los pull requests.
- Lo que el contrato del core permite `null` es nullable; lo demás, `!`. Los enums van sin prefijo
  (`FLIGHT_STATUS_SCHEDULED` del proto es `SCHEDULED`) y `*_UNSPECIFIED` es `null`.
- Dinero siempre `String` ("73.92"), nunca `Float`. `Date` es `YYYY-MM-DD`; `DateTime`, ISO 8601 UTC.
- Los dos adaptadores (`grpc`, `rest`) devuelven **exactamente** la misma forma del tipo de dominio
  de `modelo.ts`. Un cambio en uno se prueba contra los dos (`test/` parametrizado).

## Core

- El proto se carga con exactamente `OPCIONES_CARGA_PROTO` del core (`keepCase: false`,
  `longs: String`, `enums: String`, `defaults: true`, `oneofs: false`). Si el core las cambia, se
  cambian aquí en el mismo paso.
- Un error del core pasa a `ErrorNucleo` leyendo `problem-code`, `problem-status`,
  `problem-details-bin` (JSON UTF-8) y `retry-after`; y los códigos sin `problem-*` que agrega
  grpc-js (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `UNIMPLEMENTED`). REST lee el ProblemDetails.
- Toda llamada al core lleva plazo (`CORE_TIMEOUT_MS`), `x-request-id` y, en la búsqueda,
  `x-device-fingerprint`. Se cuenta contra `CORE_MAX_LLAMADAS_POR_CONSULTA`.
- Un campo que cuelga de otro y cuesta una llamada (`FlightSegment.seatMap`) se resuelve perezoso,
  con el `DataLoader` de la petición; nunca se pide por adelantado.

## Seguridad

- El core NO limita peticiones en gRPC: el límite por IP y por operación raíz lo pone este BFF
  (`src/limites/`), con la hora del `Reloj` (`src/common/reloj.ts`), nunca con `Date.now()`.
- `x-device-fingerprint` y los datos del usuario no van a logs, errores ni respuestas. Los errores
  nombran el campo, no el valor. El log de acceso lleva solo request id, `operationName` (si es un
  identificador GraphQL), duración y llamadas al core.
- Un error del core que no sea 400/404/429/503/504 sale como `INTERNAL_SERVER_ERROR` con mensaje
  genérico: ni el stack ni el mensaje interno del core llegan al cliente.
- Una variable de entorno nueva va en `src/config/entorno.ts`, `.env.example`, `docs/DEPLOY.md`
  y, si es obligatoria, en `render.yaml` y en el `env` de CI. Un mensaje de validación nombra la
  variable, nunca su valor.
- Producción: introspección y landing del sandbox apagados salvo `GRAPHQL_INTROSPECTION=true`;
  profundidad máxima 8; sin consultas en lote; cuerpo máximo 100 kB.

## Observabilidad

- El estándar es el de `docs/OBSERVABILIDAD.md` del gateway y manda sobre este archivo si chocan. Un
  cambio de los cuatro archivos de `src/observabilidad/` se hace en el gateway y se vuelve a copiar.
- El middleware de `src/telemetria/middleware.ts` va PRIMERO en `configurar-app.ts`. El SDK de trazas
  siempre arranca (hay trace-id, `X-Trace-Id` y `traceparent` hacia el core aunque no se exporte nada).
- Spans: SERVER por petición, INTERNAL por operación GraphQL, CLIENT por cada llamada real al core
  (después del DataLoader). Cada llamada manda al core un `traceparent` NUEVO junto a `x-request-id`.
- **Prohibido en spans, logs y métricas:** texto de la consulta, variables, argumentos, alias,
  `offerId`, `X-Device-Fingerprint` e IPs. El nombre de la operación del cliente no va ni a un span ni
  a una etiqueta (solo el log de acceso, ya validado como identificador GraphQL).
- Etiquetas y atributos solo con valores de conjuntos cerrados: la plantilla de ruta (`/graphql`,
  `/health`, `/health/ready`, `__unmatched__`), los campos raíz del esquema (o `__other__`), los `code`
  de error conocidos (o `__other__`) y las tres RPC del core. Nunca un texto del cliente.
- `/metrics` solo en `METRICS_PORT`, nunca en el puerto público. `METRICS_PORT` no puede ser `PORT`.
- Un atributo de span nuevo se agrega a `atributos-bff.ts` con su conjunto cerrado de valores.

## Pruebas

- Jest + supertest. No hay core real: un servidor gRPC falso (construido desde el mismo proto) y un
  servidor HTTP falso (REST). Un solo juego de pruebas corre contra los dos adaptadores.
- Las pruebas de límites pasan un `RelojDePrueba`; ninguna depende de `Date.now()` ni espera de más.
- Una prueba nueva se comprueba rompiendo a propósito lo que cubre: si no falla, no prueba nada.
  `npm run test:mutaciones` (`scripts/mutaciones.mjs`) lo hace para la observabilidad: una mutación
  nueva va ahí con la prueba que debe detectarla.
- Los spans se prueban con un recolector OTLP falso (`test/utils/recolector-otlp.ts`); el logger de
  Nest es global, así que una prueba que lee `app.logs` crea su propio app.

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso (o por grupo pequeño), y cada uno compila con `npm run lint`,
  `npm run format:check` y `npm run build` limpios.
- Una rama por fase. Push solo de esa rama, al cerrar la fase y ya verificada; nunca a `main`,
  nunca `--force`, nunca reescribir commits subidos. El merge lo hace el dueño del repo.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando. CI (`.github/workflows/ci.yml`) corre lint,
  formato, build y pruebas en cada push y pull request a `main`; `proto:check` es informativo y
  `schema:breaking` corre en los pull requests.
- Contra un despliegue: `scripts/smoke.sh <BASE_URL>` (guía en `docs/DEPLOY.md`). En local, con el
  core: `docs/VERIFICACION-LOCAL.md`.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó,
  qué no se pudo verificar y qué se decidió sin consultar.
