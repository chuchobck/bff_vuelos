import {
  credentials,
  loadPackageDefinition,
  Metadata,
  ServiceError,
  status as EstadoGrpc,
  ServiceClientConstructor,
  Client,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Configuracion, CONFIGURACION } from '../../config/entorno';
import {
  CategoriaError,
  crearErrorNucleo,
  ErrorNucleo,
  leerProblemDetails,
  leerRetryAfter,
} from '../error-nucleo';
import { EntradaBusqueda, EstadoVueloDetalle, MapaAsientos, ResultadoBusqueda } from '../modelo';
import { LlamadaCore, RpcDelCore } from '../../telemetria/llamada-core';
import { Observabilidad, OBSERVABILIDAD } from '../../telemetria/observabilidad';
import { NORMALIZADOR_GRPC } from '../normalizacion';
import { ContextoLlamada, NucleoVuelos, SondaNucleo } from '../nucleo-vuelos';
import { OPCIONES_CARGA_PROTO, PAQUETE_GRPC, RUTA_PROTO, SERVICIO_GRPC } from './proto';

/** Metadata de la petición y de un error (docs/GRPC.md del core). */
const METADATA = {
  requestId: 'x-request-id',
  huella: 'x-device-fingerprint',
  problemaCodigo: 'problem-code',
  problemaStatus: 'problem-status',
  problemaDetalle: 'problem-details-bin',
  retryAfter: 'retry-after',
  traceparent: 'traceparent',
  tracestate: 'tracestate',
} as const;

/** Cuánto espera /health/ready a que el canal esté READY. */
const ESPERA_CANAL_MAXIMA_MS = 2000;

type Llamada<Respuesta> = (
  peticion: object,
  metadata: Metadata,
  opciones: { deadline: number },
  callback: (error: ServiceError | null, respuesta?: Respuesta) => void,
) => void;

interface ClienteFlights extends Client {
  SearchFlights: Llamada<unknown>;
  GetSeatMap: Llamada<unknown>;
  GetFlightStatus: Llamada<unknown>;
}

/**
 * El core por gRPC. Carga el proto una vez, abre un solo canal (HTTP/2 multiplexa todas las
 * llamadas) y le pone a cada llamada su plazo, el x-request-id y, en la búsqueda, la huella.
 */
@Injectable()
export class NucleoGrpc implements NucleoVuelos, SondaNucleo, OnModuleDestroy {
  private readonly cliente: ClienteFlights;

  constructor(
    @Inject(CONFIGURACION) private readonly configuracion: Configuracion,
    @Optional() @Inject(OBSERVABILIDAD) private readonly observabilidad?: Observabilidad,
  ) {
    const definicion = loadSync(RUTA_PROTO, OPCIONES_CARGA_PROTO);
    const paquete = PAQUETE_GRPC.split('.').reduce<Record<string, unknown>>(
      (nivel, nombre) => nivel[nombre] as Record<string, unknown>,
      loadPackageDefinition(definicion) as Record<string, unknown>,
    );
    const Servicio = paquete[SERVICIO_GRPC] as ServiceClientConstructor;
    // Sin TLS (createInsecure): el gRPC del core es interno (docs/GRPC.md del core)
    this.cliente = new Servicio(
      configuracion.grpcUrl,
      credentials.createInsecure(),
    ) as unknown as ClienteFlights;
  }

  async buscarVuelos(
    entrada: EntradaBusqueda,
    contexto: ContextoLlamada,
  ): Promise<ResultadoBusqueda> {
    const metadata = this.metadata(contexto);
    if (contexto.huella !== undefined) metadata.set(METADATA.huella, contexto.huella);
    const crudo = await this.llamar(
      this.cliente.SearchFlights,
      'SearchFlights',
      contexto,
      {
        itineraries: entrada.itineraries,
        passengers: sinNulos(entrada.passengers),
      },
      metadata,
    );
    return NORMALIZADOR_GRPC.busqueda(crudo);
  }

  async mapaAsientos(
    offerId: string,
    segmentId: string,
    contexto: ContextoLlamada,
  ): Promise<MapaAsientos> {
    const crudo = await this.llamar(
      this.cliente.GetSeatMap,
      'GetSeatMap',
      contexto,
      { offerId, segmentId },
      this.metadata(contexto),
    );
    return NORMALIZADOR_GRPC.mapaAsientos(crudo);
  }

  async estadoVuelo(
    flightNumber: string,
    date: string,
    contexto: ContextoLlamada,
  ): Promise<EstadoVueloDetalle> {
    const crudo = await this.llamar(
      this.cliente.GetFlightStatus,
      'GetFlightStatus',
      contexto,
      { flightNumber, date },
      this.metadata(contexto),
    );
    return NORMALIZADOR_GRPC.estadoVuelo(crudo);
  }

