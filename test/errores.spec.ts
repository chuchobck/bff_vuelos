import { Server, ServerCredentials } from '@grpc/grpc-js';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { TransporteNucleo } from '../src/config/entorno';
import { NUCLEO_VUELOS } from '../src/nucleo/nucleo-vuelos';
import { OFFER_ID, SEGMENT_ID_1 } from './fixtures/core';
import { CoreFalso, crearCoreFalso, Operacion, RespuestaFalsa } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import {
  consultar,
  Q_BUSQUEDA_COMPLETA,
  Q_ESTADO,
  Q_MAPA,
  Q_SOLO_OFFER_ID,
  Respuesta,
} from './utils/graphql';

const TRANSPORTES: TransporteNucleo[] = ['grpc', 'rest'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Los campos de extensions que todo error de GraphQL debe llevar. */
function comprobarForma(r: Respuesta, esperado: Record<string, unknown>): void {
  expect(r.body.errors).toHaveLength(1);
  const error = r.body.errors![0];
  expect(error.extensions).toMatchObject(esperado);
  expect(error.extensions.requestId).toBe(r.headers['x-request-id']);
  expect(error.extensions.requestId).toMatch(UUID);
  // Nunca el stack ni la excepción original
  expect(error.extensions).not.toHaveProperty('stacktrace');
  expect(error.extensions).not.toHaveProperty('exception');
  expect(JSON.stringify(r.body)).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/);
}

