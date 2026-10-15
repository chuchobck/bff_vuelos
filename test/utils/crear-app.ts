import { LogLevel } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { Configuracion, validarEntorno } from '../../src/config/entorno';
import { configurarApp } from '../../src/configurar-app';
import { CoreFalso } from './core-falso';

/** Una configuración de pruebas apuntando al core falso, con ajustes encima. */
export function configuracionDePrueba(
  core: CoreFalso,
  ajustes: Partial<Configuracion> = {},
): Configuracion {
  const base = validarEntorno({
    NODE_ENV: 'test',
    CORE_TRANSPORT: core.transporte,
    CORE_GRPC_URL: core.configuracion().grpcUrl,
    CORE_REST_URL: core.configuracion().restUrl,
    // Plazos cortos: las pruebas de timeout no esperan los 8 s de producción
    CORE_TIMEOUT_MS: '1500',
  });
  return { ...base, ...ajustes };
}

export interface AppDePrueba {
  app: NestExpressApplication;
  servidor: Server;
  configuracion: Configuracion;
  /** Las líneas que escribió el logger de Nest (nivel, contexto y mensaje). */
  logs: string[];
  cerrar(): Promise<void>;
}

export interface OpcionesApp {
  core: CoreFalso;
  configuracion?: Partial<Configuracion>;
  /** Para cambiar un provider (el Reloj, por ejemplo). */
  sobrescribir?: { proveedor: unknown; valor: unknown }[];
}

/** Levanta el BFF de verdad (configurarApp incluido) sobre un puerto libre, con el logger capturado. */
export async function crearApp(opciones: OpcionesApp): Promise<AppDePrueba> {
  const configuracion = configuracionDePrueba(opciones.core, opciones.configuracion);
  let constructor = Test.createTestingModule({ imports: [AppModule.registrar(configuracion)] });
  for (const { proveedor, valor } of opciones.sobrescribir ?? []) {
    constructor = constructor.overrideProvider(proveedor).useValue(valor);
  }
  const modulo = await constructor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>({ bodyParser: false });

  const logs: string[] = [];
  const registrar = (nivel: LogLevel) => (mensaje: unknown, contexto?: string) =>
    void logs.push(
      `${nivel} [${contexto ?? ''}] ${typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje)}`,
    );
  app.useLogger({
    log: registrar('log'),
    error: registrar('error'),
    warn: registrar('warn'),
    debug: registrar('debug'),
    verbose: registrar('verbose'),
  });

  configurarApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  return {
    app,
    servidor: app.getHttpServer() as Server,
    configuracion,
    logs,
    cerrar: () => app.close(),
  };
}
