import { Reloj } from '../src/common/reloj';
import { OFFER_ID, SEGMENT_ID_1 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import {
  consultar,
  ENTRADA_BUSQUEDA,
  Q_ESTADO,
  Q_MAPA,
  Q_SOLO_OFFER_ID,
  Respuesta,
} from './utils/graphql';
import { RelojDePrueba } from './utils/reloj-de-prueba';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cada prueba usa su propia IP (X-Forwarded-For con TRUST_PROXY=1) para no mezclar contadores. */
let contadorIp = 0;
const nuevaIp = () => `203.0.113.${++contadorIp}`;
const desde = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });

describe('protecciones del BFF', () => {
  let core: CoreFalso;
  let reloj: RelojDePrueba;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso('grpc');
    reloj = new RelojDePrueba();
    app = await crearApp({
      core,
      configuracion: { trustProxy: 1 },
      sobrescribir: [{ proveedor: Reloj, valor: reloj }],
    });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  beforeEach(() => core.reiniciar());

  const repetir = async (veces: number, hacer: () => Promise<Respuesta>): Promise<Respuesta[]> => {
    const respuestas: Respuesta[] = [];
    for (let i = 0; i < veces; i++) respuestas.push(await hacer());
    return respuestas;
  };

  describe('límite de peticiones por IP y por operación raíz', () => {
    it('searchFlights: 20 por minuto; la 21 es TOO_MANY_REQUESTS con retryAfter y Retry-After', async () => {
      const ip = nuevaIp();
      const buenas = await repetir(20, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip)));
      expect(buenas.every((r) => r.status === 200 && !r.body.errors)).toBe(true);

      const r = await consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip));

      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('60');
      expect(r.body.errors).toHaveLength(1);
      expect(r.body.errors![0].extensions).toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        problemCode: 'RATE_LIMIT_EXCEEDED',
        status: 429,
        retryAfter: 60,
        requestId: r.headers['x-request-id'],
      });
      expect(r.body.errors![0].extensions).not.toHaveProperty('http');
      // La rechazada no llegó al core
      expect(core.contar('search')).toBe(20);
    });

    it('seatMap: 60 por minuto; la 61 es TOO_MANY_REQUESTS', async () => {
      const ip = nuevaIp();
      const buenas = await repetir(60, () => consultar(app.servidor, Q_MAPA(), desde(ip)));
      expect(buenas.every((r) => r.status === 200 && !r.body.errors)).toBe(true);

      const r = await consultar(app.servidor, Q_MAPA(), desde(ip));

      expect(r.status).toBe(429);
      expect(r.body.errors![0].extensions.code).toBe('TOO_MANY_REQUESTS');
      expect(core.contar('seatMap')).toBe(60);
    });

    it('flightStatus: 60 por minuto; la 61 es TOO_MANY_REQUESTS', async () => {
      const ip = nuevaIp();
      const buenas = await repetir(60, () => consultar(app.servidor, Q_ESTADO, desde(ip)));
      expect(buenas.every((r) => r.status === 200 && !r.body.errors)).toBe(true);

      const r = await consultar(app.servidor, Q_ESTADO, desde(ip));

      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBeDefined();
    });

    it('cada operación tiene su contador: agotar searchFlights no frena a flightStatus', async () => {
      const ip = nuevaIp();
      await repetir(21, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip)));

      const r = await consultar(app.servidor, Q_ESTADO, desde(ip));

      expect(r.status).toBe(200);
      expect(r.body.errors).toBeUndefined();
    });

    it('cada IP tiene su contador', async () => {
      const a = nuevaIp();
      const b = nuevaIp();
      await repetir(21, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(a)));

      const r = await consultar(app.servidor, Q_SOLO_OFFER_ID, desde(b));

      expect(r.status).toBe(200);
    });

    it('el límite global cuenta toda petición a /graphql: la 101 es TOO_MANY_REQUESTS', async () => {
      const ip = nuevaIp();
      const buenas = await repetir(100, () => consultar(app.servidor, '{ __typename }', desde(ip)));
      expect(buenas.every((r) => r.status === 200)).toBe(true);

      const r = await consultar(app.servidor, '{ __typename }', desde(ip));

      expect(r.status).toBe(429);
      expect(r.headers['retry-after']).toBe('60');
      expect(r.headers['x-request-id']).toMatch(UUID);
      expect(r.body.errors![0].extensions).toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        status: 429,
        retryAfter: 60,
        requestId: r.headers['x-request-id'],
      });
    });

    it('pasada la ventana, el reloj libera el cupo (sin esperar de verdad)', async () => {
      const ip = nuevaIp();
      await repetir(20, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip)));
      const bloqueada = await consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip));
      expect(bloqueada.status).toBe(429);

      reloj.avanzar(30_000);
      const aunNo = await consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip));
      expect(aunNo.status).toBe(429);
      expect(Number(aunNo.headers['retry-after'])).toBe(30);

      reloj.avanzar(30_001);
      const libre = await consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip));
      expect(libre.status).toBe(200);
      expect(libre.body.errors).toBeUndefined();
    });

    it('21 búsquedas con alias en una sola petición se rechazan enteras y no consumen cupo', async () => {
      const ip = nuevaIp();
      const alias = Array.from(
        { length: 21 },
        (_, i) => `a${i}: searchFlights(input: ${ENTRADA_BUSQUEDA}) { totalOffers }`,
      ).join('\n');

      const r = await consultar(app.servidor, `{ ${alias} }`, desde(ip));

      expect(r.status).toBe(429);
      expect(r.body.errors![0].extensions.code).toBe('TOO_MANY_REQUESTS');
      expect(core.llamadas).toHaveLength(0);
      // No consumió: todavía caben las 20 búsquedas de la ventana
      const despues = await repetir(20, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip)));
      expect(despues.every((x) => x.status === 200)).toBe(true);
    });

    it('una consulta con dos operaciones, una sin cupo, no consume el cupo de la otra', async () => {
      const ip = nuevaIp();
      await repetir(60, () => consultar(app.servidor, Q_MAPA(), desde(ip)));
      const mixta = `{
        searchFlights(input: ${ENTRADA_BUSQUEDA}) { totalOffers }
        seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId }
      }`;

      const rechazada = await consultar(app.servidor, mixta, desde(ip));
      expect(rechazada.status).toBe(429);

      // La búsqueda de la consulta rechazada no gastó su cupo: caben las 20
      const despues = await repetir(20, () => consultar(app.servidor, Q_SOLO_OFFER_ID, desde(ip)));
      expect(despues.every((x) => x.status === 200)).toBe(true);
    });

    it('los alias dentro de un fragmento cuentan igual: 61 estados en un fragmento se rechazan', async () => {
      const ip = nuevaIp();
      const campo = (i: number) =>
        `e${i}: flightStatus(flightNumber: "AV1500", date: "2026-10-22") { status }`;
      const consulta = `{ ...Estados } fragment Estados on Query { ${Array.from({ length: 61 }, (_, i) => campo(i)).join(' ')} }`;

      const r = await consultar(app.servidor, consulta, desde(ip));

      expect(r.status).toBe(429);
      expect(core.llamadas).toHaveLength(0);
    });

    it('el mismo campo con la misma clave, aunque venga por un fragmento, se fusiona y es una ejecución', async () => {
      const ip = nuevaIp();
      const campo = 'e: flightStatus(flightNumber: "AV1500", date: "2026-10-22") { status }';

      const r = await consultar(
        app.servidor,
        `{ ${campo} ...F } fragment F on Query { ${campo} }`,
        desde(ip),
      );

      expect(r.body.errors).toBeUndefined();
      expect(core.contar('status')).toBe(1);
    });

    it('sin TRUST_PROXY el X-Forwarded-For no se puede usar para esquivar el límite', async () => {
      const sinProxy = await crearApp({
        core,
        configuracion: { trustProxy: false },
        sobrescribir: [{ proveedor: Reloj, valor: new RelojDePrueba() }],
      });
      try {
        let ultima: Respuesta | undefined;
        for (let i = 0; i < 21; i++) {
          ultima = await consultar(sinProxy.servidor, Q_SOLO_OFFER_ID, desde(nuevaIp()));
        }
        expect(ultima!.status).toBe(429);
      } finally {
        await sinProxy.cerrar();
      }
    });
  });
});
