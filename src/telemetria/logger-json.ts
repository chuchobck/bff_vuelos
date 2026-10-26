import { LoggerService } from '@nestjs/common';
import { camposDeTraza } from '../observabilidad/trazas';

type Nivel = 'info' | 'warn' | 'error' | 'debug' | 'verbose';

/**
 * El logger de la app: una línea JSON por registro (estándar de Quinde, sección 3) con
 * `requestId`, `traceId` y `spanId` de la petición en curso, tomados del contexto activo y no de
 * la petición: también los llevan las líneas de código que no la recibe. Fuera de una petición
 * (el arranque) no hay ninguno.
 *
 * Un mensaje puede ser un texto o un objeto con los campos del registro (el log de acceso). Los
 * campos de traza van al final: ningún mensaje puede pisarlos.
 */
export class LoggerJson implements LoggerService {
  constructor(
    private readonly escribir: (linea: string) => void = (linea) => {
      process.stdout.write(`${linea}\n`);
    },
  ) {}

  log(mensaje: unknown, ...extras: unknown[]): void {
    this.emitir('info', mensaje, extras);
  }
  warn(mensaje: unknown, ...extras: unknown[]): void {
    this.emitir('warn', mensaje, extras);
  }
  error(mensaje: unknown, ...extras: unknown[]): void {
    this.emitir('error', mensaje, extras);
  }
  debug(mensaje: unknown, ...extras: unknown[]): void {
    this.emitir('debug', mensaje, extras);
  }
  verbose(mensaje: unknown, ...extras: unknown[]): void {
    this.emitir('verbose', mensaje, extras);
  }

  private emitir(nivel: Nivel, mensaje: unknown, extras: unknown[]): void {
    // Nest agrega el contexto ("Acceso") al final; en error, antes puede venir el stack
    const textos = extras.filter((e): e is string => typeof e === 'string');
    const contexto = textos.length > 0 ? textos[textos.length - 1] : undefined;
    const stack = nivel === 'error' && textos.length > 1 ? textos[0] : undefined;
    let cuerpo: Record<string, unknown>;
    if (mensaje instanceof Error) cuerpo = { msg: mensaje.message, stack: mensaje.stack };
    else if (typeof mensaje === 'object' && mensaje !== null) cuerpo = { ...mensaje };
    else cuerpo = { msg: String(mensaje) };
    this.escribir(
      JSON.stringify({
        level: nivel,
        time: new Date().toISOString(),
        ...(contexto ? { context: contexto } : {}),
        ...cuerpo,
        ...(stack ? { stack } : {}),
        ...camposDeTraza(),
      }),
    );
  }
}
