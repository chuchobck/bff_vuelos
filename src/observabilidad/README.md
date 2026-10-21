# src/observabilidad

Copia **tal cual** (byte a byte) de `src/observabilidad/{traceparent,atributos,trazas,metricas}.ts` del
gateway (`chuchobck/gateway_vuelos`, `main`), el módulo que implementa el estándar de Quinde
(`docs/OBSERVABILIDAD.md` de ese repo). **No se edita aquí**: un cambio se hace en el gateway y se
vuelve a copiar. Lo que el BFF agrega encima (middleware de Express, spans de GraphQL y del core,
métricas propias, logger) está en [`src/telemetria/`](../telemetria/README.md).

| Archivo          | Qué hace                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `traceparent.ts` | Lee y escribe `traceparent` (solo `00`, estricto) y acota `tracestate`                  |
| `atributos.ts`   | Lista cerrada de atributos de span, `error.type`, `__unmatched__` y métodos             |
| `trazas.ts`      | Proveedor de trazas (siempre arranca), exportador OTLP/HTTP opcional, `camposDeTraza()` |
| `metricas.ts`    | Métricas comunes en un `Registry` propio y el servidor de `/metrics`                    |
