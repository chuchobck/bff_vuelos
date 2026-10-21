import request from 'supertest';
import { OFFER_ID, SEGMENT_ID_1, SEGMENT_ID_2 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, ENTRADA_BUSQUEDA, Q_ESTADO } from './utils/graphql';
import { pedirUrl, series } from './utils/http';
import { RecolectorOtlp } from './utils/recolector-otlp';

const TRAZA = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRAZA}-00f067aa0ba902b7-01`;

/** Lo que NUNCA puede salir en un span, un log o una métrica (docs/OBSERVABILIDAD.md y el encargo). */
const HUELLA = 'huella-marcador-QWERTY-777';
const IP = '203.0.113.99';
const PROHIBIDOS: [string, string][] = [
  ['el offerId', OFFER_ID],
  ['un segmentId', SEGMENT_ID_1],
  ['otro segmentId', SEGMENT_ID_2],
  ['la huella', HUELLA],
  ['la IP del cliente (X-Forwarded-For)', IP],
  ['la IP del socket', '127.0.0.1'],
  ['un alias', 'aliasMarcadorSecreto'],
  ['el valor de una variable', 'AV9999marcador'],
  ['el texto de la consulta', 'flightNumber'],
  ['un campo inventado', 'campoInventadoMarcador'],
  ['un nombre de pasajero', 'Ana Lopez Marcador'],
  ['un correo', 'ana.marcador@example.com'],
  ['el contenido de un cuerpo roto', 'cuerpo-roto-marcador'],
  ['una ruta pedida', 'ruta-inventada-marcador'],
  ['una query string', 'token=secreto-marcador'],
  ['el detalle interno del core', 'detalle-interno-marcador'],
];

describe('escaneo de todo lo emitido: spans, logs y métricas', () => {
  const recolector = new RecolectorOtlp();
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    await recolector.iniciar();
    core = await crearCoreFalso('grpc');
    app = await crearApp({
      core,
      otlp: recolector.url,
      configuracion: { trustProxy: 1, timeoutMs: 500 },
    });

    const cabeceras = {
      'x-device-fingerprint': HUELLA,
      'x-forwarded-for': IP,
      traceparent: TRACEPARENT,
    };
    // Éxito: búsqueda con mapas, con alias, nombre de operación y variables
    await consultar(
      app.servidor,
      `query OperacionMarcadorSecreta($n: String!) {
        aliasMarcadorSecreto: searchFlights(input: ${ENTRADA_BUSQUEDA}) {
          offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
        }
        estado: flightStatus(flightNumber: $n, date: "2026-10-22") { status }
      }`,
      { variables: { n: 'AV9999marcador' }, headers: cabeceras },
    );
    await consultar(
      app.servidor,
      `{ seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId } }`,
      { headers: cabeceras },
    );
    // Errores del core: 404, 503 con detalle interno, 500 y plazo vencido
    core.responder('status', {
      tipo: 'error',
      status: 404,
      code: 'X',
      detail: 'detalle-interno-marcador',
    });
    await consultar(app.servidor, Q_ESTADO, { headers: cabeceras });
    core.responder('status', {
      tipo: 'error',
      status: 503,
      code: 'Y',
      detail: 'detalle-interno-marcador',
    });
    await consultar(app.servidor, Q_ESTADO, { headers: cabeceras });
    core.responder('status', {
      tipo: 'error',
      status: 500,
      code: 'Z',
      detail: 'detalle-interno-marcador',
    });
    await consultar(app.servidor, Q_ESTADO, { headers: cabeceras });
    core.responder('status', { tipo: 'ok', retardoMs: 1500 });
    await consultar(app.servidor, Q_ESTADO, { headers: cabeceras });
    core.reiniciar();
    // Rechazos antes de llegar al core
    await consultar(app.servidor, '{ campoInventadoMarcador }', { headers: cabeceras });
    await consultar(app.servidor, 'query OperacionMarcadorSecreta {', { headers: cabeceras });
    await consultar(app.servidor, `{ searchFlights(input: ${ENTRADA_BUSQUEDA}) { totalOffers } }`, {
      headers: { 'x-forwarded-for': IP, 'x-device-fingerprint': 'mala huella con espacios' },
    });
    await request(app.servidor)
      .post('/graphql')
      .set({ 'content-type': 'application/json', 'x-forwarded-for': IP })
      .send('{"query": "cuerpo-roto-marcador" ');
    await request(app.servidor)
      .post('/graphql')
      .set({ 'content-type': 'application/json', 'x-forwarded-for': IP })
      .send([{ query: '{ __typename }' }]);
    await request(app.servidor)
      .get('/ruta-inventada-marcador/ana.marcador@example.com?token=secreto-marcador')
      .set('x-forwarded-for', IP);
    await request(app.servidor).get('/health').set('x-forwarded-for', IP);
    // Datos de un pasajero en las variables (que no existen en el esquema, pero un cliente puede mandarlas)
    await consultar(
      app.servidor,
      'query OperacionMarcadorSecreta($p: String) { flightStatus(flightNumber: "AV1", date: "2026-10-22") { status } }',
      { variables: { p: 'Ana Lopez Marcador ana.marcador@example.com' }, headers: cabeceras },
    );
    // Esperar a que salga lo que queda en la cola de spans
    await recolector.esperar(20);
    await new Promise((listo) => setTimeout(listo, 400));
  }, 60_000);

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
    await recolector.detener();
  });

  it('el escaneo mira de verdad algo: llegaron spans, hay logs y hay métricas', async () => {
    expect(recolector.spans.length).toBeGreaterThan(20);
    expect(app.logs.length).toBeGreaterThan(10);
    const metricas = (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;
    expect(metricas).toContain('graphql_root_fields_total');
    expect(series(metricas, 'http_client_request_duration_seconds_count').size).toBeGreaterThan(1);
    // y pasó por los tres tipos de span
    expect(new Set(recolector.spans.map((s) => s.tipo))).toEqual(new Set([1, 2, 3]));
  });

  it.each(PROHIBIDOS)(
    'ni los spans ni los logs ni las métricas llevan %s',
    async (_que, marcador) => {
      const spans = recolector.cuerpos.join('\n');
      const logs = app.logs.join('\n');
      const metricas = (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;

      expect({ donde: 'spans', encontrado: spans.includes(marcador) }).toEqual({
        donde: 'spans',
        encontrado: false,
      });
      expect({ donde: 'logs', encontrado: logs.includes(marcador) }).toEqual({
        donde: 'logs',
        encontrado: false,
      });
      expect({ donde: 'metricas', encontrado: metricas.includes(marcador) }).toEqual({
        donde: 'metricas',
        encontrado: false,
      });
    },
  );

  it('el nombre de la operación del cliente no está en spans ni en métricas (solo el log de acceso lo lleva, ya validado)', async () => {
    const metricas = (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;

    expect(recolector.cuerpos.join('\n')).not.toContain('OperacionMarcadorSecreta');
    expect(metricas).not.toContain('OperacionMarcadorSecreta');
    const acceso = app
      .registros()
      .filter((l) => l.context === 'Acceso' && l.op === 'OperacionMarcadorSecreta');
    expect(acceso.length).toBeGreaterThan(0);
  });

  it('los atributos de cada span son solo los permitidos', () => {
    const permitidos = new Set([
      'http.request.method',
      'http.route',
      'http.response.status_code',
      'quinde.upstream',
      'quinde.request_id',
      'error.type',
      'graphql.operation.type',
      'graphql.root_fields',
      'rpc.system',
      'rpc.service',
      'rpc.method',
      'rpc.grpc.status_code',
    ]);
    for (const span of recolector.spans) {
      for (const nombre of Object.keys(span.atributos)) {
        expect({ span: span.nombre, nombre, permitido: permitidos.has(nombre) }).toEqual({
          span: span.nombre,
          nombre,
          permitido: true,
        });
      }
    }
  });

  it('los nombres de los spans salen de un conjunto cerrado', () => {
    const nombres = new Set(recolector.spans.map((s) => s.nombre));
    for (const nombre of nombres) {
      expect(nombre).toMatch(
        /^(POST \/graphql|GET \/health|GET __unmatched__|POST __unmatched__|graphql query [A-Za-z,_]+|graphql query|quinde\.flights\.v1\.FlightsService\/(SearchFlights|GetSeatMap|GetFlightStatus))$/,
      );
    }
  });

  it('el resource lleva la identidad del estándar', () => {
    const recurso = recolector.spans[0]!.recurso;
    expect(recurso['service.name']).toBe('quinde-bff');
    expect(recurso['deployment.environment']).toBe('test');
    expect(recurso['service.version']).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('cardinalidad: 1000 nombres de operación, alias o rutas inventados no crean series nuevas', () => {
  let core: CoreFalso;
  let app: AppDePrueba;
  const recolector = new RecolectorOtlp();

  beforeAll(async () => {
    await recolector.iniciar();
    core = await crearCoreFalso('grpc');
    app = await crearApp({ core, otlp: recolector.url, configuracion: { trustProxy: 1 } });
  });
  afterAll(async () => {
    await app.cerrar();
    await core.detener();
    await recolector.detener();
  });

  const texto = async () => (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;
  /** Las series propias del servicio (las de proceso y nodejs_* varían solas). */
  const propias = (t: string) =>
    t
      .split('\n')
      .filter((l) => /^(graphql_|bff_|http_|quinde_)/.test(l))
      .map((l) => l.slice(0, l.lastIndexOf(' ')))
      .sort();

  it('mil variantes dejan exactamente las mismas series que diez', async () => {
    const variante = async (i: number) => {
      const ip = `198.51.100.${(i % 250) + 1}`; // otra IP cada vez: el límite no frena la prueba
      const h = { 'x-forwarded-for': ip, 'x-device-fingerprint': `huella-de-prueba-${i}-0123` };
      await consultar(
        app.servidor,
        `query Op${i}x { a${i}: flightStatus(flightNumber: "AV${i}", date: "2026-10-22") { status } }`,
        { headers: h },
      );
      await consultar(app.servidor, `query Op${i}y { campoInventado${i} }`, { headers: h });
      await request(app.servidor)
        .get(`/ruta-${i}/ana${i}@example.com?x=${i}`)
        .set('x-forwarded-for', ip);
    };
    for (let i = 0; i < 10; i++) await variante(i);
    const con10 = propias(await texto());

    // 1000 variantes en total: 330 vueltas de 3 peticiones
    for (let i = 10; i < 340; i++) await variante(i);
    const conMil = propias(await texto());

    expect(conMil).toEqual(con10);
    expect(await texto()).not.toMatch(/Op\d+[xy]|campoInventado|ruta-\d+/);
    expect(conMil.length).toBeLessThan(150);
  }, 120_000);

  it('las etiquetas solo toman valores de conjuntos cerrados', async () => {
    const t = await texto();
    const valores = (metrica: string, etiqueta: string) =>
      new Set(
        [...series(t, metrica).keys()].map((k) => new RegExp(`${etiqueta}="([^"]*)"`).exec(k)?.[1]),
      );

    expect(valores('graphql_root_fields_total', 'field')).toEqual(
      new Set(
        ['flightStatus', '__other__'].filter((v) =>
          valores('graphql_root_fields_total', 'field').has(v),
        ),
      ),
    );
    for (const campo of valores('graphql_root_fields_total', 'field')) {
      expect(['searchFlights', 'seatMap', 'flightStatus', '__other__']).toContain(campo);
    }
    for (const ruta of valores('http_server_requests_total', 'route')) {
      expect(['/graphql', '/health', '/health/ready', '__unmatched__']).toContain(ruta);
    }
    for (const rpc of valores('http_client_request_duration_seconds_count', 'method')) {
      expect(['SearchFlights', 'GetSeatMap', 'GetFlightStatus']).toContain(rpc);
    }
    for (const metodo of valores('http_server_requests_total', 'method')) {
      expect(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '_OTHER']).toContain(
        metodo,
      );
    }
  });

  it('los nombres de los spans exportados tampoco crecen con las variantes', async () => {
    await recolector.esperar(30);
    await new Promise((listo) => setTimeout(listo, 300));
    const nombres = new Set(recolector.spans.map((s) => s.nombre));

    expect(nombres.size).toBeLessThan(12);
    expect([...nombres].join('|')).not.toMatch(/Op\d+|campoInventado|ruta-\d+/);
  });
});
