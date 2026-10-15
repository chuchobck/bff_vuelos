import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validarEntorno } from './config/entorno';

async function arrancar() {
  // Si falta una variable o es inválida, lanza con su nombre (nunca su valor) y no arranca
  const configuracion = validarEntorno(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.registrar(configuracion));
  await app.listen(configuracion.puerto);
  new Logger('Arranque').log(
    `Escuchando en el puerto ${configuracion.puerto} (core por ${configuracion.transporte})`,
  );
}

arrancar().catch((error: unknown) => {
  // Solo el mensaje: ni stack ni valores de variables
  console.error(error instanceof Error ? error.message : 'No se pudo arrancar el BFF');
  process.exit(1);
});
