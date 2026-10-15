import {
  loadPackageDefinition,
  Metadata,
  Server,
  ServerCredentials,
  ServiceClientConstructor,
  status as EstadoGrpc,
  ServerUnaryCall,
  sendUnaryData,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { createServer, IncomingMessage, Server as ServidorHttp, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Configuracion, TransporteNucleo } from '../../src/config/entorno';
import {
  OPCIONES_CARGA_PROTO,
  PAQUETE_GRPC,
  RUTA_PROTO,
  SERVICIO_GRPC,
} from '../../src/nucleo/grpc/proto';
import { BUSQUEDA, ESTADO_VUELO, MAPA_ASIENTOS } from '../fixtures/core';

/**
 * Un core falso por transporte, para probar el BFF sin el core real: un servidor gRPC construido
 * desde el mismo proto y un servidor HTTP con las rutas REST del contrato. Los dos responden las
 * mismas fixtures (test/fixtures/core.ts) y fallan con los mismos errores, traducidos como lo hace
 * el core (docs/GRPC.md del core), para que un solo juego de pruebas corra contra los dos.
 */

export type Operacion = 'search' | 'seatMap' | 'status';

export type RespuestaFalsa =
  | { tipo: 'ok'; cuerpo?: unknown; retardoMs?: number }
  | {
      tipo: 'error';
      /** El status HTTP del ProblemDetails; en gRPC se traduce como el core. */
      status: number;
      code: string;
      detail?: string;
      invalidParams?: { name: string; reason: string }[];
      retryAfter?: number;
    };

export interface LlamadaRegistrada {
  operacion: Operacion;
  /** x-request-id (metadata) o X-Request-Id (cabecera). */
  requestId?: string;
  huella?: string;
  /** Lo que pidió el BFF, en la forma del contrato (JSON de REST / mensaje de gRPC). */
  peticion: Record<string, unknown>;
  /** Milisegundos de plazo que traía la llamada (deadline de gRPC). Solo gRPC. */
  plazoMs?: number;
}

export interface CoreFalso {
  readonly transporte: TransporteNucleo;
  readonly llamadas: LlamadaRegistrada[];
  /** Lo que hay que mezclar en la configuración del BFF para que apunte a este core. */
  configuracion(): Pick<Configuracion, 'transporte' | 'grpcUrl' | 'restUrl'>;
  responder(operacion: Operacion, respuesta: RespuestaFalsa): void;
  /** Cuántas llamadas recibió esa operación. */
  contar(operacion: Operacion): number;
  /** Borra las llamadas registradas y vuelve a responder las fixtures. */
  reiniciar(): void;
  detener(): Promise<void>;
}

const FIXTURE: Record<Operacion, unknown> = {
  search: BUSQUEDA,
  seatMap: MAPA_ASIENTOS,
  status: ESTADO_VUELO,
};

/** Estado gRPC de un status HTTP, igual que `codigoGrpc` del core. */
function codigoGrpc(status: number): EstadoGrpc {
  const tabla: Record<number, EstadoGrpc> = {
    400: EstadoGrpc.INVALID_ARGUMENT,
    401: EstadoGrpc.UNAUTHENTICATED,
    403: EstadoGrpc.PERMISSION_DENIED,
    404: EstadoGrpc.NOT_FOUND,
    409: EstadoGrpc.FAILED_PRECONDITION,
    410: EstadoGrpc.FAILED_PRECONDITION,
    422: EstadoGrpc.FAILED_PRECONDITION,
    413: EstadoGrpc.RESOURCE_EXHAUSTED,
    429: EstadoGrpc.RESOURCE_EXHAUSTED,
    503: EstadoGrpc.UNAVAILABLE,
  };
  return tabla[status] ?? (status >= 500 ? EstadoGrpc.INTERNAL : EstadoGrpc.INVALID_ARGUMENT);
}

function problemDetails(r: Extract<RespuestaFalsa, { tipo: 'error' }>) {
  return {
    type: 'about:blank',
    title: `Error ${r.status}`,
    status: r.status,
    ...(r.detail === undefined ? {} : { detail: r.detail }),
    code: r.code,
    ...(r.invalidParams ? { invalidParams: r.invalidParams } : {}),
  };
}

// --- gRPC -------------------------------------------------------------------------------------

/** El enum del proto de cada campo del contrato que lo es (nombre del campo → prefijo). */
const PREFIJOS_ENUM: Record<string, string> = {
  status: 'FLIGHT_STATUS',
  cabinClass: 'CABIN_CLASS',
  passengerType: 'PASSENGER_TYPE',
  characteristics: 'SEAT_CHARACTERISTIC',
};

/**
 * JSON del contrato → mensaje del proto, como los `*.grpc.ts` del core: enums con prefijo (null
 * pasa a *_UNSPECIFIED) y lo que es null en REST (un optional) no se manda.
 */
export function aMensajeProto(valor: unknown, campo?: string): unknown {
  if (Array.isArray(valor)) {
    return valor.map((v) =>
      campo === 'characteristics' ? enumeracion(campo, v) : aMensajeProto(v),
    );
  }
  if (typeof valor === 'object' && valor !== null) {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (clave in PREFIJOS_ENUM && clave !== 'characteristics') {
        salida[clave] = enumeracion(clave, v);
      } else if (v !== null && v !== undefined) {
        salida[clave] = aMensajeProto(v, clave);
      }
    }
    return salida;
  }
  return valor;
}

