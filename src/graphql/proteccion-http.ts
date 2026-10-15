import { NextFunction, Request, Response } from 'express';
import { Configuracion } from '../config/entorno';
import { LimitadorPeticiones } from '../limites/limitador';
import { responderErrorGraphQL } from './respuesta-http';

/**
 * Límite global por IP: toda petición a /graphql cuenta, sea cual sea la operación (100 por
 * minuto por defecto). Va antes del parser del cuerpo, así una petición rota o enorme también
 * cuenta. El límite por operación raíz lo pone PluginLimites, que ya sabe qué campos se piden.
 */
export function middlewareLimiteGlobal(
  limitador: LimitadorPeticiones,
  configuracion: Configuracion,
) {
  const ventanaMs = configuracion.limites.ventanaSegundos * 1000;
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = limitador.consumir(
      `global|${req.ip ?? 'desconocida'}`,
      1,
      configuracion.limites.global,
      ventanaMs,
    );
    if (r.permitido) return next();
    responderErrorGraphQL(res, 429, {
      message: `Too many requests; retry in ${r.reintentarEnSegundos} seconds`,
      code: 'TOO_MANY_REQUESTS',
      problemCode: 'RATE_LIMIT_EXCEEDED',
      retryAfter: r.reintentarEnSegundos,
    });
  };
}

/** Un lote de operaciones (un arreglo en el cuerpo) no se admite: una petición, una operación. */
export function rechazarLotes(req: Request, res: Response, next: NextFunction): void {
  if (!Array.isArray(req.body)) return next();
  responderErrorGraphQL(res, 400, {
    message: 'Batched operations are not supported; send one operation per request',
    code: 'BAD_USER_INPUT',
    problemCode: 'VALIDATION_FAILED',
  });
}

interface ErrorDeParser extends Error {
  type?: string;
  status?: number;
}

/** Los errores de body-parser (cuerpo grande, JSON roto, codificación) con la forma de GraphQL. */
export function manejarErrorDeCuerpo(
  error: ErrorDeParser,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') {
    return responderErrorGraphQL(res, 413, {
      message: 'The request body is too large; the maximum is 100 kB',
      code: 'BAD_USER_INPUT',
      problemCode: 'PAYLOAD_TOO_LARGE',
    });
  }
  if (
    error.status === 415 ||
    error.type === 'encoding.unsupported' ||
    error.type === 'charset.unsupported'
  ) {
    return responderErrorGraphQL(res, 415, {
      message: 'Unsupported content encoding or charset; use UTF-8 JSON',
      code: 'BAD_USER_INPUT',
      problemCode: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }
  // JSON roto, cuerpo abortado... Sin el mensaje del parser: puede citar un pedazo del cuerpo
  responderErrorGraphQL(res, 400, {
    message: 'The request body is not valid JSON',
    code: 'BAD_USER_INPUT',
    problemCode: 'VALIDATION_FAILED',
  });
}
