import { Request, Response } from 'express';
import { Configuracion } from '../config/entorno';
import { esHuellaValida } from '../common/huella';
import { NucleoVuelos } from '../nucleo/nucleo-vuelos';
import { ClienteNucleo } from './cliente-nucleo';
import { datosAccesoDe, requestIdDe } from './trazabilidad';

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
  // El id lo fijó middlewareRequestId al entrar: es el mismo que va al core y a la respuesta
  const requestId = requestIdDe(res);
  const cabecera = req.headers['x-device-fingerprint'];
  const huella = cabecera === undefined ? undefined : esHuellaValida(cabecera) ? cabecera : null;
  const cliente = new ClienteNucleo(nucleo, configuracion, requestId, huella ?? undefined);
  datosAccesoDe(res).llamadasAlNucleo = () => cliente.totalLlamadas;
  return { req, res, requestId, huella, nucleo: cliente };
}
