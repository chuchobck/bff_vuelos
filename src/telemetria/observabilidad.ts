import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Configuracion } from '../config/entorno';
import { Metricas, servidorMetricas } from '../observabilidad/metricas';
import { Trazas } from '../observabilidad/trazas';

/** Token de inyección de Nest. */
export const OBSERVABILIDAD = Symbol('OBSERVABILIDAD');

/**
 * Las trazas y las métricas de este proceso (estándar de Quinde): se crean ANTES que la app de Nest
 * (el SDK de trazas siempre arranca, aunque no se exporte nada) y se cierran con ella.
 */
export class Observabilidad {
  readonly trazas: Trazas;
  readonly metricas: Metricas;
  private servidor?: Server;

  constructor(
    readonly config: Configuracion['observabilidad'],
    entorno: string,
    opciones: { esperaLoteMs?: number } = {},
  ) {
    this.trazas = new Trazas({
      servicio: config.servicio,
      version: config.version,
      entorno,
      endpointOtlp: config.endpointOtlp,
      muestreo: config.muestreo,
      confiarEntrante: config.confiarEntrante,
      esperaLoteMs: opciones.esperaLoteMs,
    });
    this.metricas = new Metricas({
      servicio: config.servicio,
      version: config.version,
      entorno,
    });
  }

  /**
   * Abre el servidor de `/metrics` en su puerto aparte (nunca el de la aplicación). Con 0, el
   * sistema elige uno (las pruebas); la configuración usa 0 para APAGARLO y por eso `main.ts`
   * solo llama a este método si `puertoMetricas > 0`. Devuelve el puerto en el que quedó.
   */
  async escuchar(puerto: number): Promise<number> {
    const servidor = servidorMetricas(this.metricas);
    await new Promise<void>((listo, fallo) => {
      servidor.once('error', fallo);
      servidor.listen(puerto, '0.0.0.0', () => listo());
    });
    this.servidor = servidor;
    return (servidor.address() as AddressInfo).port;
  }

  /** Cierra el servidor de métricas y envía lo que quede en la cola de spans (con tope de tiempo). */
  async cerrar(): Promise<void> {
    const servidor = this.servidor;
    this.servidor = undefined;
    if (servidor) {
      servidor.closeAllConnections();
      await new Promise<void>((listo) => servidor.close(() => listo()));
    }
    await this.trazas.cerrar();
  }
}
