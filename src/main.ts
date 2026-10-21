import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validarEntorno } from './config/entorno';
import { configurarApp } from './configurar-app';
import { LoggerJson } from './telemetria/logger-json';
import { Observabilidad } from './telemetria/observabilidad';

async function arrancar() {
  // Si falta una variable o es inválida, lanza con su nombre (nunca su valor) y no arranca
  const configuracion = validarEntorno(process.env);
  // Las trazas arrancan antes que la app: el SDK siempre está activo, aunque no se exporte nada
  const observabilidad = new Observabilidad(configuracion.observabilidad, configuracion.entorno);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.registrar(configuracion, observabilidad),
    // El cuerpo lo lee el parser propio de /graphql (con tope de 100 kB), no el de Nest
    { bodyParser: false, bufferLogs: true },
  );
  // JSON con traceId y spanId en cada línea (estándar de observabilidad, sección 3)
  app.useLogger(new LoggerJson());
  configurarApp(app);
  app.enableShutdownHooks();
  await app.listen(configuracion.puerto);
  const log = new Logger('Arranque');
  const { puertoMetricas } = configuracion.observabilidad;
  if (puertoMetricas > 0) {
    await observabilidad.escuchar(puertoMetricas);
    log.log(`Métricas en el puerto ${puertoMetricas} (aparte del público)`);
  } else {
    log.log('Métricas apagadas (METRICS_PORT=0)');
  }
  log.log(`Escuchando en el puerto ${configuracion.puerto} (core por ${configuracion.transporte})`);
}

arrancar().catch((error: unknown) => {
  // Solo el mensaje: ni stack ni valores de variables
  console.error(error instanceof Error ? error.message : 'No se pudo arrancar el BFF');
  process.exit(1);
});
