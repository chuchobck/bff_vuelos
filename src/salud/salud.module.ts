import { Module } from '@nestjs/common';
import { NucleoModule } from '../nucleo/nucleo.module';
import { SaludController } from './salud.controller';

@Module({ imports: [NucleoModule], controllers: [SaludController] })
export class SaludModule {}
