import { json } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Configuracion, CONFIGURACION } from './config/entorno';
import { RUTA_GRAPHQL } from './graphql/graphql.module';

/** Tope del cuerpo de una petición, como en el core: más grande no se lee. */
export const LIMITE_CUERPO = '100kb';

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y las
 * pruebas, para que probar el BFF sea probar el que de verdad se despliega.
 */
export function configurarApp(app: NestExpressApplication): void {
  const _configuracion = app.get<Configuracion>(CONFIGURACION);
  void _configuracion;
  app.use(RUTA_GRAPHQL, json({ limit: LIMITE_CUERPO }));
}
