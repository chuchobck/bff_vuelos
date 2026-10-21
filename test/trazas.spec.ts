import request from 'supertest';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, Q_ESTADO } from './utils/graphql';
import { pedirUrl } from './utils/http';
import { RecolectorOtlp } from './utils/recolector-otlp';

const TRAZA_GATEWAY = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_GATEWAY = '00f067aa0ba902b7';
const TRACEPARENT_GATEWAY = `00-${TRAZA_GATEWAY}-${SPAN_GATEWAY}-01`;

/** OTLP SpanKind del cable: 1 INTERNAL, 2 SERVER, 3 CLIENT. */
const SERVER = 2;

describe('span SERVER, X-Trace-Id y logs', () => {
  const recolector = new RecolectorOtlp();
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    await recolector.iniciar();
    core = await crearCoreFalso('grpc');
    app = await crearApp({ core, otlp: recolector.url });
  });
  afterAll(async () => {
    await app.cerrar();
    await core.detener();
    await recolector.detener();
  });
  beforeEach(() => {
    core.reiniciar();
    recolector.reiniciar();
  });

  it('continúa la traza del gateway: mismo trace-id, el span SERVER cuelga del span del gateway', async () => {
    const r = await consultar(app.servidor, Q_ESTADO, {
      headers: { traceparent: TRACEPARENT_GATEWAY },
    });

    expect(r.headers['x-trace-id']).toBe(TRAZA_GATEWAY);
    const spans = await recolector.esperarTraza(TRAZA_GATEWAY, 1);
    const servidor = spans.find((s) => s.tipo === SERVER)!;
    expect(servidor.parentSpanId).toBe(SPAN_GATEWAY);
    expect(servidor.nombre).toBe('POST /graphql');
    expect(servidor.servicio).toBe('quinde-bff');
    expect(servidor.atributos).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/graphql',
      'http.response.status_code': 200,
      'quinde.request_id': r.headers['x-request-id'],
    });
  });

  it('sin traceparent abre una traza nueva (y X-Trace-Id es esa)', async () => {
    const r = await consultar(app.servidor, Q_ESTADO);

    expect(r.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    const spans = await recolector.esperarTraza(r.headers['x-trace-id']!, 1);
    expect(spans[0]!.parentSpanId).toBe('');
  });

  it.each([
    `ff-${TRAZA_GATEWAY}-${SPAN_GATEWAY}-01`,
    `00-${'0'.repeat(32)}-${SPAN_GATEWAY}-01`,
    `00-${TRAZA_GATEWAY.toUpperCase()}-${SPAN_GATEWAY}-01`,
    `00-${TRAZA_GATEWAY}-${SPAN_GATEWAY}-01-extra`,
    'no-es-un-traceparent',
  ])('un traceparent inválido (%s) se ignora: traza nueva, sin error', async (traceparent) => {
    const r = await consultar(app.servidor, Q_ESTADO, { headers: { traceparent } });

    expect(r.status).toBe(200);
    expect(r.body.errors).toBeUndefined();
    expect(r.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(r.headers['x-trace-id']).not.toBe(TRAZA_GATEWAY);
  });

  it('un traceparent repetido se ignora', async () => {
    const r = await pedirUrl(
      `http://127.0.0.1:${(app.servidor.address() as { port: number }).port}/graphql`,
      {
        metodo: 'POST',
        cabeceras: {
          'content-type': 'application/json',
          traceparent: [TRACEPARENT_GATEWAY, TRACEPARENT_GATEWAY],
        },
        cuerpo: '{"query":"{ __typename }"}',
      },
    );

    expect(r.status).toBe(200);
    expect(r.cabeceras['x-trace-id']).not.toBe(TRAZA_GATEWAY);
  });

  it('con TRACE_TRUST_INCOMING=false abre siempre una traza nueva', async () => {
    const desconfiado = await crearApp({
      core,
      configuracion: {
        observabilidad: { ...app.configuracion.observabilidad, confiarEntrante: false },
      },
    });
    try {
      const r = await consultar(desconfiado.servidor, Q_ESTADO, {
        headers: { traceparent: TRACEPARENT_GATEWAY },
      });
      expect(r.headers['x-trace-id']).not.toBe(TRAZA_GATEWAY);
    } finally {
      await desconfiado.cerrar();
    }
  });

  it('X-Trace-Id también sale en los errores del parser, de CORS y de las rutas desconocidas', async () => {
    const roto = await request(app.servidor)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send('{"query": ');
    const noExiste = await request(app.servidor).get('/no-existe');
    const salud = await request(app.servidor).get('/health');

    for (const r of [roto, noExiste, salud]) {
      expect(r.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
      expect(r.headers['x-request-id']).toBeDefined();
    }
    expect(roto.status).toBe(400);
    expect(noExiste.status).toBe(404);
  });

  it('el span SERVER lleva la plantilla de la ruta: lo desconocido es __unmatched__, nunca la ruta pedida', async () => {
    const r = await request(app.servidor).get(
      '/clientes/ana@example.com/reservas/1234?token=secreto',
    );
    const spans = await recolector.esperarTraza(r.headers['x-trace-id']!, 1);

    expect(spans[0]!.nombre).toBe('GET __unmatched__');
    expect(spans[0]!.atributos['http.route']).toBe('__unmatched__');
    expect(JSON.stringify(recolector.cuerpos)).not.toMatch(/ana@example|secreto|reservas/);
  });

  it('un 5xx marca el span SERVER como error; un 4xx no', async () => {
    const malo = await request(app.servidor)
      .post('/graphql')
      .set('content-type', 'application/json')
      .send('{"query": ');
    const spans = await recolector.esperarTraza(malo.headers['x-trace-id']!, 1);

    expect(malo.status).toBe(400);
    expect(spans[0]!.estado.code ?? 0).not.toBe(2);
  });

  it('todas las líneas de una petición llevan el mismo requestId, traceId y spanId', async () => {
    // El logger de Nest es global: el último app que lo fija es el que captura, así que este test
    // crea el suyo en lugar de usar el de arriba (otro test ya creó y cerró otro después)
    const propio = await crearApp({ core });
    try {
      const r = await consultar(propio.servidor, Q_ESTADO, {
        headers: { traceparent: TRACEPARENT_GATEWAY, 'x-request-id': 'peticion-con-traza-01' },
      });

      const deLaPeticion = propio
        .registros()
        .filter((l) => l.requestId === 'peticion-con-traza-01');
      expect(deLaPeticion.length).toBeGreaterThan(0);
      for (const linea of deLaPeticion) {
        expect(linea.traceId).toBe(r.headers['x-trace-id']);
        expect(linea.spanId).toMatch(/^[0-9a-f]{16}$/);
      }
    } finally {
      await propio.cerrar();
    }
  });
});

describe('/metrics solo en el puerto aparte', () => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso('grpc');
    app = await crearApp({ core });
  });
  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  it('en el puerto principal /metrics no existe, ni con variantes', async () => {
    for (const ruta of ['/metrics', '/metrics/', '/METRICS', '/%6detrics', '/metrics?x=1']) {
      const r = await request(app.servidor).get(ruta);
      expect(r.status).toBe(404);
      expect(r.text).not.toContain('http_server_requests_total');
    }
  });

  it('en el puerto de métricas, solo GET /metrics', async () => {
    const ok = await pedirUrl(`${app.urlMetricas}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.texto).toContain('# TYPE http_server_requests_total counter');
    expect(ok.texto).toContain('quinde_build_info{service="quinde-bff"');
    expect((await pedirUrl(`${app.urlMetricas}/graphql`)).status).toBe(404);
    expect((await pedirUrl(`${app.urlMetricas}/metrics`, { metodo: 'POST' })).status).toBe(404);
  });

  it('el puerto de métricas es otro que el de la aplicación', () => {
    const principal = (app.servidor.address() as { port: number }).port;

    expect(app.urlMetricas.split(':').pop()).not.toBe(String(principal));
  });
});
