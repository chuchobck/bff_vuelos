import { TransporteNucleo } from '../src/config/entorno';
import { leerTraceparent } from '../src/observabilidad/traceparent';
import { OFFER_ID, SEGMENT_ID_1, SEGMENT_ID_2 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, ENTRADA_BUSQUEDA, Q_ESTADO, Q_MAPA } from './utils/graphql';
import { pedirUrl, series } from './utils/http';
import { RecolectorOtlp, SpanRecibido } from './utils/recolector-otlp';

const SPAN_GATEWAY = '00f067aa0ba902b7';
let contador = 0;
/** Una traza distinta por prueba: los spans de una prueba que llegan tarde no contaminan la siguiente. */
const trazaUnica = () => (++contador).toString(16).padStart(32, 'a');

const INTERNAL = 1;
const SERVER = 2;
const CLIENT = 3;
const ERROR = 2;

const Q_BUSQUEDA_CON_MAPAS = `{
  searchFlights(input: ${ENTRADA_BUSQUEDA}) {
    offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
  }
}`;

describe.each<TransporteNucleo>(['grpc', 'rest'])(
  'propagación y spans CLIENT hacia el core por %s',
  (transporte) => {
    const recolector = new RecolectorOtlp();
    let core: CoreFalso;
    let app: AppDePrueba;

    beforeAll(async () => {
      await recolector.iniciar();
      core = await crearCoreFalso(transporte);
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
      TRAZA = trazaUnica();
      TRACEPARENT = `00-${TRAZA}-${SPAN_GATEWAY}-01`;
    });

    let TRAZA = '';
    let TRACEPARENT = '';
    const deTipo = (spans: SpanRecibido[], tipo: number) => spans.filter((s) => s.tipo === tipo);

    it('el core recibe un traceparent con el trace-id del gateway y como parent el span CLIENT de esa llamada', async () => {
      const r = await consultar(app.servidor, Q_ESTADO, {
        headers: { traceparent: TRACEPARENT, 'x-request-id': 'propagacion-0001' },
      });

      expect(r.headers['x-trace-id']).toBe(TRAZA);
      const recibido = leerTraceparent(core.llamadas[0]!.traceparent)!;
      expect(recibido).toBeDefined();
      expect(recibido.traceId).toBe(TRAZA);
      expect(recibido.muestreado).toBe(true);
      // Nunca el traceparent del gateway tal cual: el parent es el span CLIENT del BFF
      expect(recibido.parentId).not.toBe(SPAN_GATEWAY);
      const spans = await recolector.esperarTraza(TRAZA, 3);
      const cliente = deTipo(spans, CLIENT)[0]!;
      expect(cliente.spanId).toBe(recibido.parentId);
      // Junto al x-request-id, que sigue yendo
      expect(core.llamadas[0]!.requestId).toBe('propagacion-0001');
    });

    it('jerarquía SERVER → INTERNAL (operación) → CLIENT (cada llamada al core)', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS, {
        headers: { traceparent: TRACEPARENT },
      });
      expect(r.body.errors).toBeUndefined();

      // 1 SERVER + 1 INTERNAL + (1 búsqueda + 3 mapas distintos) CLIENT
      const spans = await recolector.esperarTraza(TRAZA, 6);
      const servidor = deTipo(spans, SERVER)[0]!;
      const [operacion] = deTipo(spans, INTERNAL);
      const clientes = deTipo(spans, CLIENT);
      expect(operacion!.parentSpanId).toBe(servidor.spanId);
      expect(clientes).toHaveLength(4);
      for (const cliente of clientes) {
        expect(cliente.parentSpanId).toBe(operacion!.spanId);
        expect(cliente.traceId).toBe(TRAZA);
        expect(cliente.atributos['quinde.upstream']).toBe('core');
      }
      // Cada llamada que salió llevó el parent de su propio span CLIENT
      const padres = core.llamadas.map((l) => leerTraceparent(l.traceparent)!.parentId).sort();
      expect(padres).toEqual(clientes.map((c) => c.spanId).sort());
      expect(new Set(padres).size).toBe(4);
    });

    it('dos campos con el mismo offerId y segmentId son UNA llamada: un solo span CLIENT', async () => {
      await consultar(
        app.servidor,
        `{
        a: seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
        b: seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
      }`,
        { headers: { traceparent: TRACEPARENT } },
      );

      const spans = await recolector.esperarTraza(TRAZA, 3);
      expect(deTipo(spans, CLIENT)).toHaveLength(1);
      expect(core.contar('seatMap')).toBe(1);
    });

    it('el span CLIENT lleva los atributos de la llamada y nada del usuario', async () => {
      await consultar(app.servidor, Q_MAPA(OFFER_ID, SEGMENT_ID_2), {
        headers: { traceparent: TRACEPARENT },
      });

      const cliente = deTipo(await recolector.esperarTraza(TRAZA, 3), CLIENT)[0]!;
      if (transporte === 'grpc') {
        expect(cliente.nombre).toBe('quinde.flights.v1.FlightsService/GetSeatMap');
        expect(cliente.atributos).toMatchObject({
          'quinde.upstream': 'core',
          'rpc.system': 'grpc',
          'rpc.service': 'quinde.flights.v1.FlightsService',
          'rpc.method': 'GetSeatMap',
          'rpc.grpc.status_code': 0,
        });
      } else {
        expect(cliente.nombre).toBe('GET /flights/v1/offers/{offerId}/seatmap');
        expect(cliente.atributos).toMatchObject({
          'quinde.upstream': 'core',
          'http.request.method': 'GET',
          'http.route': '/flights/v1/offers/{offerId}/seatmap',
          'http.response.status_code': 200,
        });
      }
      expect(JSON.stringify(cliente)).not.toContain(OFFER_ID);
      expect(JSON.stringify(cliente)).not.toContain(SEGMENT_ID_2);
    });

    it('con una traza no muestreada (bit 00) el core la recibe con 00 y no se exporta nada', async () => {
      const sinMuestrear = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      await consultar(app.servidor, Q_ESTADO, {
        headers: { traceparent: `00-${sinMuestrear}-${SPAN_GATEWAY}-00` },
      });

      const recibido = leerTraceparent(core.llamadas[0]!.traceparent)!;
      expect(recibido.traceId).toBe(sinMuestrear);
      expect(recibido.muestreado).toBe(false);
      await new Promise((listo) => setTimeout(listo, 300));
      expect(recolector.deTraza(sinMuestrear)).toEqual([]);
    });

    describe('tracestate', () => {
      it('pasa intacto al core si el gateway lo mandó con un traceparent válido', async () => {
        await consultar(app.servidor, Q_ESTADO, {
          headers: { traceparent: TRACEPARENT, tracestate: 'congo=t61rcWkgMzE,rojo=00f0' },
        });

        expect(core.llamadas[0]!.tracestate).toBe('congo=t61rcWkgMzE,rojo=00f0');
      });

      it('uno fuera del tope de W3C, o sin traceparent válido, no pasa', async () => {
        await consultar(app.servidor, Q_ESTADO, {
          headers: { traceparent: TRACEPARENT, tracestate: `a=${'x'.repeat(600)}` },
        });
        await consultar(app.servidor, Q_ESTADO, { headers: { tracestate: 'congo=t61rcWkgMzE' } });
        await consultar(app.servidor, Q_ESTADO, {
          headers: { traceparent: 'basura', tracestate: 'congo=t61rcWkgMzE' },
        });

        expect(core.llamadas.map((l) => l.tracestate)).toEqual([undefined, undefined, undefined]);
      });
    });

    describe('errores en el span CLIENT', () => {
      it('un 503/UNAVAILABLE del core marca el span (unavailable, sin mensaje); un 404 no', async () => {
        core.responder('status', {
          tipo: 'error',
          status: 404,
          code: 'X',
          detail: 'Flight ZZ9999 no existe',
        });
        await consultar(app.servidor, Q_ESTADO, { headers: { traceparent: TRACEPARENT } });
        let cliente = deTipo(await recolector.esperarTraza(TRAZA, 3), CLIENT)[0]!;
        expect(cliente.estado.code ?? 0).not.toBe(ERROR);
        if (transporte === 'grpc') expect(cliente.atributos['rpc.grpc.status_code']).toBe(5);
        else expect(cliente.atributos['http.response.status_code']).toBe(404);

        recolector.reiniciar();
        TRAZA = trazaUnica();
        TRACEPARENT = `00-${TRAZA}-${SPAN_GATEWAY}-01`;
        core.responder('status', {
          tipo: 'error',
          status: 503,
          code: 'S',
          detail: 'base caída en db.interna',
        });
        await consultar(app.servidor, Q_ESTADO, { headers: { traceparent: TRACEPARENT } });
        cliente = deTipo(await recolector.esperarTraza(TRAZA, 3), CLIENT)[0]!;
        expect(cliente.estado.code).toBe(ERROR);
        expect(cliente.atributos['error.type']).toBe(transporte === 'grpc' ? 'unavailable' : '503');
        if (transporte === 'grpc') expect(cliente.atributos['rpc.grpc.status_code']).toBe(14);
        expect(JSON.stringify(recolector.cuerpos)).not.toMatch(/db\.interna|ZZ9999/);
      });

      it('el plazo vencido es error.type=timeout', async () => {
        const lento = await crearApp({
          core,
          otlp: recolector.url,
          configuracion: { timeoutMs: 500 },
        });
        try {
          core.responder('status', { tipo: 'ok', retardoMs: 2500 });
          await consultar(lento.servidor, Q_ESTADO, { headers: { traceparent: TRACEPARENT } });

          const cliente = deTipo(await recolector.esperarTraza(TRAZA, 3), CLIENT)[0]!;
          expect(cliente.estado.code).toBe(ERROR);
          expect(cliente.atributos['error.type']).toBe('timeout');
        } finally {
          await lento.cerrar();
        }
      });
    });

    describe('http_client_request_duration_seconds', () => {
      it('upstream="core", method = la RPC y status = el código (gRPC) o el HTTP (REST)', async () => {
        const metricas = async () => (await pedirUrl(`${app.urlMetricas}/metrics`)).texto;
        const antes = series(await metricas(), 'http_client_request_duration_seconds_count');
        await consultar(app.servidor, Q_ESTADO);
        core.responder('seatMap', { tipo: 'error', status: 404, code: 'X', detail: 'no' });
        await consultar(app.servidor, Q_MAPA());
        const despues = series(await metricas(), 'http_client_request_duration_seconds_count');

        const ok = transporte === 'grpc' ? '0' : '200';
        const noExiste = transporte === 'grpc' ? '5' : '404';
        const delta = (etiquetas: string) =>
          (despues.get(etiquetas) ?? 0) - (antes.get(etiquetas) ?? 0);
        expect(delta(`{upstream="core",method="GetFlightStatus",status="${ok}"}`)).toBe(1);
        expect(delta(`{upstream="core",method="GetSeatMap",status="${noExiste}"}`)).toBe(1);
      });
    });
  },
);

