import { json } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RUTA_GRAPHQL } from './graphql/graphql.module';
import { middlewareAcceso, middlewareContexto, middlewareRequestId } from './graphql/trazabilidad';

/** Tope del cuerpo de una petición, como en el core: más grande no se lee. */
export const LIMITE_CUERPO = '100kb';

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y las
 * pruebas, para que probar el BFF sea probar el que de verdad se despliega.
 *
 * El orden de los middlewares importa:
 *   1. request id: antes que todo, para que hasta un error del parser lleve X-Request-Id
 *   2. log de acceso de /graphql
 *   3. parser del cuerpo
 *   4. contexto asíncrono: después del parser, que perdería el contexto si se abriera antes
 */
export function configurarApp(app: NestExpressApplication): void {
  app.use(middlewareRequestId);
  app.use(RUTA_GRAPHQL, middlewareAcceso);
  app.use(RUTA_GRAPHQL, json({ limit: LIMITE_CUERPO }));
  app.use(RUTA_GRAPHQL, middlewareContexto);
}
