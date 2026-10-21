import request from 'supertest';
import { OFFER_ID, SEGMENT_ID_1 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, ENTRADA_BUSQUEDA, Q_ESTADO, Q_MAPA, Q_SOLO_OFFER_ID } from './utils/graphql';
import { pedirUrl, series } from './utils/http';
import { RecolectorOtlp, SpanRecibido } from './utils/recolector-otlp';

const SPAN_GATEWAY = '00f067aa0ba902b7';

const INTERNAL = 1;
const SERVER = 2;
const ERROR = 2;

describe('span INTERNAL por operación GraphQL y métricas del BFF', () => {
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

  /** Pide con una traza fija y devuelve los spans de esa traza ya llegados. */
  async function trazar(query: string, esperados: number, headers: Record<string, string> = {}) {
    const traza = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
    const r = await consultar(app.servidor, query, {
      headers: { traceparent: `00-${traza}-${SPAN_GATEWAY}-01`, ...headers },
    });
    const spans = await recolector.esperarTraza(traza, esperados);
    return { r, spans, traza };
  }
  const deTipo = (spans: SpanRecibido[], tipo: number) => spans.filter((s) => s.tipo === tipo);

  it('SERVER → INTERNAL: la operación cuelga del span SERVER, con el tipo y los campos raíz', async () => {
    const { spans } = await trazar(Q_ESTADO, 2);

    const servidor = deTipo(spans, SERVER)[0]!;
    const [operacion] = deTipo(spans, INTERNAL);
    expect(operacion).toBeDefined();
    expect(operacion!.parentSpanId).toBe(servidor.spanId);
    expect(operacion!.nombre).toBe('graphql query flightStatus');
    expect(operacion!.atributos).toEqual({
      'graphql.operation.type': 'query',
      'graphql.root_fields': 'flightStatus',
    });
  });

  it('varios campos raíz: sus nombres del esquema, sin repetir y en orden', async () => {
    const { spans } = await trazar(
      `{
        b: seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
        a: flightStatus(flightNumber: "AV1500", date: "2026-10-22") { status }
        c: flightStatus(flightNumber: "AV1501", date: "2026-10-22") { status }
      }`,
      2,
    );

    const [operacion] = deTipo(spans, INTERNAL);
    expect(operacion!.atributos['graphql.root_fields']).toBe('flightStatus,seatMap');
    expect(operacion!.nombre).toBe('graphql query flightStatus,seatMap');
  });

  it('el nombre de la operación, los alias, la consulta y las variables no llegan a ningún span', async () => {
    const traza = 'a1b2c3d4e5f60718293a4b5c6d7e8f91';
    await consultar(
      app.servidor,
      `query BuscarParaAnaLopez($fecha: Date!) { estadoSecreto: flightStatus(flightNumber: "AV1500", date: $fecha) { status } }`,
      {
        variables: { fecha: '2026-10-22' },
        headers: {
          traceparent: `00-${traza}-${SPAN_GATEWAY}-01`,
          'x-device-fingerprint': 'huella-ultra-secreta-98765',
        },
      },
    );
    await recolector.esperarTraza(traza, 2);

    const todo = recolector.cuerpos.join('\n');
    expect(todo).not.toContain('BuscarParaAnaLopez');
    expect(todo).not.toContain('estadoSecreto');
    expect(todo).not.toContain('AV1500');
    expect(todo).not.toContain('2026-10-22');
    expect(todo).not.toContain('huella-ultra-secreta');
    expect(todo).not.toContain('flightNumber');
  });

  it('una operación rechazada por validación no abre span INTERNAL pero sí responde con X-Trace-Id', async () => {
    const { r, spans } = await trazar('{ campoQueNoExiste }', 1);

    expect(r.status).toBe(400);
    expect(deTipo(spans, INTERNAL)).toHaveLength(0);
    expect(deTipo(spans, SERVER)).toHaveLength(1);
  });

  it('un error del cliente (NOT_FOUND) no marca el span; uno del servicio (core caído) sí, sin mensaje', async () => {
    core.responder('status', {
      tipo: 'error',
      status: 404,
      code: 'FLIGHT_STATUS_NOT_AVAILABLE',
      detail: 'Flight ZZ9999 was not found',
    });
    const noExiste = await trazar(Q_ESTADO, 2);
    expect(deTipo(noExiste.spans, INTERNAL)[0]!.estado.code ?? 0).not.toBe(ERROR);

    recolector.reiniciar();
    core.responder('status', {
      tipo: 'error',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'base caída con db.interna',
    });
    const caido = await trazar(Q_ESTADO, 2);
    const operacion = deTipo(caido.spans, INTERNAL)[0]!;
    expect(operacion.estado.code).toBe(ERROR);
    expect(operacion.atributos['error.type']).toBe('unavailable');
    expect(JSON.stringify(recolector.cuerpos)).not.toMatch(/db\.interna|Flight ZZ9999/);
    // El SERVER respondió 200 (GraphQL devuelve los errores en el cuerpo): no es error
    expect(deTipo(caido.spans, SERVER)[0]!.estado.code ?? 0).not.toBe(ERROR);
  });

  describe('métricas propias', () => {
    const metricas = async () => (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;

    it('graphql_root_fields_total cuenta cada campo raíz ejecutado, por el nombre del esquema', async () => {
      const antes = series(await metricas(), 'graphql_root_fields_total');
      await consultar(app.servidor, Q_ESTADO);
      await consultar(app.servidor, Q_ESTADO);
      await consultar(app.servidor, Q_MAPA());
      await consultar(app.servidor, Q_SOLO_OFFER_ID);
      const despues = series(await metricas(), 'graphql_root_fields_total');

      const delta = (campo: string) =>
        (despues.get(`{field="${campo}"}`) ?? 0) - (antes.get(`{field="${campo}"}`) ?? 0);
      expect(delta('flightStatus')).toBe(2);
      expect(delta('seatMap')).toBe(1);
      expect(delta('searchFlights')).toBe(1);
    });

    it('graphql_errors_total cuenta por code de la lista cerrada', async () => {
      const antes = series(await metricas(), 'graphql_errors_total');
      core.responder('status', { tipo: 'error', status: 404, code: 'X', detail: 'no' });
      await consultar(app.servidor, Q_ESTADO);
      await consultar(app.servidor, '{ campoQueNoExiste }');
      await consultar(app.servidor, Q_SOLO_OFFER_ID, { sinHuella: true });
      const despues = series(await metricas(), 'graphql_errors_total');

      const delta = (code: string) =>
        (despues.get(`{code="${code}"}`) ?? 0) - (antes.get(`{code="${code}"}`) ?? 0);
      expect(delta('NOT_FOUND')).toBe(1);
      expect(delta('GRAPHQL_VALIDATION_FAILED')).toBe(1);
      expect(delta('BAD_USER_INPUT')).toBe(1);
    });

    it('bff_core_calls_per_query observa cuántas llamadas hizo cada consulta', async () => {
      const antes = series(await metricas(), 'bff_core_calls_per_query_count').get('') ?? 0;
      const sumaAntes = series(await metricas(), 'bff_core_calls_per_query_sum').get('') ?? 0;
      // búsqueda (1) + 3 mapas distintos = 4 llamadas; y una consulta sin llamadas
      await consultar(
        app.servidor,
        `{ searchFlights(input: ${ENTRADA_BUSQUEDA}) { offers { itineraries { segments { seatMap { segmentId } } } } } }`,
      );
      await consultar(app.servidor, '{ __typename }');
      const texto = await metricas();

      expect((series(texto, 'bff_core_calls_per_query_count').get('') ?? 0) - antes).toBe(2);
      expect((series(texto, 'bff_core_calls_per_query_sum').get('') ?? 0) - sumaAntes).toBe(4);
    });

    it('los errores que se rechazan antes de Apollo (cuerpo roto, lote) también cuentan', async () => {
      const antes =
        series(await metricas(), 'graphql_errors_total').get('{code="BAD_USER_INPUT"}') ?? 0;
      await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send('{"query": ');

      const despues =
        series(await metricas(), 'graphql_errors_total').get('{code="BAD_USER_INPUT"}') ?? 0;
      expect(despues - antes).toBe(1);
    });
  });
});