function enumeracion(clave: string, valor: unknown): string {
  const prefijo = PREFIJOS_ENUM[clave];
  return typeof valor === 'string' ? `${prefijo}_${valor}` : `${prefijo}_UNSPECIFIED`;
}

const METODO_GRPC: Record<Operacion, string> = {
  search: 'SearchFlights',
  seatMap: 'GetSeatMap',
  status: 'GetFlightStatus',
};

async function crearCoreGrpc(): Promise<CoreFalso> {
  const llamadas: LlamadaRegistrada[] = [];
  const respuestas = new Map<Operacion, RespuestaFalsa>();
  const temporizadores = new Set<NodeJS.Timeout>();

  const paquete = PAQUETE_GRPC.split('.').reduce<Record<string, unknown>>(
    (nivel, nombre) => nivel[nombre] as Record<string, unknown>,
    loadPackageDefinition(loadSync(RUTA_PROTO, OPCIONES_CARGA_PROTO)) as Record<string, unknown>,
  );
  const Servicio = paquete[SERVICIO_GRPC] as ServiceClientConstructor;

  const manejador =
    (operacion: Operacion) =>
    (
      llamada: ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: sendUnaryData<unknown>,
    ) => {
      const deadline = llamada.getDeadline();
      const plazoMs =
        deadline instanceof Date
          ? deadline.getTime() - Date.now()
          : Number.isFinite(deadline)
            ? Number(deadline) - Date.now()
            : undefined;
      llamadas.push({
        operacion,
        requestId: llamada.metadata.get('x-request-id')[0] as string | undefined,
        huella: llamada.metadata.get('x-device-fingerprint')[0] as string | undefined,
        peticion: llamada.request,
        plazoMs,
      });
      const respuesta = respuestas.get(operacion) ?? { tipo: 'ok' as const };
      const responder = () => {
        if (respuesta.tipo === 'ok') {
          callback(null, aMensajeProto(respuesta.cuerpo ?? FIXTURE[operacion]));
          return;
        }
        // Lo mismo que FiltroErroresGrpc del core: código gRPC y problem-* en la metadata
        const metadata = new Metadata();
        metadata.set('x-request-id', String(llamada.metadata.get('x-request-id')[0] ?? ''));
        metadata.set('problem-code', respuesta.code);
        metadata.set('problem-status', String(respuesta.status));
        metadata.set(
          'problem-details-bin',
          Buffer.from(JSON.stringify(problemDetails(respuesta)), 'utf8'),
        );
        if (respuesta.retryAfter !== undefined)
          metadata.set('retry-after', String(respuesta.retryAfter));
        callback({
          code: codigoGrpc(respuesta.status),
          details: respuesta.detail ?? `Error ${respuesta.status}`,
          metadata,
        });
      };
      if (respuesta.tipo === 'ok' && respuesta.retardoMs) {
        const t = setTimeout(() => {
          temporizadores.delete(t);
          responder();
        }, respuesta.retardoMs);
        temporizadores.add(t);
      } else {
        responder();
      }
    };

  const servidor = new Server();
  servidor.addService(Servicio.service, {
    [METODO_GRPC.search]: manejador('search'),
    [METODO_GRPC.seatMap]: manejador('seatMap'),
    [METODO_GRPC.status]: manejador('status'),
  });
  const puerto = await new Promise<number>((resolver, rechazar) =>
    servidor.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, p) =>
      error ? rechazar(error) : resolver(p),
    ),
  );

  return {
    transporte: 'grpc',
    llamadas,
    configuracion: () => ({
      transporte: 'grpc',
      grpcUrl: `127.0.0.1:${puerto}`,
      restUrl: undefined,
    }),
    responder: (operacion, respuesta) => void respuestas.set(operacion, respuesta),
    contar: (operacion) => llamadas.filter((l) => l.operacion === operacion).length,
    reiniciar: () => {
      llamadas.length = 0;
      respuestas.clear();
    },
    detener: async () => {
      temporizadores.forEach(clearTimeout);
      servidor.forceShutdown();
    },
  };
}

