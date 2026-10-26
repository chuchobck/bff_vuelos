import { DynamicModule, Injectable, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from './config/entorno';
import { GraphqlModule } from './graphql/graphql.module';
import { LimitesModule } from './limites/limites.module';
import { NucleoModule } from './nucleo/nucleo.module';
import { SaludModule } from './salud/salud.module';
import { Observabilidad, OBSERVABILIDAD } from './telemetria/observabilidad';

/** Cierra las trazas (envía lo que quede en la cola) y el puerto de métricas con la app. */
@Injectable()
export class CicloObservabilidad implements OnApplicationShutdown {
  constructor(@Inject(OBSERVABILIDAD) private readonly observabilidad: Observabilidad) {}

  async onApplicationShutdown(): Promise<void> {
    await this.observabilidad.cerrar();
  }
}

/**
 * Raíz de la aplicación. Recibe la configuración ya validada (en `main.ts` sale de
 * `process.env`; las pruebas pasan la suya), así que ningún módulo lee `process.env`.
 */
@Module({})
export class AppModule {
  static registrar(configuracion: Configuracion, observabilidad: Observabilidad): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [LimitesModule, NucleoModule, GraphqlModule, SaludModule],
      providers: [
        { provide: CONFIGURACION, useValue: configuracion },
        { provide: OBSERVABILIDAD, useValue: observabilidad },
        CicloObservabilidad,
      ],
      exports: [CONFIGURACION, OBSERVABILIDAD],
    };
  }
}
