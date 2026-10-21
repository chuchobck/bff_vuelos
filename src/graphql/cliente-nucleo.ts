import DataLoader from 'dataloader';
import { Configuracion } from '../config/entorno';
import {
  EntradaBusqueda,
  EstadoVueloDetalle,
  MapaAsientos,
  ResultadoBusqueda,
} from '../nucleo/modelo';
import { NucleoVuelos } from '../nucleo/nucleo-vuelos';
import { TrazaDeLlamada } from '../telemetria/llamada-core';
import { errorConsultaCostosa } from './errores';

export interface ClaveMapa {
  offerId: string;
  segmentId: string;
}

/**
 * El core visto desde una petición GraphQL. Lleva el x-request-id y la huella de la petición, y
 * cuenta cada llamada: al pasar CORE_MAX_LLAMADAS_POR_CONSULTA, la siguiente falla con
 * QUERY_TOO_EXPENSIVE sin llegar al core. Se crea uno por petición, nunca se comparte.
 *
 * El mapa de asientos pasa por un DataLoader de la petición: el mismo offerId y segmentId, pedido
 * desde donde sea (la raíz `seatMap` o `FlightSegment.seatMap`), es una sola llamada.
 */
export class ClienteNucleo {
  private llamadas = 0;
  private readonly cargadorMapas: DataLoader<ClaveMapa, MapaAsientos, string>;

  constructor(
    private readonly nucleo: NucleoVuelos,
    private readonly configuracion: Pick<Configuracion, 'maxLlamadasPorConsulta'>,
    private readonly requestId: string,
    private readonly huella: string | undefined,
    /** De qué operación cuelga cada llamada al core; se evalúa al llamar, no al construir. */
    private readonly traza: () => TrazaDeLlamada | undefined = () => undefined,
  ) {
    this.cargadorMapas = new DataLoader<ClaveMapa, MapaAsientos, string>(
      // Cada clave se resuelve (o falla) sola: un mapa que falla no tumba a los demás
      (claves) =>
        Promise.all(
          claves.map((clave) =>
            this.contar(() =>
              this.nucleo.mapaAsientos(clave.offerId, clave.segmentId, {
                requestId: this.requestId,
                traza: this.traza(),
              }),
            ).catch((error: unknown) =>
              error instanceof Error ? error : new Error('Unknown error'),
            ),
          ),
        ),
      { cacheKeyFn: (clave) => `${clave.offerId}\u0000${clave.segmentId}` },
    );
  }

  /** Llamadas hechas al core en esta petición. */
  get totalLlamadas(): number {
    return this.llamadas;
  }

  buscarVuelos(entrada: EntradaBusqueda): Promise<ResultadoBusqueda> {
    return this.contar(() =>
      this.nucleo.buscarVuelos(entrada, {
        requestId: this.requestId,
        huella: this.huella,
        traza: this.traza(),
      }),
    );
  }

  mapaAsientos(offerId: string, segmentId: string): Promise<MapaAsientos> {
    return this.cargadorMapas.load({ offerId, segmentId });
  }

  estadoVuelo(flightNumber: string, date: string): Promise<EstadoVueloDetalle> {
    return this.contar(() =>
      this.nucleo.estadoVuelo(flightNumber, date, {
        requestId: this.requestId,
        traza: this.traza(),
      }),
    );
  }

  private contar<T>(llamada: () => Promise<T>): Promise<T> {
    if (this.llamadas >= this.configuracion.maxLlamadasPorConsulta) {
      return Promise.reject(errorConsultaCostosa(this.configuracion.maxLlamadasPorConsulta));
    }
    this.llamadas += 1;
    return llamada();
  }
}
