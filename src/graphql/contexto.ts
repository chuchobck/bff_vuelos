import { Request, Response } from 'express';
import { Configuracion } from '../config/entorno';
import { esHuellaValida } from '../common/huella';
import { resolverRequestId } from '../common/request-id';
import { NucleoVuelos } from '../nucleo/nucleo-vuelos';
import { ClienteNucleo } from './cliente-nucleo';

/**
 * El contexto de una petición GraphQL: se crea al llegar y no sobrevive a la respuesta. Nada
 * aquí se comparte entre peticiones (por eso el DataLoader también es de la petición).
 */
export interface ContextoGraphQL {
  req: Request;
  res: Response;
  requestId: string;
  /**
   * La cabecera X-Device-Fingerprint tal como llegó: `undefined` si falta; `null` si hay y no
   * cumple el formato. Solo searchFlights la exige. Nunca se registra ni vuelve en un error.
   */
  huella: string | null | undefined;
  /** El core, con el request id de la petición, el tope de llamadas y el DataLoader. */
  nucleo: ClienteNucleo;
}

export function crearContexto(
  req: Request,
  res: Response,
  nucleo: NucleoVuelos,
  configuracion: Configuracion,
): ContextoGraphQL {
  const requestId = resolverRequestId(req.headers['x-request-id']);
  const cabecera = req.headers['x-device-fingerprint'];
  const huella = cabecera === undefined ? undefined : esHuellaValida(cabecera) ? cabecera : null;
  return {
    req,
    res,
    requestId,
    huella,
    nucleo: new ClienteNucleo(nucleo, configuracion, requestId, huella ?? undefined),
  };
}
