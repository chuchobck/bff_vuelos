# Quinde · BFF GraphQL de Vuelos

BFF (backend for frontend) GraphQL, **sin estado ni base de datos**, que agrega en una consulta las
tres lecturas públicas del core de vuelos
([`backend_vuelos`](https://github.com/chuchobck/backend_vuelos)): búsqueda de vuelos, mapa de
asientos y estado de vuelo. Las resuelve contra el core por **gRPC**, con **REST de respaldo**
(el core en Render no expone gRPC hasta la fase Azure). Versión **0.1.0**
([CHANGELOG](CHANGELOG.md)).

```text
Marketplace ──GraphQL──▶ BFF ──gRPC (o REST de respaldo)──▶ Quinde · API de Vuelos ──▶ PostgreSQL
```

La compra autenticada (hold, reservas, pagos) **no pasa por aquí**: sigue por REST directo al core.

- Arquitectura y decisiones: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)
- Las consultas, ejemplos y errores: [docs/GRAPHQL.md](docs/GRAPHQL.md)
- Despliegue en Render y Docker: [docs/DEPLOY.md](docs/DEPLOY.md)
- Probarlo contra el core real: [docs/VERIFICACION-LOCAL.md](docs/VERIFICACION-LOCAL.md)
- Estado de las fases: [docs/PLAN.md](docs/PLAN.md) · Reglas del proyecto: [CLAUDE.md](CLAUDE.md)

## Estado

| Fase              | Estado                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| R2-2. BFF GraphQL | Hecha con un core falso; falta probarla contra el core real ([guía](docs/VERIFICACION-LOCAL.md)) y desplegarla en Render |

## Requisitos

- Node.js 20.19 o superior (recomendado 22; hay un `.nvmrc`)
- El core de vuelos accesible: por gRPC (`GRPC_ENABLED=true`, puerto 50051) o por REST

## Arranque

```bash
nvm use                     # Node >= 20.19 (.nvmrc)
npm ci
npm run build

# contra el gRPC del core
NODE_ENV=development CORE_TRANSPORT=grpc CORE_GRPC_URL=localhost:50051 node dist/main.js
# o contra su REST (lo que hay en Render)
NODE_ENV=development CORE_TRANSPORT=rest CORE_REST_URL=http://localhost:3000 node dist/main.js
```

Escucha en <http://localhost:4000>: `POST /graphql`, `GET /health` y `GET /health/ready`. Con la
introspección encendida (por defecto fuera de `production`), `GET /graphql` en el navegador abre el
landing. `npm run start:dev` recarga al guardar (con las mismas variables).

```bash
curl -s localhost:4000/graphql -H 'content-type: application/json' \
  -d '{"query":"{ flightStatus(flightNumber: \"AV1500\", date: \"2026-10-22\") { status } }"}'
```

Si falta una variable obligatoria (`NODE_ENV`, `CORE_TRANSPORT`, y `CORE_REST_URL` con `rest`) o una
tiene un formato inválido, el BFF **no arranca** y el error nombra la variable, nunca su valor. Todas
están comentadas en [`.env.example`](.env.example) y en [docs/DEPLOY.md](docs/DEPLOY.md).

## Qué hace

- **Tres consultas:** `searchFlights`, `seatMap` y `flightStatus`, con los nombres del contrato del
  core en camelCase. Extra de agregación: `FlightSegment.seatMap`, perezoso (solo llama al core si
  la consulta lo pide) y con un DataLoader por petición.
- **Dos transportes** detrás de un mismo puerto (`NucleoVuelos`), que devuelven exactamente la misma
  forma: enums sin prefijo, lo que falta como `null`, el dinero siempre como texto.
- **Errores con una sola forma:** `extensions { code, problemCode, status, requestId, retryAfter?,
invalidParams? }`, sin stack ni mensajes internos del core.
- **Trazabilidad:** `X-Request-Id` (el del cliente si es válido) viaja al core, a la respuesta, a
  los errores y al log de acceso. `X-Device-Fingerprint` es obligatoria en `searchFlights` y nunca
  sale en un log ni en un error.
- **Protecciones** (el core no limita peticiones en gRPC): límite por IP y por operación,
  profundidad máxima 8, tope de llamadas al core por consulta, sin lotes, cuerpo de hasta 100 kB,
  helmet, CORS por lista y sin introspección en `production`.

## Scripts

| Comando                                 | Qué hace                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run build`                         | Compila a `dist/` (copia también `schema.graphql`)                                                       |
| `npm run start:dev`                     | Levanta el BFF y recarga al guardar                                                                      |
| `npm test`                              | Pruebas (Jest + supertest) con un core falso por gRPC y por REST; no necesitan nada más                  |
| `npm run lint` · `npm run format:check` | ESLint y Prettier                                                                                        |
| `npm run proto:sync`                    | Trae `flights.proto` de `main` del core (no se edita a mano)                                             |
| `npm run proto:check`                   | Compara el proto local con el del core; sale con 1 si difieren                                           |
| `npm run schema:breaking`               | Compara `schema.graphql` con el de `main` (`@graphql-inspector/cli`); sale con 1 si rompe a los clientes |
| `scripts/smoke.sh <BASE_URL>`           | Comprueba un BFF en marcha (local o desplegado)                                                          |

## Estructura

```text
src/
  config/       entorno validado, CORS, proxy
  common/       Reloj, request id, huella, contexto asíncrono
  nucleo/       puerto NucleoVuelos, modelo, ErrorNucleo, Normalizador y los adaptadores grpc/ y rest/
  graphql/      schema.graphql, resolvers, escalares, contexto, errores, plugins y protecciones
  limites/      limitador de peticiones (ventana deslizante con Reloj)
  salud/        /health y /health/ready
contracts/proto/flights/v1/flights.proto   copia del proto del core
scripts/        proto-sync, proto-check, schema-breaking, smoke
test/           pruebas, core falso (gRPC y REST) y fixtures
docs/           ARQUITECTURA, GRAPHQL, DEPLOY, VERIFICACION-LOCAL, PLAN
```

## Seguridad conocida

Las dependencias que fija la fase (NestJS 10, `@apollo/server` 4, `@nestjs/graphql` 12) tienen
avisos de `npm audit` cuya corrección está en versiones mayores nuevas (Nest 11/12, Apollo Server
5). Están anotados en [docs/PLAN.md](docs/PLAN.md); actualizarlos es una decisión de otra fase.
