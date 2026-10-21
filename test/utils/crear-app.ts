import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { Configuracion, validarEntorno } from '../../src/config/entorno';
import { configurarApp } from '../../src/configurar-app';
import { LoggerJson } from '../../src/telemetria/logger-json';
import { Observabilidad } from '../../src/telemetria/observabilidad';
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
  /** Las líneas JSON que escribió el logger de la app (nivel, contexto, mensaje, requestId, traceId...). */
  logs: string[];
  /** Esas mismas líneas ya leídas. */
  registros(): Record<string, any>[];
  observabilidad: Observabilidad;
  /** Base de `/metrics` (el puerto aparte): `http://127.0.0.1:<puerto>`. */
  urlMetricas: string;
  cerrar(): Promise<void>;
}

export interface OpcionesApp {
  core: CoreFalso;
  configuracion?: Partial<Configuracion>;
  /** Base OTLP/HTTP de un recolector falso: sin ella, no se exporta (igual hay trace-id y propagación). */
  otlp?: string;
  /** Para cambiar un provider (el Reloj, por ejemplo). */
  sobrescribir?: { proveedor: unknown; valor: unknown }[];
}

/** Levanta el BFF de verdad (configurarApp incluido) sobre un puerto libre, con el logger capturado. */
export async function crearApp(opciones: OpcionesApp): Promise<AppDePrueba> {
  const base = configuracionDePrueba(opciones.core, opciones.configuracion);
  const configuracion: Configuracion = opciones.otlp
    ? { ...base, observabilidad: { ...base.observabilidad, endpointOtlp: opciones.otlp } }
    : base;
  // Los lotes de spans salen cada 50 ms para que las pruebas no esperen los 2 s de producción
  const observabilidad = new Observabilidad(configuracion.observabilidad, configuracion.entorno, {
    esperaLoteMs: 50,
  });
  let constructor = Test.createTestingModule({
    imports: [AppModule.registrar(configuracion, observabilidad)],
  });
  for (const { proveedor, valor } of opciones.sobrescribir ?? []) {
    constructor = constructor.overrideProvider(proveedor).useValue(valor);
  }
  const modulo = await constructor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>({ bodyParser: false });

  const logs: string[] = [];
  app.useLogger(new LoggerJson((linea) => void logs.push(linea)));

  configurarApp(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const puertoMetricas = await observabilidad.escuchar(0);
  return {
    app,
    servidor: app.getHttpServer() as Server,
    configuracion,
    logs,
    registros: () => logs.map((l) => JSON.parse(l)),
    observabilidad,
    urlMetricas: `http://127.0.0.1:${puertoMetricas}`,
    cerrar: () => app.close(),
  };
}
