import { Controller, Get, Header, HttpStatus, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { Configuracion, CONFIGURACION } from '../config/entorno';
import { SONDA_NUCLEO, SondaNucleo } from '../nucleo/nucleo-vuelos';

/**
 * Salud del BFF. Fuera de /graphql: sin límite de peticiones (el sondeo periódico de Render viene
 * siempre de la misma IP), sin autenticación y sin datos de nadie.
 */
@Controller('health')
export class SaludController {
  constructor(
    @Inject(SONDA_NUCLEO) private readonly sonda: SondaNucleo,
    @Inject(CONFIGURACION) private readonly configuracion: Configuracion,
  ) {}

  /** Liveness: el proceso responde. No mira el core, para que Render no reinicie el BFF por él. */
  @Get()
  @Header('Cache-Control', 'no-store')
  vivo(): { status: 'UP' } {
    return { status: 'UP' };
  }

  /**
   * Readiness: 200 si el core responde, 503 si no. Con gRPC mira el estado del canal; con REST,
   * GET {CORE_REST_URL}/flights/v1/health.
   */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async listo(@Res({ passthrough: true }) res: Response) {
    const disponible = await this.sonda.estaDisponible();
    if (!disponible) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    const estado = disponible ? 'UP' : 'DOWN';
    return { status: estado, core: { transport: this.configuracion.transporte, status: estado } };
  }
}
