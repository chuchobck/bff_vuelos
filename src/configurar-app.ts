import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import helmet from 'helmet';
import { Configuracion, CONFIGURACION } from './config/entorno';
import { RUTA_GRAPHQL } from './graphql/graphql.module';
import {
  manejarErrorDeCuerpo,
  middlewareLimiteGlobal,
  rechazarLotes,
} from './graphql/proteccion-http';
import { middlewareAcceso, middlewareContexto } from './graphql/trazabilidad';
import { LimitadorPeticiones } from './limites/limitador';
import { middlewareObservabilidad } from './telemetria/middleware';
import { Observabilidad, OBSERVABILIDAD } from './telemetria/observabilidad';

/** Tope del cuerpo de una petición, como en el core: más grande no se lee. */
export const LIMITE_CUERPO = '100kb';

/** Cabeceras que un navegador puede enviar al BFF desde un origen permitido. */
export const CABECERAS_PERMITIDAS = ['content-type', 'x-request-id', 'x-device-fingerprint'];

/** Cabeceras de la respuesta que el navegador deja leer al código del origen permitido. */
export const CABECERAS_EXPUESTAS = ['x-request-id', 'x-trace-id', 'retry-after'];

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y las
 * pruebas, para que probar el BFF sea probar el que de verdad se despliega.
 *
 * El orden de los middlewares importa:
 *   1. observabilidad: request id, span SERVER y X-Trace-Id antes que todo, para que hasta un error
 *      de CORS o del parser los lleve
 *   2. helmet y CORS
 *   3. (solo /graphql) log de acceso, límite global por IP, parser del cuerpo con su manejador de
 *      errores, rechazo de lotes y contexto asíncrono, que va después del parser porque este
 *      perdería el contexto si se abriera antes
 */
export function configurarApp(app: NestExpressApplication): void {
  const configuracion = app.get<Configuracion>(CONFIGURACION);
  const limitador = app.get(LimitadorPeticiones);
  const observabilidad = app.get<Observabilidad>(OBSERVABILIDAD);

  // Antes del primer middleware: de esto depende que `req.ip` sea la IP del cliente
  app.set('trust proxy', configuracion.trustProxy);
  app.disable('x-powered-by');

  // Primero de todos: request id, span SERVER, X-Trace-Id y métrica del servidor (estándar, sección 5)
  app.use(middlewareObservabilidad(observabilidad));
  app.use(
    helmet({
      // El landing del sandbox (solo si la introspección está encendida) carga scripts de un CDN
      // y se rompe con la CSP por defecto; el BFF solo responde JSON, así que sin landing se queda
      // con la política estricta de helmet.
      contentSecurityPolicy: configuracion.introspeccion ? false : undefined,
    }),
  );
  // Sin cookies ni `credentials`: una lista vacía no deja pasar ningún origen de navegador
  app.enableCors({
    origin: configuracion.corsOrigenes,
    methods: ['GET', 'POST'],
    allowedHeaders: CABECERAS_PERMITIDAS,
    exposedHeaders: CABECERAS_EXPUESTAS,
    maxAge: 600,
  });

  app.use(RUTA_GRAPHQL, middlewareAcceso);
  app.use(RUTA_GRAPHQL, middlewareLimiteGlobal(limitador, configuracion));
  app.use(RUTA_GRAPHQL, json({ limit: LIMITE_CUERPO }), manejarErrorDeCuerpo);
  app.use(RUTA_GRAPHQL, rechazarLotes);
  app.use(RUTA_GRAPHQL, middlewareContexto);
}
