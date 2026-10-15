import { Response } from 'express';
import { requestIdDe } from './trazabilidad';

/**
 * Responde un error HTTP con la forma de un error GraphQL (`{ errors: [...] }`), para lo que se
 * rechaza antes de llegar a Apollo: el límite global, un cuerpo demasiado grande o roto, un lote.
 * Lleva el mismo `extensions` que el resto: code, problemCode, status y requestId.
 */
export function responderErrorGraphQL(
  res: Response,
  status: number,
  error: {
    message: string;
    code: string;
    problemCode: string;
    retryAfter?: number;
  },
): void {
  if (error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
  res.status(status).json({
    errors: [
      {
        message: error.message,
        extensions: {
          code: error.code,
          problemCode: error.problemCode,
          status,
          requestId: requestIdDe(res),
          ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
        },
      },
    ],
  });
}
