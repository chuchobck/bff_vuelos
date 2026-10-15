import { Module } from '@nestjs/common';
import { Reloj } from '../common/reloj';
import { LimitadorPeticiones } from './limitador';

/** El reloj de la aplicación y el limitador que lo usa; las pruebas reemplazan el `Reloj`. */
@Module({
  providers: [Reloj, LimitadorPeticiones],
  exports: [Reloj, LimitadorPeticiones],
})
export class LimitesModule {}
