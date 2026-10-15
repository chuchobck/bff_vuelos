import { Inject, Injectable } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from '../../config/entorno';
import {
  CategoriaError,
  crearErrorNucleo,
  ErrorNucleo,
  leerProblemDetails,
  leerRetryAfter,
} from '../error-nucleo';
import { EntradaBusqueda, EstadoVueloDetalle, MapaAsientos, ResultadoBusqueda } from '../modelo';
import { NORMALIZADOR_REST } from '../normalizacion';
import { ContextoLlamada, NucleoVuelos, SondaNucleo } from '../nucleo-vuelos';

/** Prefijo de todas las URLs del core (servers del OpenAPI). */
export const PREFIJO_REST = '/flights/v1';

/** Cuánto espera /health/ready a que el core conteste su /health. */
const ESPERA_SALUD_MAXIMA_MS = 3000;

/**
 * El core por REST (respaldo): las mismas tres operaciones contra CORE_REST_URL/flights/v1 con
 * el fetch nativo de Node. Misma salida y mismos errores que NucleoGrpc: el ProblemDetails del
 * core se lee como lo que en gRPC viaja por la metadata, y Retry-After como retry-after.
 */
@Injectable()
export class NucleoRest implements NucleoVuelos, SondaNucleo {
  private readonly base: string;

  constructor(@Inject(CONFIGURACION) private readonly configuracion: Configuracion) {
    if (!configuracion.restUrl)
      throw new Error('CORE_REST_URL es obligatoria con CORE_TRANSPORT=rest');
    this.base = `${configuracion.restUrl}${PREFIJO_REST}`;
  }

  async buscarVuelos(
    entrada: EntradaBusqueda,
    contexto: ContextoLlamada,
  ): Promise<ResultadoBusqueda> {
    const cabeceras = this.cabeceras(contexto);
    if (contexto.huella !== undefined) cabeceras['X-Device-Fingerprint'] = contexto.huella;
    cabeceras['Content-Type'] = 'application/json';
    const crudo = await this.pedir('/search', {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify({
        itineraries: entrada.itineraries,
        passengers: sinNulos(entrada.passengers),
      }),
    });
    return NORMALIZADOR_REST.busqueda(crudo);
  }

  async mapaAsientos(
    offerId: string,
    segmentId: string,
    contexto: ContextoLlamada,
  ): Promise<MapaAsientos> {
    const crudo = await this.pedir(
      `/offers/${encodeURIComponent(offerId)}/seatmap?segmentId=${encodeURIComponent(segmentId)}`,
      { method: 'GET', headers: this.cabeceras(contexto) },
    );
    return NORMALIZADOR_REST.mapaAsientos(crudo);
  }

  async estadoVuelo(
    flightNumber: string,
    date: string,
    contexto: ContextoLlamada,
  ): Promise<EstadoVueloDetalle> {
    const crudo = await this.pedir(
      `/flights/${encodeURIComponent(flightNumber)}/status?date=${encodeURIComponent(date)}`,
      { method: 'GET', headers: this.cabeceras(contexto) },
    );
    return NORMALIZADOR_REST.estadoVuelo(crudo);
  }

  /** GET {CORE_REST_URL}/flights/v1/health: 200 si el core y su base responden. */
  async estaDisponible(): Promise<boolean> {
    try {
      const respuesta = await fetch(`${this.base}/health`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.configuracion.timeoutMs, ESPERA_SALUD_MAXIMA_MS)),
      });
      await respuesta.arrayBuffer();
      return respuesta.ok;
    } catch {
      return false;
    }
  }

  private cabeceras(contexto: ContextoLlamada): Record<string, string> {
    return { Accept: 'application/json', 'X-Request-Id': contexto.requestId };
  }

  private async pedir(ruta: string, opciones: RequestInit): Promise<unknown> {
    try {
      // El plazo cubre la respuesta completa: cabeceras y cuerpo
      const respuesta = await fetch(`${this.base}${ruta}`, {
        ...opciones,
        redirect: 'error',
        signal: AbortSignal.timeout(this.configuracion.timeoutMs),
      });
      const texto = await respuesta.text();
      if (!respuesta.ok) throw aErrorNucleo(respuesta, texto);
      try {
        return JSON.parse(texto);
      } catch {
        throw crearErrorNucleo('INTERNAL', null, {
          problemCode: 'CORE_BAD_RESPONSE',
          status: 502,
          causa: 'respuesta del core inválida: el cuerpo no es JSON',
        });
      }
    } catch (error) {
      if (error instanceof ErrorNucleo) throw error;
      throw aErrorDeRed(error);
    }
  }
}

function sinNulos(objeto: object): object {
  return Object.fromEntries(
    Object.entries(objeto).filter(([, valor]) => valor !== null && valor !== undefined),
  );
}

function categoriaDeStatus(status: number): CategoriaError {
  if (status === 400) return 'INVALID_ARGUMENT';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413 || status === 429) return 'RESOURCE_EXHAUSTED';
  if (status === 502 || status === 503) return 'UNAVAILABLE';
  if (status === 504) return 'DEADLINE_EXCEEDED';
  return 'INTERNAL';
}

/** Un status HTTP de error con su ProblemDetails (si el cuerpo lo es) pasa a error de dominio. */
export function aErrorNucleo(respuesta: Response, cuerpo: string): ErrorNucleo {
  let problema: ReturnType<typeof leerProblemDetails> | null = null;
  try {
    problema = leerProblemDetails(JSON.parse(cuerpo));
  } catch {
    // Un proxy (Render dormido, 502) responde HTML: se explica solo por el status
  }
  return crearErrorNucleo(categoriaDeStatus(respuesta.status), problema, {
    status: respuesta.status,
    retryAfter: leerRetryAfter(respuesta.headers.get('retry-after')),
    causa: `HTTP ${respuesta.status}`,
  });
}

/** Sin respuesta: plazo vencido (AbortSignal.timeout) o conexión imposible. */
function aErrorDeRed(error: unknown): ErrorNucleo {
  const nombre = error instanceof Error ? error.name : '';
  if (nombre === 'TimeoutError' || nombre === 'AbortError') {
    return crearErrorNucleo('DEADLINE_EXCEEDED', null, { causa: 'plazo vencido' });
  }
  // El mensaje de fetch puede traer la dirección del core: solo se anota el tipo de error
  return crearErrorNucleo('UNAVAILABLE', null, { causa: `sin conexión (${nombre || 'error'})` });
}
