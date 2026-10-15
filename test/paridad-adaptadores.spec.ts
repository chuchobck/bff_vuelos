import { validarEntorno } from '../src/config/entorno';
import { ErrorNucleo } from '../src/nucleo/error-nucleo';
import { NucleoGrpc } from '../src/nucleo/grpc/nucleo-grpc';
import {
  OPCIONES_CARGA_PROTO,
  PAQUETE_GRPC,
  RUTA_PROTO,
  SERVICIO_GRPC,
} from '../src/nucleo/grpc/proto';
import { NucleoRest } from '../src/nucleo/rest/nucleo-rest';
import { existsSync } from 'node:fs';
import { BUSQUEDA, ESTADO_VUELO, MAPA_ASIENTOS, OFFER_ID, SEGMENT_ID_1 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { configuracionDePrueba } from './utils/crear-app';

const CTX = { requestId: 'paridad-0001', huella: 'huella-de-paridad-01' };
const ENTRADA = {
  itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: '2026-10-22' }],
  passengers: { adults: 1, infants: null },
};

describe('el contrato gRPC copiado', () => {
  it('se carga con exactamente las OPCIONES_CARGA_PROTO del core', () => {
    // Las del core (src/config/grpc.ts de backend_vuelos): con otras, el cliente recibiría otra forma
    expect(OPCIONES_CARGA_PROTO).toEqual({
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: false,
    });
  });

  it('el proto está en contracts/ y declara el paquete y el servicio que usa el cliente', () => {
    expect(existsSync(RUTA_PROTO)).toBe(true);
    expect(`${PAQUETE_GRPC}.${SERVICIO_GRPC}`).toBe('quinde.flights.v1.FlightsService');
  });
});

describe('los dos adaptadores devuelven exactamente lo mismo', () => {
  let coreGrpc: CoreFalso;
  let coreRest: CoreFalso;
  let grpc: NucleoGrpc;
  let rest: NucleoRest;

  beforeAll(async () => {
    coreGrpc = await crearCoreFalso('grpc');
    coreRest = await crearCoreFalso('rest');
    grpc = new NucleoGrpc(configuracionDePrueba(coreGrpc));
    rest = new NucleoRest(configuracionDePrueba(coreRest));
  });

  afterAll(async () => {
    grpc.onModuleDestroy();
    await coreGrpc.detener();
    await coreRest.detener();
  });

  beforeEach(() => {
    coreGrpc.reiniciar();
    coreRest.reiniciar();
  });

  it('buscarVuelos', async () => {
    const [a, b] = await Promise.all([
      grpc.buscarVuelos(ENTRADA, CTX),
      rest.buscarVuelos(ENTRADA, CTX),
    ]);

    expect(a).toStrictEqual(b);
    expect(a.offers).toHaveLength(BUSQUEDA.offers.length);
  });

  it('mapaAsientos', async () => {
    const [a, b] = await Promise.all([
      grpc.mapaAsientos(OFFER_ID, SEGMENT_ID_1, CTX),
      rest.mapaAsientos(OFFER_ID, SEGMENT_ID_1, CTX),
    ]);

    expect(a).toStrictEqual(b);
    expect(a.cabins).toHaveLength(MAPA_ASIENTOS.cabins.length);
  });

  it('estadoVuelo', async () => {
    const [a, b] = await Promise.all([
      grpc.estadoVuelo('AV1500', '2026-10-22', CTX),
      rest.estadoVuelo('AV1500', '2026-10-22', CTX),
    ]);

    expect(a).toStrictEqual(b);
    expect(a.status).toBe(ESTADO_VUELO.status);
  });

  it('lo que falta es null, no undefined, en los dos', async () => {
    const [a, b] = await Promise.all([
      grpc.estadoVuelo('AV1500', '2026-10-22', CTX),
      rest.estadoVuelo('AV1500', '2026-10-22', CTX),
    ]);

    for (const estado of [a, b]) {
      expect(estado.aircraft).toBeNull();
      expect(estado.departure.actualAt).toBeNull();
      expect(estado.arrival.terminal).toBeNull();
    }
  });

  it.each([
    [400, 'VALIDATION_FAILED', 'INVALID_ARGUMENT', undefined],
    [404, 'FLIGHT_STATUS_NOT_AVAILABLE', 'NOT_FOUND', undefined],
    [413, 'PAYLOAD_TOO_LARGE', 'RESOURCE_EXHAUSTED', undefined],
    [429, 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED', 9],
    [503, 'SERVICE_UNAVAILABLE', 'UNAVAILABLE', 5],
    [409, 'SEAT_TAKEN', 'INTERNAL', undefined],
    [500, 'INTERNAL_ERROR', 'INTERNAL', undefined],
  ])(
    'un error %i del core es el mismo ErrorNucleo en gRPC y en REST',
    async (status, code, categoria, retryAfter) => {
      const error = {
        tipo: 'error' as const,
        status,
        code,
        detail: `detalle ${status}`,
        retryAfter,
      };
      coreGrpc.responder('status', error);
      coreRest.responder('status', error);

      const capturar = async (n: NucleoGrpc | NucleoRest) => {
        try {
          await n.estadoVuelo('AV1500', '2026-10-22', CTX);
        } catch (e) {
          return e as ErrorNucleo;
        }
        throw new Error('debía fallar');
      };
      const [a, b] = await Promise.all([capturar(grpc), capturar(rest)]);

      const datos = (e: ErrorNucleo) => ({
        categoria: e.categoria,
        problemCode: e.problemCode,
        status: e.status,
        detalle: e.detalle,
        retryAfter: e.retryAfter,
        invalidParams: e.invalidParams,
      });
      expect(datos(a)).toStrictEqual(datos(b));
      expect(datos(a)).toMatchObject({
        categoria,
        problemCode: code,
        status,
        detalle: `detalle ${status}`,
      });
      expect(a).toBeInstanceOf(ErrorNucleo);
      expect(b).toBeInstanceOf(ErrorNucleo);
    },
  );

  it('el mensaje de la excepción (para el log) no lleva el detalle del core ni direcciones', async () => {
    const error = {
      tipo: 'error' as const,
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'password=hunter2',
    };
    coreGrpc.responder('status', error);
    coreRest.responder('status', error);

    for (const nucleo of [grpc, rest]) {
      const e = await nucleo.estadoVuelo('AV1500', '2026-10-22', CTX).catch((x: Error) => x);
      expect((e as Error).message).not.toMatch(/hunter2|127\.0\.0\.1/);
    }
  });
});

describe('CORE_TRANSPORT elige el adaptador', () => {
  it('rest sin CORE_REST_URL no arranca', () => {
    expect(
      () => new NucleoRest(validarEntorno({ NODE_ENV: 'test', CORE_TRANSPORT: 'grpc' })),
    ).toThrow(/CORE_REST_URL/);
  });
});