describe.each(TRANSPORTES)('errores del core por %s', (transporte) => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso(transporte);
    app = await crearApp({ core });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  beforeEach(() => core.reiniciar());

  const fallar = (operacion: Operacion, respuesta: Extract<RespuestaFalsa, { tipo: 'error' }>) =>
    core.responder(operacion, respuesta);

  it('NOT_FOUND del core es NOT_FOUND, con su problemCode y el detalle', async () => {
    fallar('status', {
      tipo: 'error',
      status: 404,
      code: 'FLIGHT_STATUS_NOT_AVAILABLE',
      detail: 'Flight ZZ9999 was not found on 2026-10-22',
    });

    const r = await consultar(app.servidor, Q_ESTADO);

    comprobarForma(r, {
      code: 'NOT_FOUND',
      problemCode: 'FLIGHT_STATUS_NOT_AVAILABLE',
      status: 404,
    });
    expect(r.body.errors![0].message).toBe('Flight ZZ9999 was not found on 2026-10-22');
    expect(r.body.errors![0].extensions).not.toHaveProperty('retryAfter');
    expect(r.body.data).toBeNull();
  });

  it('INVALID_ARGUMENT del core es BAD_USER_INPUT, con invalidParams', async () => {
    fallar('search', {
      tipo: 'error',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Request validation failed',
      invalidParams: [{ name: 'itineraries[0].origin', reason: 'must match ^[A-Z]{3}$' }],
    });

    const r = await consultar(app.servidor, Q_SOLO_OFFER_ID);

    comprobarForma(r, {
      code: 'BAD_USER_INPUT',
      problemCode: 'VALIDATION_FAILED',
      status: 400,
      invalidParams: [{ name: 'itineraries[0].origin', reason: 'must match ^[A-Z]{3}$' }],
    });
    expect(r.body.errors![0].message).toBe('Request validation failed');
  });

  it('UNAVAILABLE del core es SERVICE_UNAVAILABLE con el retryAfter del core, sin su mensaje', async () => {
    fallar('status', {
      tipo: 'error',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'The database is not responding',
      retryAfter: 7,
    });

    const r = await consultar(app.servidor, Q_ESTADO);

    comprobarForma(r, {
      code: 'SERVICE_UNAVAILABLE',
      problemCode: 'SERVICE_UNAVAILABLE',
      status: 503,
      retryAfter: 7,
    });
    expect(r.body.errors![0].message).toBe('The flights service is temporarily unavailable');
    expect(JSON.stringify(r.body)).not.toContain('database');
  });

  it('un UNAVAILABLE sin retry-after sugiere 5 segundos', async () => {
    fallar('status', { tipo: 'error', status: 503, code: 'SERVICE_UNAVAILABLE' });

    const r = await consultar(app.servidor, Q_ESTADO);

    comprobarForma(r, { code: 'SERVICE_UNAVAILABLE', retryAfter: 5 });
  });

  it('RESOURCE_EXHAUSTED del core es TOO_MANY_REQUESTS con retryAfter', async () => {
    fallar('status', {
      tipo: 'error',
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests; retry in 12 seconds',
      retryAfter: 12,
    });

    const r = await consultar(app.servidor, Q_ESTADO);

    comprobarForma(r, {
      code: 'TOO_MANY_REQUESTS',
      problemCode: 'RATE_LIMIT_EXCEEDED',
      status: 429,
      retryAfter: 12,
    });
  });

  it.each([
    [409, 'SEAT_TAKEN'],
    [422, 'INFANT_SEAT_NOT_ALLOWED'],
    [500, 'INTERNAL_ERROR'],
    [401, 'UNAUTHENTICATED'],
  ])(
    'un %i del core sale como INTERNAL_SERVER_ERROR con mensaje genérico y sin su detalle',
    async (status, code) => {
      fallar('status', {
        tipo: 'error',
        status,
        code,
        detail: 'detalle interno secreto: password=hunter2 en db.interna:5432',
      });

      const r = await consultar(app.servidor, Q_ESTADO);

      comprobarForma(r, { code: 'INTERNAL_SERVER_ERROR', problemCode: code, status });
      expect(r.body.errors![0].message).toBe('Internal server error');
      expect(JSON.stringify(r.body)).not.toMatch(/hunter2|db\.interna|secreto/);
    },
  );

  it('el plazo vencido es GATEWAY_TIMEOUT', async () => {
    const lento = await crearApp({ core, configuracion: { timeoutMs: 500 } });
    try {
      core.responder('status', { tipo: 'ok', retardoMs: 2500 });
      const inicio = Date.now();

      const r = await consultar(lento.servidor, Q_ESTADO);

      expect(Date.now() - inicio).toBeLessThan(2000);
      comprobarForma(r, { code: 'GATEWAY_TIMEOUT', problemCode: 'CORE_TIMEOUT', status: 504 });
      expect(r.body.errors![0].message).toBe('The flights service did not respond in time');
    } finally {
      await lento.cerrar();
    }
  });

  it('un mapa que falla deja null su campo y el resto de la búsqueda responde', async () => {
    fallar('seatMap', {
      tipo: 'error',
      status: 404,
      code: 'OFFER_NO_LONGER_AVAILABLE',
      detail: 'Offer expired',
    });

    const r = await consultar(
      app.servidor,
      `{ searchFlights(input: { itineraries: [{ origin: "UIO", destination: "GYE", departureDate: "2026-10-22" }], passengers: { adults: 1 } }) {
        offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
      } }`,
    );

    expect(r.body.data?.searchFlights.offers).toHaveLength(2);
    const segmento = r.body.data?.searchFlights.offers[0].itineraries[0].segments[0];
    expect(segmento.seatMap).toBeNull();
    expect(r.body.errors!.length).toBeGreaterThan(0);
    for (const error of r.body.errors!) {
      expect(error.extensions).toMatchObject({
        code: 'NOT_FOUND',
        problemCode: 'OFFER_NO_LONGER_AVAILABLE',
      });
      expect(error.path).toContain('seatMap');
    }
  });

  it('una respuesta del core con la forma rota es INTERNAL_SERVER_ERROR y no se filtra', async () => {
    core.responder('seatMap', {
      tipo: 'ok',
      cuerpo: { segmentId: SEGMENT_ID_1, cabins: 'no-es-una-lista' },
    });

    const r = await consultar(app.servidor, Q_MAPA(OFFER_ID, SEGMENT_ID_1));

    // En gRPC el core ni siquiera puede serializar el mensaje (INTERNAL); en REST llega el JSON roto
    comprobarForma(
      r,
      transporte === 'rest'
        ? { code: 'INTERNAL_SERVER_ERROR', problemCode: 'CORE_BAD_RESPONSE', status: 502 }
        : { code: 'INTERNAL_SERVER_ERROR', status: 500 },
    );
    expect(r.body.errors![0].message).toBe('Internal server error');
  });
});

describe.each(TRANSPORTES)('core caído por %s', (transporte) => {
  it('SERVICE_UNAVAILABLE con retryAfter, sin direcciones del core', async () => {
    const core = await crearCoreFalso(transporte);
    const app = await crearApp({ core });
    await core.detener();
    try {
      const r = await consultar(app.servidor, Q_ESTADO);

      comprobarForma(r, {
        code: 'SERVICE_UNAVAILABLE',
        problemCode: 'CORE_UNAVAILABLE',
        status: 503,
        retryAfter: 5,
      });
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|localhost/);
    } finally {
      await app.cerrar();
    }
  });
});