// --- REST -------------------------------------------------------------------------------------

async function crearCoreRest(): Promise<CoreFalso> {
  const llamadas: LlamadaRegistrada[] = [];
  const respuestas = new Map<Operacion, RespuestaFalsa>();
  const temporizadores = new Set<NodeJS.Timeout>();

  const enviar = (
    res: ServerResponse,
    status: number,
    cuerpo: unknown,
    tipo: string,
    cabeceras = {},
  ) => {
    res.writeHead(status, { 'Content-Type': tipo, ...cabeceras });
    res.end(JSON.stringify(cuerpo));
  };

  const atender = (
    operacion: Operacion,
    req: IncomingMessage,
    res: ServerResponse,
    peticion: Record<string, unknown>,
  ) => {
    llamadas.push({
      operacion,
      requestId: req.headers['x-request-id'] as string | undefined,
      huella: req.headers['x-device-fingerprint'] as string | undefined,
      peticion,
    });
    const respuesta = respuestas.get(operacion) ?? { tipo: 'ok' as const };
    const responder = () => {
      if (respuesta.tipo === 'ok') {
        enviar(res, 200, respuesta.cuerpo ?? FIXTURE[operacion], 'application/json');
      } else {
        enviar(
          res,
          respuesta.status,
          problemDetails(respuesta),
          'application/problem+json',
          respuesta.retryAfter === undefined ? {} : { 'Retry-After': String(respuesta.retryAfter) },
        );
      }
    };
    if (respuesta.tipo === 'ok' && respuesta.retardoMs) {
      const t = setTimeout(() => {
        temporizadores.delete(t);
        // El cliente ya pudo cortar la conexión por su plazo
        if (!res.destroyed) responder();
      }, respuesta.retardoMs);
      temporizadores.add(t);
    } else {
      responder();
    }
  };

  const servidor: ServidorHttp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://core.falso');
    const ruta = url.pathname;
    let cuerpo = '';
    req.on('data', (trozo) => (cuerpo += trozo));
    req.on('end', () => {
      const seatMap = /^\/flights\/v1\/offers\/([^/]+)\/seatmap$/.exec(ruta);
      const estado = /^\/flights\/v1\/flights\/([^/]+)\/status$/.exec(ruta);
      if (req.method === 'POST' && ruta === '/flights/v1/search') {
        atender('search', req, res, JSON.parse(cuerpo || '{}'));
      } else if (req.method === 'GET' && seatMap) {
        atender('seatMap', req, res, {
          offerId: decodeURIComponent(seatMap[1]),
          segmentId: url.searchParams.get('segmentId'),
        });
      } else if (req.method === 'GET' && estado) {
        atender('status', req, res, {
          flightNumber: decodeURIComponent(estado[1]),
          date: url.searchParams.get('date'),
        });
      } else if (req.method === 'GET' && ruta === '/flights/v1/health') {
        enviar(res, 200, { status: 'UP' }, 'application/json');
      } else {
        enviar(
          res,
          404,
          { type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND' },
          'application/problem+json',
        );
      }
    });
  });
  await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const puerto = (servidor.address() as AddressInfo).port;

  return {
    transporte: 'rest',
    llamadas,
    configuracion: () => ({
      transporte: 'rest',
      grpcUrl: 'localhost:50051',
      restUrl: `http://127.0.0.1:${puerto}`,
    }),
    responder: (operacion, respuesta) => void respuestas.set(operacion, respuesta),
    contar: (operacion) => llamadas.filter((l) => l.operacion === operacion).length,
    reiniciar: () => {
      llamadas.length = 0;
      respuestas.clear();
    },
    detener: () =>
      new Promise<void>((resolver) => {
        temporizadores.forEach(clearTimeout);
        servidor.closeAllConnections();
        servidor.close(() => resolver());
      }),
  };
}

export function crearCoreFalso(transporte: TransporteNucleo): Promise<CoreFalso> {
  return transporte === 'grpc' ? crearCoreGrpc() : crearCoreRest();
}