const TRAZA_FIJA = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT_FIJO = `00-${TRAZA_FIJA}-${SPAN_GATEWAY}-01`;

describe('el traceparent se propaga aunque no se exporte nada', () => {
  it.each<TransporteNucleo>(['grpc', 'rest'])(
    'sin OTEL_EXPORTER_OTLP_ENDPOINT, por %s',
    async (transporte) => {
      const core = await crearCoreFalso(transporte);
      const app = await crearApp({ core });
      try {
        expect(app.observabilidad.trazas.exportando).toBe(false);
        const r = await consultar(app.servidor, Q_ESTADO, {
          headers: { traceparent: TRACEPARENT_FIJO },
        });

        const recibido = leerTraceparent(core.llamadas[0]!.traceparent)!;
        expect(recibido.traceId).toBe(TRAZA_FIJA);
        expect(recibido.parentId).toMatch(/^[0-9a-f]{16}$/);
        expect(r.headers['x-trace-id']).toBe(TRAZA_FIJA);
      } finally {
        await app.cerrar();
        await core.detener();
      }
    },
  );

  it('también con muestreo 0: la traza no se registra pero se propaga con el bit 00', async () => {
    const core = await crearCoreFalso('grpc');
    const app = await crearApp({
      core,
      configuracion: {
        observabilidad: { ...(await crearConfig(core)).observabilidad, muestreo: 0 },
      },
    });
    try {
      const r = await consultar(app.servidor, Q_ESTADO);

      const recibido = leerTraceparent(core.llamadas[0]!.traceparent)!;
      expect(recibido.traceId).toBe(r.headers['x-trace-id']);
      expect(recibido.muestreado).toBe(false);
    } finally {
      await app.cerrar();
      await core.detener();
    }
  });
});

async function crearConfig(core: CoreFalso) {
  const { configuracionDePrueba } = await import('./utils/crear-app');
  return configuracionDePrueba(core);
}
