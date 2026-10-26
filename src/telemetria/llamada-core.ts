import { context, Context, Span, SpanKind } from '@opentelemetry/api';
import { status as EstadoGrpc } from '@grpc/grpc-js';
import { marcarError, traceparentDe } from '../observabilidad/trazas';
import { SERVICIO_RPC, filtrarAtributosBff } from './atributos-bff';
import { Observabilidad } from './observabilidad';

/** Lo que `ClienteNucleo` le pasa a un adaptador para que la llamada cuelgue de la operación en curso. */
export interface TrazaDeLlamada {
  /** Contexto con el span INTERNAL de la operación activo: de él cuelga el span CLIENT. */
  padre: Context;
  /** El `tracestate` del gateway, si se continuó su traza. */
  tracestate?: string;
}

export type RpcDelCore = 'SearchFlights' | 'GetSeatMap' | 'GetFlightStatus';

/** La plantilla REST de cada RPC (OpenAPI del core), para el nombre del span CLIENT con REST. */
export const PLANTILLA_REST: Readonly<Record<RpcDelCore, { metodo: string; ruta: string }>> = {
  SearchFlights: { metodo: 'POST', ruta: '/flights/v1/search' },
  GetSeatMap: { metodo: 'GET', ruta: '/flights/v1/offers/{offerId}/seatmap' },
  GetFlightStatus: { metodo: 'GET', ruta: '/flights/v1/flights/{flightNumber}/status' },
};

/** `error.type` (lista cerrada del estándar) de un código gRPC: solo lo que es culpa del servicio. */
export function tipoDeErrorGrpc(codigo: number): string | undefined {
  if (codigo === EstadoGrpc.DEADLINE_EXCEEDED) return 'timeout';
  if (codigo === EstadoGrpc.UNAVAILABLE) return 'unavailable';
  if (
    codigo === EstadoGrpc.UNKNOWN ||
    codigo === EstadoGrpc.INTERNAL ||
    codigo === EstadoGrpc.UNIMPLEMENTED ||
    codigo === EstadoGrpc.DATA_LOSS
  ) {
    return '500';
  }
  return undefined;
}

/** `error.type` de una respuesta HTTP del core: solo un 5xx del upstream es error. */
export function tipoDeErrorHttp(status: number): string | undefined {
  return status >= 500 ? String(status) : undefined;
}

/**
 * Una llamada real al core, vista desde la observabilidad: un span CLIENT (después del DataLoader,
 * una por llamada que sale), el `traceparent` NUEVO que viaja al core (mismo trace-id, parent = este
 * span CLIENT) y la métrica `http_client_request_duration_seconds{upstream="core"}`.
 *
 * Con gRPC el span lleva `rpc.system`, `rpc.service`, `rpc.method` y `rpc.grpc.status_code`; con
 * REST, el método, la plantilla y el status HTTP. En la métrica, `method` es la RPC (SearchFlights,
 * GetSeatMap, GetFlightStatus: tres valores) y `status`, el código gRPC (o el HTTP con REST).
 *
 * Sin `Observabilidad` (las pruebas de los adaptadores solos) no hace nada.
 */
export class LlamadaCore {
  /** Para la metadata `traceparent` (gRPC) o la cabecera (REST). Undefined sin observabilidad. */
  readonly traceparent?: string;
  readonly tracestate?: string;
  private readonly inicio = process.hrtime.bigint();
  private terminada = false;

  private constructor(
    private readonly obs: Observabilidad | undefined,
    private readonly span: Span | undefined,
    private readonly rpc: RpcDelCore,
    private readonly transporte: 'grpc' | 'rest',
    tracestate: string | undefined,
  ) {
    if (span) {
      this.traceparent = traceparentDe(span);
      this.tracestate = tracestate;
    }
  }

  static abrir(
    obs: Observabilidad | undefined,
    transporte: 'grpc' | 'rest',
    rpc: RpcDelCore,
    traza: TrazaDeLlamada | undefined,
    requestId: string,
  ): LlamadaCore {
    if (!obs) return new LlamadaCore(undefined, undefined, rpc, transporte, undefined);
    const rest = PLANTILLA_REST[rpc];
    const span = obs.trazas.tracer.startSpan(
      transporte === 'grpc' ? `${SERVICIO_RPC}/${rpc}` : `${rest.metodo} ${rest.ruta}`,
      {
        kind: SpanKind.CLIENT,
        attributes: filtrarAtributosBff({
          'quinde.upstream': 'core',
          'quinde.request_id': requestId,
          ...(transporte === 'grpc'
            ? { 'rpc.system': 'grpc', 'rpc.service': SERVICIO_RPC, 'rpc.method': rpc }
            : { 'http.request.method': rest.metodo, 'http.route': rest.ruta }),
        }),
      },
      traza?.padre ?? context.active(),
    );
    return new LlamadaCore(obs, span, rpc, transporte, traza?.tracestate);
  }

  /**
   * Cierra la llamada. `codigo` es el código gRPC (0 = OK) o el status HTTP; `undefined` es que no
   * hubo respuesta (con REST: plazo vencido o sin conexión), con `tipoSinRespuesta`.
   */
  terminar(codigo: number | undefined, tipoSinRespuesta?: 'timeout' | 'unavailable'): void {
    if (this.terminada || !this.obs || !this.span) return;
    this.terminada = true;
    const tipo =
      codigo === undefined
        ? tipoSinRespuesta
        : this.transporte === 'grpc'
          ? tipoDeErrorGrpc(codigo)
          : tipoDeErrorHttp(codigo);
    if (codigo !== undefined) {
      this.span.setAttributes(
        filtrarAtributosBff(
          this.transporte === 'grpc'
            ? { 'rpc.grpc.status_code': codigo }
            : { 'http.response.status_code': codigo },
        ),
      );
    }
    if (tipo) marcarError(this.span, tipo);
    this.span.end();
    this.obs.metricas.duracionCliente.observe(
      {
        upstream: 'core',
        method: this.rpc,
        status: codigo === undefined ? 'error' : String(codigo),
      },
      Number(process.hrtime.bigint() - this.inicio) / 1e9,
    );
  }
}
