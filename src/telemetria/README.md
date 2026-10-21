# src/telemetria

Lo que el BFF agrega encima del módulo del estándar (`src/observabilidad/`, copia tal cual del
gateway; ver su README). Aquí está todo lo que depende de Express, de Apollo o del core.

| Archivo                    | Qué hace                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observabilidad.ts`        | `Observabilidad`: las trazas, las métricas y el servidor de `/metrics`. Se crea ANTES que la app (el SDK siempre arranca) y se cierra con ella                                        |
| `middleware.ts`            | El PRIMER middleware de Express: X-Request-Id, span SERVER (hijo del `traceparent` del gateway), `X-Trace-Id`, métrica del servidor. La plantilla de ruta sale de un conjunto cerrado |
| `plugin-observabilidad.ts` | Plugin de Apollo: span INTERNAL por operación, `graphql_root_fields_total`, `graphql_errors_total` y `bff_core_calls_per_query`                                                       |
| `llamada-core.ts`          | Una llamada real al core: span CLIENT, `traceparent` nuevo hacia el core y `http_client_request_duration_seconds{upstream="core"}`                                                    |
| `atributos-bff.ts`         | Los atributos que el BFF agrega a la lista cerrada del estándar (`graphql.*`, `rpc.*`), cada uno con un conjunto cerrado de valores                                                   |
| `metricas-bff.ts`          | Las métricas propias, con etiquetas acotadas (un campo del esquema o `__other__`; un code de la lista o `__other__`)                                                                  |
| `logger-json.ts`           | Logger de la app: una línea JSON con `requestId`, `traceId` y `spanId` del contexto activo                                                                                            |
| `observacion.ts`           | Lo que se guarda en `res.locals.observacion` para pasar el contexto por encima del parser del cuerpo                                                                                  |

## Por qué hay atributos aparte (y no se editó `atributos.ts`)

El estándar limita los atributos de span a una lista cerrada que `filtrarAtributos` aplica, y ese
archivo se copia tal cual del gateway. El BFF necesita seis más por el encargo (`graphql.operation.type`,
`graphql.root_fields`, `rpc.system`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`), así que los
abre `filtrarAtributosBff`: pasa los del estándar por `filtrarAtributos` y deja los suyos solo si su valor
es de un conjunto cerrado (el tipo de operación, los tres campos del esquema, el servicio y las tres RPC
del core, un código gRPC de 0 a 16). No hay forma de poner ahí un texto libre del cliente.

Esto debería subir al estándar (`docs/OBSERVABILIDAD.md` del gateway) como atributos permitidos de los
servicios que hablan gRPC o GraphQL; hasta entonces es una extensión del BFF, anotada en `docs/PLAN.md`.

## Tres cosas que no son obvias

- **El contexto de OpenTelemetry se pierde tras el parser del cuerpo** (body-parser usa eventos del
  socket, que no heredan el contexto asíncrono). Por eso el middleware lo guarda en
  `res.locals.observacion` y `middlewareContexto` (después del parser) lo vuelve a abrir.
- **Los spans CLIENT cuelgan de la operación por referencia explícita**, no del contexto activo:
  el DataLoader despacha en otro tick. `ClienteNucleo` le pasa a cada adaptador el contexto del span de la
  operación (`ContextoLlamada.traza`).
- **`registrarCliente` del módulo del estándar normaliza `method` a un verbo HTTP** (la RPC saldría como
  `_OTHER`), así que la llamada al core observa `duracionCliente` directamente con la RPC como
  `method`: tres valores posibles.
