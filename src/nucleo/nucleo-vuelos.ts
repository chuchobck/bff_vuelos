import type { TrazaDeLlamada } from '../telemetria/llamada-core';
import { EntradaBusqueda, EstadoVueloDetalle, MapaAsientos, ResultadoBusqueda } from './modelo';

/** Lo que acompaña a cada llamada al core. */
export interface ContextoLlamada {
  /** Va al core como x-request-id (metadata en gRPC, X-Request-Id en REST). */
  requestId: string;
  /**
   * Solo la búsqueda la manda (x-device-fingerprint / X-Device-Fingerprint). Nunca se registra.
   */
  huella?: string;
  /**
   * De qué operación GraphQL cuelga la llamada (span CLIENT) y el tracestate del gateway. Sin esto
   * el span cuelga del contexto activo.
   */
  traza?: TrazaDeLlamada;
}

/**
 * El puerto hacia el core: las tres lecturas públicas. Lo implementan `NucleoGrpc` y `NucleoRest`
 * (se elige con CORE_TRANSPORT) y devuelven exactamente la misma forma (ver modelo.ts). Un fallo
 * sale siempre como `ErrorNucleo`.
 */
export interface NucleoVuelos {
  buscarVuelos(entrada: EntradaBusqueda, contexto: ContextoLlamada): Promise<ResultadoBusqueda>;
  mapaAsientos(
    offerId: string,
    segmentId: string,
    contexto: ContextoLlamada,
  ): Promise<MapaAsientos>;
  estadoVuelo(
    flightNumber: string,
    date: string,
    contexto: ContextoLlamada,
  ): Promise<EstadoVueloDetalle>;
}

/** Para /health/ready: ¿el core responde? Con gRPC es el estado del canal; con REST, su /health. */
export interface SondaNucleo {
  estaDisponible(): Promise<boolean>;
}

export const NUCLEO_VUELOS = Symbol('NUCLEO_VUELOS');
export const SONDA_NUCLEO = Symbol('SONDA_NUCLEO');
