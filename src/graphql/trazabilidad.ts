import { context } from '@opentelemetry/api';
import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { contextoPeticion } from '../common/contexto-peticion';
import { CABECERA_REQUEST_ID, resolverRequestId } from '../common/request-id';
import { observacionDe } from '../telemetria/observacion';

/**
 * Lo que el log de acceso necesita saber de la petición, y que el contexto GraphQL y los plugins
 * van dejando en `res.locals.acceso`.
 */
export interface DatosAcceso {
  /** Nombre de la operación, solo si es un identificador GraphQL (si no, null). */
  operationName: string | null;
  /** Llamadas hechas al core hasta ahora. */
  llamadasAlNucleo: () => number;
}

const NOMBRE_OPERACION = /^[_A-Za-z][_0-9A-Za-z]{0,63}$/;

/** El nombre de la operación es texto del cliente: solo pasa si es un nombre GraphQL válido. */
export function nombreOperacionSeguro(nombre: unknown): string | null {
  return typeof nombre === 'string' && NOMBRE_OPERACION.test(nombre) ? nombre : null;
}

export function requestIdDe(res: Response): string {
  return res.locals.requestId as string;
}

export function datosAccesoDe(res: Response): DatosAcceso {
  if (!res.locals.acceso) {
    res.locals.acceso = { operationName: null, llamadasAlNucleo: () => 0 } satisfies DatosAcceso;
  }
  return res.locals.acceso as DatosAcceso;
}

/**
 * Primer middleware de todos: fija el x-request-id de la petición con las reglas del core (el del
 * cliente si son de 8 a 64 letras, dígitos, `.`, `_` o `-`; si falta o no vale, un UUID) y lo
 * devuelve en la cabecera X-Request-Id, también en una respuesta de error de CORS o del parser.
 */
export function middlewareRequestId(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolverRequestId(req.headers['x-request-id']);
  res.locals.requestId = requestId;
  res.setHeader(CABECERA_REQUEST_ID, requestId);
  next();
}

const logger = new Logger('Acceso');

/**
 * Una línea de log por petición a /graphql, al terminar la respuesta: método, plantilla de la ruta,
 * estado, operationName (solo si es un nombre GraphQL), duración y llamadas al core. El requestId,
 * el traceId y el spanId los pone el logger desde el contexto, que aquí se reabre a mano porque el
 * evento 'finish' no corre en el de la petición. Nada más: ni la huella, ni los argumentos, ni las
 * cabeceras, ni el cuerpo, ni la IP.
 */
export function middlewareAcceso(req: Request, res: Response, next: NextFunction): void {
  const inicio = process.hrtime.bigint();
  let registrada = false;
  // 'finish' llega cuando la respuesta salió; 'close' cubre al cliente que cortó antes
  const registrar = () => {
    if (registrada) return;
    registrada = true;
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    const acceso = datosAccesoDe(res);
    const linea = () =>
      logger.log({
        msg: 'acceso',
        metodo: req.method,
        ruta: req.baseUrl,
        status: res.statusCode,
        op: acceso.operationName ?? '-',
        ms: Number(ms.toFixed(1)),
        llamadasAlNucleo: acceso.llamadasAlNucleo(),
      });
    const observacion = observacionDe(res);
    if (observacion) context.with(observacion.contexto, linea);
    else linea();
  };
  res.once('finish', registrar);
  res.once('close', registrar);
  next();
}

/**
 * Abre el contexto asíncrono con el request id; va después del parser del cuerpo, que perdería el
 * contexto si se abriera antes. Aquí también se reabre el de las trazas (span SERVER activo): así
 * Apollo, los resolvers y los logs de lo que sigue lo ven.
 */
export function middlewareContexto(_req: Request, res: Response, next: NextFunction): void {
  const abrir = () => contextoPeticion.run({ requestId: requestIdDe(res) }, next);
  const observacion = observacionDe(res);
  if (observacion) context.with(observacion.contexto, abrir);
  else abrir();
}