  /** El estado del canal: READY si conectó. Si no conecta en unos segundos, el core no responde. */
  estaDisponible(): Promise<boolean> {
    const espera = Math.min(this.configuracion.timeoutMs, ESPERA_CANAL_MAXIMA_MS);
    return new Promise((resolver) => {
      this.cliente.waitForReady(Date.now() + espera, (error) => resolver(!error));
    });
  }

  onModuleDestroy(): void {
    this.cliente.close();
  }

  private metadata(contexto: ContextoLlamada): Metadata {
    const metadata = new Metadata();
    metadata.set(METADATA.requestId, contexto.requestId);
    return metadata;
  }

  private llamar(
    metodo: Llamada<unknown>,
    rpc: RpcDelCore,
    contexto: ContextoLlamada,
    peticion: object,
    metadata: Metadata,
  ): Promise<unknown> {
    // Un span CLIENT por llamada real, y un traceparent NUEVO (mismo trace-id, parent = ese span)
    // junto al x-request-id: el core lo continúa, o lo ignora si aún no lo lee
    const llamada = LlamadaCore.abrir(
      this.observabilidad,
      'grpc',
      rpc,
      contexto.traza,
      contexto.requestId,
    );
    if (llamada.traceparent) metadata.set(METADATA.traceparent, llamada.traceparent);
    if (llamada.tracestate) metadata.set(METADATA.tracestate, llamada.tracestate);
    return new Promise((resolver, rechazar) => {
      // El plazo corre desde que se hace la llamada: CORE_TIMEOUT_MS en cada una
      const deadline = Date.now() + this.configuracion.timeoutMs;
      metodo.call(this.cliente, peticion, metadata, { deadline }, (error, respuesta) => {
        llamada.terminar(error ? error.code : EstadoGrpc.OK);
        if (error) rechazar(aErrorNucleo(error));
        else resolver(respuesta);
      });
    });
  }
}

/** Un campo sin valor no se manda: el core le pone el valor por defecto del contrato. */
function sinNulos(objeto: object): object {
  return Object.fromEntries(
    Object.entries(objeto).filter(([, valor]) => valor !== null && valor !== undefined),
  );
}

const CATEGORIA_POR_CODIGO: Readonly<Partial<Record<EstadoGrpc, CategoriaError>>> = {
  [EstadoGrpc.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [EstadoGrpc.NOT_FOUND]: 'NOT_FOUND',
  [EstadoGrpc.UNAVAILABLE]: 'UNAVAILABLE',
  [EstadoGrpc.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [EstadoGrpc.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
};

/**
 * Un error gRPC pasa a error de dominio. El core manda `problem-code`, `problem-status`,
 * `problem-details-bin` (el ProblemDetails en JSON UTF-8) y `retry-after`; los que agrega
 * grpc-js (UNAVAILABLE con el puerto cerrado, DEADLINE_EXCEEDED, UNIMPLEMENTED) no traen
 * `problem-*` y se explican solo por el código gRPC.
 */
export function aErrorNucleo(error: ServiceError): ErrorNucleo {
  const categoria = CATEGORIA_POR_CODIGO[error.code as EstadoGrpc] ?? 'INTERNAL';
  const metadata = error.metadata;
  const texto = (nombre: string): string | null => {
    const valor = metadata?.get(nombre)?.[0];
    return typeof valor === 'string' && valor !== '' ? valor : null;
  };

  let problema: ReturnType<typeof leerProblemDetails> | null = null;
  const binario = metadata?.get(METADATA.problemaDetalle)?.[0];
  if (Buffer.isBuffer(binario)) {
    try {
      problema = leerProblemDetails(JSON.parse(binario.toString('utf8')));
    } catch {
      // Un JSON roto no cambia nada: queda lo que dicen problem-code y problem-status
    }
  }

  const codigo = texto(METADATA.problemaCodigo);
  const estadoTexto = texto(METADATA.problemaStatus);
  const status = estadoTexto !== null && /^\d{3}$/.test(estadoTexto) ? Number(estadoTexto) : null;
  return crearErrorNucleo(categoria, problema, {
    problemCode: codigo !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(codigo) ? codigo : null,
    status,
    retryAfter: leerRetryAfter(texto(METADATA.retryAfter)),
    // Solo el nombre del código gRPC: el mensaje de grpc-js puede traer la dirección del core
    causa: `gRPC ${EstadoGrpc[error.code] ?? error.code}`,
  });
}
