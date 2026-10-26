import { SpanKind, trace } from '@opentelemetry/api';
import { NextFunction, Request, Response } from 'express';
import { middlewareRequestId, requestIdDe } from '../graphql/trazabilidad';
import { metodoNormalizado } from '../observabilidad/atributos';
import { tracestateAcotado } from '../observabilidad/traceparent';
import { CLAVE_REQUEST_ID, marcarError } from '../observabilidad/trazas';
import { Observabilidad } from './observabilidad';
import { ObservacionPeticion } from './observacion';

export const CABECERA_TRACE_ID = 'X-Trace-Id';

/**
 * Las únicas rutas del BFF: no hay parámetros en la ruta, así que la "plantilla" es la ruta misma.
 * Cualquier otra (un 404, un escaneo, una URL inventada) es `__unmatched__`: ni la ruta pedida ni
 * la query llegan nunca a un span, una métrica o un log.
 */
const PLANTILLAS = new Set(['/graphql', '/health', '/health/ready']);

/** La plantilla de la ruta pedida, o undefined (→ `__unmatched__`). Ignora la query, mayúsculas y la barra final. */
export function plantillaDeRuta(url: string): string | undefined {
  let ruta = url.split('?')[0] ?? '';
  try {
    ruta = decodeURIComponent(ruta);
  } catch {
    return undefined;
  }
  ruta = ruta.toLowerCase().replace(/\/+$/, '');
  return PLANTILLAS.has(ruta) ? ruta : undefined;
}

/**
 * EL PRIMER middleware de la app (sección 5 del estándar). Hace, en este orden:
 *   1. fija el X-Request-Id (reglas del core; antes que todo, para que hasta un error de CORS lo lleve);
 *   2. abre el span SERVER, hijo del `traceparent` del gateway (TRACE_TRUST_INCOMING; uno inválido o
 *      repetido se ignora y abre una traza nueva) y pone el request id en el contexto;
 *   3. devuelve `X-Trace-Id`;
 *   4. llama a `next()` dentro del contexto del span;
 *   5. al terminar la respuesta, nombra el span `METHOD /plantilla`, lo cierra y registra la métrica.
 *
 * El contexto asíncrono se pierde tras el parser del cuerpo (usa eventos del socket): por eso se
 * guarda en `res.locals.observacion` y `middlewareContexto` lo reabre después del parser.
 */
export function middlewareObservabilidad(obs: Observabilidad) {
  const { trazas, metricas } = obs;
  return (req: Request, res: Response, next: NextFunction): void => {
    middlewareRequestId(req, res, () => {
      const requestId = requestIdDe(res);
      const metodo = metodoNormalizado(req.method);
      const padre = trazas.contextoEntrante(req.headers.traceparent);
      // El nombre definitivo ("METHOD /plantilla") se pone al terminar, cuando se conoce la ruta
      const span = trazas.iniciar(
        metodo,
        SpanKind.SERVER,
        { 'http.request.method': metodo, 'quinde.request_id': requestId },
        padre,
      );
      const observacion: ObservacionPeticion = {
        span,
        contexto: trace.setSpan(padre, span).setValue(CLAVE_REQUEST_ID, requestId),
        inicio: process.hrtime.bigint(),
        bff: obs.bff,
        // El tracestate es de la traza del gateway: solo se reenvía si se continuó esa traza
        tracestate: trace.getSpanContext(padre)
          ? tracestateAcotado(req.headers.tracestate)
          : undefined,
      };
      res.locals.observacion = observacion;
      res.setHeader(CABECERA_TRACE_ID, span.spanContext().traceId);

      let cerrado = false;
      const cerrar = () => {
        if (cerrado) return;
        cerrado = true;
        const ruta = plantillaDeRuta(req.originalUrl);
        const status = res.statusCode;
        span.updateName(`${metodo} ${ruta ?? '__unmatched__'}`);
        span.setAttributes({
          'http.route': ruta ?? '__unmatched__',
          'http.response.status_code': status,
        });
        // En un span de servidor, solo un 5xx es error (un 4xx es culpa del cliente)
        if (status >= 500) marcarError(span, String(status));
        span.end();
        res.locals.rutaPlantilla = ruta;
        metricas.registrarServidor(
          metodo,
          ruta,
          status,
          Number(process.hrtime.bigint() - observacion.inicio) / 1e9,
        );
      };
      res.once('finish', cerrar);
      res.once('close', cerrar);

      trazas.enContexto(observacion.contexto, next);
    });
  };
}