describe('fallos sin problem-* ni ProblemDetails', () => {
  it('gRPC: UNIMPLEMENTED (el core no tiene la RPC) es INTERNAL_SERVER_ERROR', async () => {
    const servidor = new Server(); // sin ningún servicio: toda RPC es UNIMPLEMENTED
    const puerto = await new Promise<number>((resolver, rechazar) =>
      servidor.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (e, p) =>
        e ? rechazar(e) : resolver(p),
      ),
    );
    const falso = {
      transporte: 'grpc',
      configuracion: () => ({
        transporte: 'grpc',
        grpcUrl: `127.0.0.1:${puerto}`,
        restUrl: undefined,
      }),
    } as unknown as CoreFalso;
    const app = await crearApp({ core: falso });
    try {
      const r = await consultar(app.servidor, Q_ESTADO);

      comprobarForma(r, { code: 'INTERNAL_SERVER_ERROR', status: 500 });
      expect(r.body.errors![0].message).toBe('Internal server error');
    } finally {
      await app.cerrar();
      servidor.forceShutdown();
    }
  });

  it.each([
    [502, 'SERVICE_UNAVAILABLE', 502],
    [503, 'SERVICE_UNAVAILABLE', 503],
    [504, 'GATEWAY_TIMEOUT', 504],
    [500, 'INTERNAL_SERVER_ERROR', 500],
  ])(
    'REST: un %i del proxy con HTML (Render dormido) es %s',
    async (statusHttp, codigo, statusEsperado) => {
      const proxy = createServer((_req, res) => {
        res.writeHead(statusHttp, { 'Content-Type': 'text/html' });
        res.end('<html><body>Render: service waking up (db.interna)</body></html>');
      });
      await new Promise<void>((resolver) => proxy.listen(0, '127.0.0.1', resolver));
      const puerto = (proxy.address() as AddressInfo).port;
      const falso = {
        transporte: 'rest',
        configuracion: () => ({
          transporte: 'rest',
          grpcUrl: 'localhost:50051',
          restUrl: `http://127.0.0.1:${puerto}`,
        }),
      } as unknown as CoreFalso;
      const app = await crearApp({ core: falso });
      try {
        const r = await consultar(app.servidor, Q_ESTADO);

        comprobarForma(r, { code: codigo, status: statusEsperado });
        expect(JSON.stringify(r.body)).not.toMatch(/Render|db\.interna/);
      } finally {
        await app.cerrar();
        proxy.closeAllConnections();
        await new Promise<void>((resolver) => proxy.close(() => resolver()));
      }
    },
  );

  it('una excepción inesperada (no del core) es INTERNAL_SERVER_ERROR genérico; el detalle solo va al log', async () => {
    const roto = {
      buscarVuelos: () => Promise.reject(new TypeError('boom: dato-interno-que-no-sale')),
      mapaAsientos: () => Promise.reject(new TypeError('boom: dato-interno-que-no-sale')),
      estadoVuelo: () => Promise.reject(new TypeError('boom: dato-interno-que-no-sale')),
    };
    const core = await crearCoreFalso('rest');
    const app = await crearApp({ core, sobrescribir: [{ proveedor: NUCLEO_VUELOS, valor: roto }] });
    try {
      const r = await consultar(app.servidor, Q_ESTADO);

      comprobarForma(r, {
        code: 'INTERNAL_SERVER_ERROR',
        problemCode: 'INTERNAL_ERROR',
        status: 500,
      });
      expect(r.body.errors![0].message).toBe('Internal server error');
      expect(JSON.stringify(r.body)).not.toContain('dato-interno-que-no-sale');
      // El log sí lo tiene, con el request id, para poder investigarlo
      const linea = app.logs.find((l) => l.includes('unexpected error'));
      expect(linea).toContain(r.headers['x-request-id']);
    } finally {
      await app.cerrar();
      await core.detener();
    }
  });
});

describe('errores que no son del core', () => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso('rest');
    app = await crearApp({ core });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  it('una consulta mal escrita lleva code, problemCode, status y requestId', async () => {
    const r = await consultar(app.servidor, '{ nada }');

    comprobarForma(r, {
      code: 'GRAPHQL_VALIDATION_FAILED',
      problemCode: 'VALIDATION_FAILED',
      status: 400,
    });
  });

  it('una sintaxis inválida lleva requestId', async () => {
    const r = await consultar(app.servidor, '{ flightStatus(');

    comprobarForma(r, { code: 'GRAPHQL_PARSE_FAILED', status: 400 });
  });

  it('una fecha inválida en una variable es BAD_USER_INPUT', async () => {
    const r = await consultar(
      app.servidor,
      'query($d: Date!) { flightStatus(flightNumber: "AV1500", date: $d) { status } }',
      { variables: { d: '2026-02-30' } },
    );

    comprobarForma(r, { code: 'BAD_USER_INPUT', status: 400 });
    expect(core.llamadas).toHaveLength(0);
  });

  it('el esquema completo no se cae con la búsqueda completa', async () => {
    const r = await consultar(app.servidor, Q_BUSQUEDA_COMPLETA);

    expect(r.body.errors).toBeUndefined();
  });
});
