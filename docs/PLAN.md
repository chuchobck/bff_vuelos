# Plan del BFF — Quinde · BFF GraphQL de Vuelos

Actualizado: 2026-10-15 (cierre de la fase R2-2) · Este archivo se actualiza al cerrar cada fase.

El BFF es el segundo repositorio del dominio de vuelos de RDA2: el core
([`backend_vuelos`](https://github.com/chuchobck/backend_vuelos)) expone un gRPC interno (fase R2-1)
y este BFF GraphQL lo consume para el marketplace.

## Avance

| Fase                       | Estado                                                                                 | Verificado                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-2. BFF GraphQL (v0.1.0) | Hecha con un core falso (2026-10-15); falta probarla contra el core real y desplegarla | `npm run lint`, `format:check` y `build` limpios en cada commit; `npm test`: 12 suites, 316 pruebas pasan y 1 se omite a propósito (un número como monto solo cabe en REST). Se rompieron a propósito 11 comportamientos y en todos falló al menos una prueba (abajo). `scripts/smoke.sh` pasa contra el BFF compilado sin core y con un core falso por gRPC y por REST. Con solo las dependencias de producción (`npm ci --omit=dev`) arranca `dist/main.js` |

## Qué se hizo (por paso del encargo)

| Paso               | Qué                                                                                                          | Dónde                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1. Base            | Proyecto Nest 10, ESLint, Prettier, husky, commitlint, `CLAUDE.md`, README, `.env.example`, entorno validado | `src/config/entorno.ts`                                                                          |
| 2. Contrato        | `flights.proto` copiado del core, `proto:sync` y `proto:check`                                               | `contracts/proto/`, `scripts/proto-*.cjs`                                                        |
| 3. Puerto y gRPC   | `NucleoVuelos`, `ErrorNucleo`, `Normalizador`, `NucleoGrpc`                                                  | `src/nucleo/`                                                                                    |
| 4. REST            | `NucleoRest`; `CORE_TRANSPORT` elige                                                                         | `src/nucleo/rest/`, `nucleo.module.ts`                                                           |
| 5. Esquema         | schema-first, escalares `Date` y `DateTime`                                                                  | `src/graphql/schema.graphql`, `escalares.ts`                                                     |
| 6. Resolvers       | contexto por petición, DataLoader, tope de llamadas, `seatMap` perezoso                                      | `src/graphql/cliente-nucleo.ts`, `resolvers/`                                                    |
| 7. Trazabilidad    | request id, huella, log de acceso                                                                            | `trazabilidad.ts`, `plugin-acceso.ts`                                                            |
| 8. Errores         | del core a `extensions { code, problemCode, status, requestId, ... }`                                        | `errores-graphql.ts`                                                                             |
| 9. Protecciones    | helmet, CORS, cuerpo, límites, profundidad, lotes, introspección                                             | `configurar-app.ts`, `proteccion-http.ts`, `plugin-limites.ts`, `profundidad.ts`, `src/limites/` |
| 10. Salud          | `/health` y `/health/ready`                                                                                  | `src/salud/`                                                                                     |
| 11. Pruebas        | un juego parametrizado, core falso gRPC y REST                                                               | `test/`                                                                                          |
| 12. Compatibilidad | `schema:breaking` con `@graphql-inspector/cli`                                                               | `scripts/schema-breaking.sh`                                                                     |
| 13. Entrega        | Dockerfile, CI, `render.yaml`, `smoke.sh`, `DEPLOY.md`                                                       | raíz, `.github/`, `scripts/`                                                                     |
| 14. Docs           | README, ARQUITECTURA, GRAPHQL, VERIFICACION-LOCAL, PLAN, CHANGELOG                                           | `docs/`                                                                                          |

## Cómo se comprobó que las pruebas detectan fallos

Se rompió a propósito cada comportamiento (en el código, no en la prueba), se corrió toda la suite y
se restauró. En todos los casos falló al menos una prueba:

| Se rompió                                                   | Pruebas que fallaron |
| ----------------------------------------------------------- | -------------------- |
| gRPC no quita el prefijo de los enums                       | 53                   |
| Un enum desconocido pasa tal cual en vez de `null`          | 9                    |
| Un monto numérico se convierte a texto en vez de rechazarse | 3                    |
| El DataLoader no junta los pedidos iguales                  | 4                    |
| La huella sale en el log de acceso                          | 2                    |
| El detalle interno del core llega al cliente en un 5xx      | 14                   |
| El límite cuenta un alias como una sola operación           | 3                    |
| El tope de llamadas por consulta no se aplica               | 2                    |
| El `x-request-id` del cliente no llega al core              | 2                    |
| `searchFlights` pide por adelantado todos los mapas         | 5                    |
| La huella deja de ser obligatoria                           | 10                   |

Las pruebas nuevas también destaparon dos errores reales del código, corregidos antes de cerrar:
el limitador no normalizaba sus contadores tras un retroceso del reloj (un bloqueo podía durar más de
una ventana) y el escalar `Date` rechazaba los años menores a 100 (`Date.UTC` los toma como 19xx).

## Decisiones tomadas sin consultar

1. **Proto desde `feat/r2-grpc`.** La fase R2-1 aún no está fusionada: `flights.proto` es una copia
   de esa rama. `proto:check` contra `main` del core responde 2 ("no se pudo bajar") hasta que se
   fusione; en CI es informativo y no bloquea.
2. **Los scripts del proto no usan `GITHUB_TOKEN`.** Un token ajeno al core hace que GitHub responda
   404 aunque el repositorio sea público (pasó en el entorno de desarrollo). Para un repositorio
   privado existe `CORE_PROTO_TOKEN`.
3. **`NODE_ENV` es obligatoria**, como en el core: de ella depende que la introspección quede apagada.
4. **Enums obligatorios sin valor conocido = error, no `null`.** `FlightSegment.status` (nullable)
   toma `null` con `UNSPECIFIED` o un valor nuevo; `cabinClass`, `passengerType` y `FlightStatusDetail.status`
   son obligatorios en el contrato, así que un valor desconocido es `INTERNAL_SERVER_ERROR` y queda
   en el log con el campo (no el valor). Una característica de asiento desconocida se descarta.
5. **Landing con `playground`.** `@nestjs/apollo` 12 agrega siempre su propio plugin de landing:
   con `playground: true` es el GraphQL Playground, no Apollo Sandbox. Solo existe con la
   introspección encendida; en production no hay landing.
6. **Con el landing encendido, helmet va sin CSP** (el Playground carga scripts de un CDN); sin
   landing, helmet queda con su política estricta.
7. **Limitador propio y no `@nestjs/throttler`.** Hay que contar por operación raíz (los alias son
   varias operaciones), todo o nada, con el `Reloj`; el almacén del throttler usa `Date.now()`. Es
   por proceso (hoy hay una instancia). Una consulta que pide `searchFlights` 21 veces con alias se
   rechaza entera y no consume cupo. Los 100 globales cuentan toda petición a `/graphql`, también
   las rechazadas por un límite de operación.
8. **Profundidad = campos con sub-selección anidados** (las hojas y `__schema`/`__type` no cuentan).
   La consulta legítima más honda del esquema (búsqueda con el mapa de cada segmento) llega
   justo a 8, así que con este esquema ninguna consulta válida puede pasar de 8: el límite protege de
   futuros ciclos en el esquema y se prueba con un esquema recursivo.
9. **Códigos del BFF** cuando el core no manda `problem-*`: `problemCode` `CORE_UNAVAILABLE` (503),
   `CORE_TIMEOUT` (504), `CORE_ERROR` (500) y `CORE_BAD_RESPONSE` (502); `QUERY_TOO_EXPENSIVE` y
   `QUERY_TOO_DEEP` con `status` 400; un cuerpo grande, `PAYLOAD_TOO_LARGE` (413). Si el core no
   dice cuándo reintentar un `UNAVAILABLE`, `retryAfter` es 5 (lo que usa el core con la base caída).
10. **Solo el `detail` del core en 400 y 404** pasa al mensaje GraphQL (el core asegura que no lleva
    datos del pasajero ni la huella); en lo demás el mensaje es fijo del BFF.
11. **`/health` no mira el core** (que el core duerma no debe reiniciar el BFF); `/health/ready` sí.
12. **`render.yaml` no fija `CORE_TIMEOUT_MS`**: se dejó el valor por defecto (8 s) porque el
    encargo no lo pedía. Con el core gratuito dormido, la primera consulta da `GATEWAY_TIMEOUT`;
    `docs/DEPLOY.md` explica cómo subirlo a 45 s.
13. **Parser del cuerpo propio** (`bodyParser: false` en Nest) para ponerle el tope de 100 kB y
    responder sus errores (413, JSON roto) con la forma de un error GraphQL y el request id.
14. **Pruebas de protecciones contra un solo transporte (gRPC):** el límite, la profundidad, CORS y
    los logs no dependen del adaptador. Lo que sí depende (datos, errores, request id, huella, plazo,
    tope de llamadas, salud) corre contra los dos.
15. **CI arranca el BFF compilado** y le pasa `smoke.sh` sin core; `schema:breaking` corre en los
    pull requests y sale con 0 si `main` aún no tiene esquema.
16. **Rama `feat/r2-bff`** (la del encargo) en lugar de la rama de sesión que sugería el entorno.

## Pendiente y riesgos

- **Probar contra el core real** por gRPC y por REST: `docs/VERIFICACION-LOCAL.md`.
- **Desplegar en Render** y correr `scripts/smoke.sh` contra el despliegue (`docs/DEPLOY.md`).
- **gRPC sin TLS** (`createInsecure`), igual que el core: solo en red privada; la fase Azure pide TLS o mTLS.
- **El límite de peticiones es por proceso.** Con varias instancias del BFF se multiplica.
- **`npm audit` (dependencias de producción): 21 avisos, 15 altos.** Vienen de las versiones que fija el
  encargo (Nest 10, `@apollo/server` 4, `@nestjs/graphql` 12) y su corrección está en versiones mayores
  (Nest 11/12, Apollo Server 5, `@nestjs/graphql` 14). Qué importa aquí: `@nestjs/microservices`
  (DoS en el transporte TCP; el BFF solo usa gRPC de `@grpc/grpc-js`, no el transporte de Nest) y
  `multer` (no hay subida de archivos) no se ejercen. `@apollo/server` 4 tiene un aviso de CSRF de solo lectura entre sitios
  (XS-Search) con `GET`: el BFF no usa cookies ni credenciales y solo sirve datos públicos, así que no
  expone nada que no sea público. Subir de versión mayor es una decisión de otra fase.
- No se probó en Windows (los scripts son de bash).

## Historial

Un commit por paso (o por grupo pequeño), cada uno con `lint`, `format:check` y `build` limpios:
`git log --oneline` en la rama `feat/r2-bff`.
