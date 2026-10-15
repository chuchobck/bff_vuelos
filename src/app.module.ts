import { DynamicModule, Module } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from './config/entorno';
import { GraphqlModule } from './graphql/graphql.module';
import { NucleoModule } from './nucleo/nucleo.module';

/**
 * Raíz de la aplicación. Recibe la configuración ya validada (en `main.ts` sale de
 * `process.env`; las pruebas pasan la suya), así que ningún módulo lee `process.env`.
 */
@Module({})
export class AppModule {
  static registrar(configuracion: Configuracion): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [NucleoModule, GraphqlModule],
      providers: [{ provide: CONFIGURACION, useValue: configuracion }],
      exports: [CONFIGURACION],
    };
  }
}
