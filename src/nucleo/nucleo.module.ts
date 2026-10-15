import { Module } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from '../config/entorno';
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
      inject: [CONFIGURACION],
      useFactory: (configuracion: Configuracion) =>
        configuracion.transporte === 'grpc'
          ? new NucleoGrpc(configuracion)
          : new NucleoRest(configuracion),
    },
    { provide: SONDA_NUCLEO, useExisting: NUCLEO_VUELOS },
  ],
  exports: [NUCLEO_VUELOS, SONDA_NUCLEO],
})
export class NucleoModule {}
