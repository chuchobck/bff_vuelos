import { TransporteNucleo } from '../src/config/entorno';
import { OFFER_ID, OFFER_ID_2, SEGMENT_ID_1, SEGMENT_ID_2 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import {
  consultar,
  ENTRADA_BUSQUEDA,
  HUELLA,
  Q_ESTADO,
  Q_MAPA,
  Q_SOLO_OFFER_ID,
} from './utils/graphql';

const TRANSPORTES: TransporteNucleo[] = ['grpc', 'rest'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const Q_BUSQUEDA_CON_MAPAS = `{
  searchFlights(input: ${ENTRADA_BUSQUEDA}) {
    offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
  }
}`;

describe.each(TRANSPORTES)('llamadas al core por %s', (transporte) => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso(transporte);
    app = await crearApp({ core, configuracion: { maxLlamadasPorConsulta: 4 } });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  beforeEach(() => core.reiniciar());

  describe('agregación perezosa de FlightSegment.seatMap', () => {
    it('pedir solo offers { offerId } hace exactamente 1 llamada al core y ninguna a GetSeatMap', async () => {
      const r = await consultar(app.servidor, Q_SOLO_OFFER_ID);

      expect(r.body.errors).toBeUndefined();
      expect(core.llamadas).toHaveLength(1);
      expect(core.contar('search')).toBe(1);
      expect(core.contar('seatMap')).toBe(0);
    });

    it('pedir seatMap en los segmentos llama al core una vez por segmento distinto, con el offerId del padre', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS);

      expect(r.body.errors).toBeUndefined();
      expect(core.contar('search')).toBe(1);
      expect(core.contar('seatMap')).toBe(3);
      const pedidos = core.llamadas
        .filter((l) => l.operacion === 'seatMap')
        .map((l) => `${l.peticion.offerId}|${l.peticion.segmentId}`)
        .sort();
      expect(pedidos).toEqual(
        [
          `${OFFER_ID}|${SEGMENT_ID_1}`,
          `${OFFER_ID}|${SEGMENT_ID_2}`,
          `${OFFER_ID_2}|${SEGMENT_ID_1}`,
        ].sort(),
      );
      const segmento = r.body.data?.searchFlights.offers[0].itineraries[0].segments[0];
      expect(segmento.seatMap).toEqual({ segmentId: SEGMENT_ID_1 });
    });
  });

  describe('DataLoader por petición', () => {
    it('dos pedidos iguales (mismo offerId y segmentId) en una consulta son una sola llamada', async () => {
      const r = await consultar(
        app.servidor,
        `{
          a: seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
          b: seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
        }`,
      );

      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.a).toEqual(r.body.data?.b);
      expect(core.contar('seatMap')).toBe(1);
    });

    it('la raíz seatMap y FlightSegment.seatMap con los mismos ids comparten la llamada', async () => {
      const r = await consultar(
        app.servidor,
        `{
          seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
          searchFlights(input: ${ENTRADA_BUSQUEDA}) {
            offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
          }
        }`,
      );

      expect(r.body.errors).toBeUndefined();
      // (OFFER_ID, S1) una vez; más (OFFER_ID, S2) y (OFFER_ID_2, S1)
      expect(core.contar('seatMap')).toBe(3);
    });

    it('no comparte nada entre peticiones: la misma consulta dos veces llama al core dos veces', async () => {
      await consultar(app.servidor, Q_MAPA());
      await consultar(app.servidor, Q_MAPA());

      expect(core.contar('seatMap')).toBe(2);
    });
  });

  describe('tope de llamadas por consulta', () => {
    it('al pasar CORE_MAX_LLAMADAS_POR_CONSULTA, QUERY_TOO_EXPENSIVE y el core no recibe más', async () => {
      // maxLlamadasPorConsulta = 4: la búsqueda (1) y tres mapas distintos son 4; con 5 pasaría
      const r = await consultar(
        app.servidor,
        `{
          searchFlights(input: ${ENTRADA_BUSQUEDA}) {
            offers { offerId itineraries { segments { segmentId seatMap { segmentId } } } }
          }
          extra: seatMap(offerId: "${OFFER_ID_2}", segmentId: "${SEGMENT_ID_2}") { segmentId }
        }`,
      );

      expect(core.llamadas).toHaveLength(4);
      const caros = (r.body.errors ?? []).filter(
        (e) => e.extensions.code === 'QUERY_TOO_EXPENSIVE',
      );
      expect(caros).toHaveLength(1);
      expect(caros[0].extensions).toMatchObject({
        code: 'QUERY_TOO_EXPENSIVE',
        problemCode: 'QUERY_TOO_EXPENSIVE',
        status: 400,
      });
      expect(caros[0].extensions.requestId).toEqual(expect.any(String));
      expect(caros[0].message).toContain('4 calls');
    });

    it('una consulta que no pasa el tope no tiene errores', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS);

      expect(r.body.errors).toBeUndefined();
      expect(core.llamadas).toHaveLength(4);
    });

    it('el contador es de la petición: la siguiente vuelve a tener todo el cupo', async () => {
      await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS);
      core.reiniciar();

      const r = await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS);

      expect(r.body.errors).toBeUndefined();
      expect(core.llamadas).toHaveLength(4);
    });
  });

  describe('x-request-id y huella hacia el core', () => {
    it('el x-request-id del cliente llega al core y vuelve en la cabecera de respuesta', async () => {
      const r = await consultar(app.servidor, Q_ESTADO, {
        headers: { 'x-request-id': 'traza-marketplace-0001' },
      });

      expect(r.headers['x-request-id']).toBe('traza-marketplace-0001');
      expect(core.llamadas[0].requestId).toBe('traza-marketplace-0001');
    });

    it.each([
      ['demasiado corto', 'corto'],
      ['con espacios', 'tiene espacios en el id'],
      ['de más de 64 caracteres', 'a'.repeat(65)],
      ['con punto y coma', 'con;punto-y-coma-123'],
      ['que empieza con guion', '-empieza-con-guion'],
    ])(
      'un x-request-id %s se reemplaza por un UUID que viaja al core y a la respuesta',
      async (_motivo, invalido) => {
        const r = await consultar(app.servidor, Q_ESTADO, {
          headers: { 'x-request-id': invalido },
        });

        expect(r.headers['x-request-id']).toMatch(UUID);
        expect(core.llamadas[0].requestId).toBe(r.headers['x-request-id']);
      },
    );

    it('sin x-request-id se genera un UUID', async () => {
      const r = await consultar(app.servidor, Q_ESTADO);

      expect(r.headers['x-request-id']).toMatch(UUID);
      expect(core.llamadas[0].requestId).toBe(r.headers['x-request-id']);
    });

    it('la huella llega al core en la búsqueda y solo en la búsqueda', async () => {
      await consultar(app.servidor, Q_SOLO_OFFER_ID);
      await consultar(app.servidor, Q_MAPA());
      await consultar(app.servidor, Q_ESTADO);

      const porOperacion = Object.fromEntries(core.llamadas.map((l) => [l.operacion, l.huella]));
      expect(porOperacion).toEqual({ search: HUELLA, seatMap: undefined, status: undefined });
    });

    it('todas las llamadas de una consulta llevan el mismo request id', async () => {
      await consultar(app.servidor, Q_BUSQUEDA_CON_MAPAS, {
        headers: { 'x-request-id': 'una-sola-consulta-01' },
      });

      expect(core.llamadas).toHaveLength(4);
      expect(new Set(core.llamadas.map((l) => l.requestId))).toEqual(
        new Set(['una-sola-consulta-01']),
      );
    });
  });

  describe('x-device-fingerprint obligatoria en searchFlights', () => {
    it('sin huella, BAD_USER_INPUT y el core no recibe nada', async () => {
      const r = await consultar(app.servidor, Q_SOLO_OFFER_ID, { sinHuella: true });

      expect(r.body.errors).toHaveLength(1);
      expect(r.body.errors?.[0].extensions).toMatchObject({
        code: 'BAD_USER_INPUT',
        status: 400,
        invalidParams: [{ name: 'X-Device-Fingerprint', reason: 'is required' }],
      });
      expect(core.llamadas).toHaveLength(0);
    });

    it.each([
      ['demasiado corta', 'corta'],
      ['con espacios', 'con espacios 12345678'],
      ['de más de 128 caracteres', 'a'.repeat(129)],
      ['con caracteres fuera del alfabeto', 'raro;;;12345678'],
    ])(
      'una huella %s es BAD_USER_INPUT y su valor no vuelve en la respuesta',
      async (_motivo, invalida) => {
        const r = await consultar(app.servidor, Q_SOLO_OFFER_ID, {
          headers: { 'x-device-fingerprint': invalida },
        });

        expect(r.body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
        expect(JSON.stringify(r.body)).not.toContain(invalida);
        expect(core.llamadas).toHaveLength(0);
      },
    );

    it('seatMap y flightStatus no piden la huella', async () => {
      const mapa = await consultar(app.servidor, Q_MAPA(), { sinHuella: true });
      const estado = await consultar(app.servidor, Q_ESTADO, { sinHuella: true });

      expect(mapa.body.errors).toBeUndefined();
      expect(estado.body.errors).toBeUndefined();
    });
  });
});

describe('el plazo de cada llamada al core', () => {
  it('gRPC fija un plazo por llamada de CORE_TIMEOUT_MS', async () => {
    const core = await crearCoreFalso('grpc');
    const app = await crearApp({ core, configuracion: { timeoutMs: 4000 } });
    try {
      await consultar(app.servidor, Q_ESTADO);

      const plazo = core.llamadas[0].plazoMs as number;
      expect(plazo).toBeGreaterThan(3000);
      expect(plazo).toBeLessThanOrEqual(4000);
    } finally {
      await app.cerrar();
      await core.detener();
    }
  });
});
