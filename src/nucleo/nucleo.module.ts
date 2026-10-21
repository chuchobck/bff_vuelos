import { Module } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from '../config/entorno';
import { Observabilidad, OBSERVABILIDAD } from '../telemetria/observabilidad';
import { NucleoGrpc } from './grpc/nucleo-grpc';
import { NUCLEO_VUELOS, SONDA_NUCLEO } from './nucleo-vuelos';
import { NucleoRest } from './rest/nucleo-rest';

/**
 * Elige el adaptador con CORE_TRANSPORT. Solo se crea el elegido: con REST no se carga el proto
 * ni se abre ningún canal. El mismo objeto es el puerto y la sonda de /health/ready.
 */
@Module({
  providers: [
    {
      provide: NUCLEO_VUELOS,
      inject: [CONFIGURACION, OBSERVABILIDAD],
      useFactory: (configuracion: Configuracion, observabilidad: Observabilidad) =>
        configuracion.transporte === 'grpc'
          ? new NucleoGrpc(configuracion, observabilidad)
          : new NucleoRest(configuracion, observabilidad),
    },
    { provide: SONDA_NUCLEO, useExisting: NUCLEO_VUELOS },
  ],
  exports: [NUCLEO_VUELOS, SONDA_NUCLEO],
})
export class NucleoModule {}
