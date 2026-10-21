import { Context, Span } from '@opentelemetry/api';
import { Response } from 'express';

/** Lo que la observabilidad sabe de una petición; vive en `res.locals.observacion`. */
export interface ObservacionPeticion {
  /** El span SERVER de la petición. */
  span: Span;
  /** El contexto con el span SERVER activo y el request id (el que usan los logs). */
  contexto: Context;
  inicio: bigint;
  /** El `tracestate` del gateway, solo si se continuó su traza; se reenvía al core. */
  tracestate?: string;
  /** El span INTERNAL de la operación GraphQL, desde que se resuelve hasta que se responde. */
  operacion?: Span;
}

export function observacionDe(res: Response): ObservacionPeticion | undefined {
  return res.locals.observacion as ObservacionPeticion | undefined;
}
