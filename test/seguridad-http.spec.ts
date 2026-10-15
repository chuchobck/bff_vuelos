import { buildSchema, parse, validate } from 'graphql';
import request from 'supertest';
import { validarEntorno } from '../src/config/entorno';
import { PROFUNDIDAD_MAXIMA, reglaProfundidadMaxima } from '../src/graphql/profundidad';
import { OFFER_ID, SEGMENT_ID_1 } from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, ENTRADA_BUSQUEDA, HUELLA, Q_ESTADO, Q_SOLO_OFFER_ID } from './utils/graphql';

/** La consulta legítima más honda: búsqueda con el mapa de asientos de cada segmento. */
const Q_PROFUNDIDAD_8 = `{
  searchFlights(input: ${ENTRADA_BUSQUEDA}) {
    offers { itineraries { segments { seatMap { cabins { rows { seats { seatNumber } } } } } } }
  }
}`;

describe('profundidad máxima', () => {
  const esquemaCiclico = buildSchema(`
    type Nodo { siguiente: Nodo valor: Int }
    type Query { nodo: Nodo }
  `);
  const errores = (consulta: string, maximo = 3) =>
    validate(esquemaCiclico, parse(consulta), [reglaProfundidadMaxima(maximo)]);

  it('la profundidad máxima del BFF es 8', () => {
    expect(PROFUNDIDAD_MAXIMA).toBe(8);
  });

  it('acepta justo el máximo y rechaza uno más (las hojas no cuentan)', () => {
    expect(errores('{ nodo { siguiente { siguiente { valor } } } }')).toHaveLength(0);
    const sobra = errores('{ nodo { siguiente { siguiente { siguiente { valor } } } } }');
    expect(sobra).toHaveLength(1);
    expect(sobra[0].extensions).toMatchObject({ code: 'QUERY_TOO_DEEP', status: 400 });
    expect(sobra[0].message).toContain('maximum is 3');
  });

  it('sigue los fragmentos con y sin nombre', () => {
    expect(
      errores(
        `{ nodo { ...A } } fragment A on Nodo { siguiente { ...B } } fragment B on Nodo { siguiente { siguiente { valor } } }`,
      ),
    ).toHaveLength(1);
    expect(
      errores(
        '{ nodo { ... on Nodo { siguiente { ... on Nodo { siguiente { siguiente { valor } } } } } } }',
      ),
    ).toHaveLength(1);
  });

  it('un ciclo de fragmentos no cuelga la regla', () => {
    const r = errores('{ nodo { ...A } } fragment A on Nodo { siguiente { ...A } }');
    expect(Array.isArray(r)).toBe(true);
  });

  it('no cuenta los campos de introspección', () => {
    expect(
      errores(
        '{ __schema { types { fields { type { ofType { ofType { ofType { name } } } } } } } }',
      ),
    ).toHaveLength(0);
  });
});

describe('seguridad HTTP del BFF', () => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso('grpc');
    app = await crearApp({
      core,
      configuracion: { corsOrigenes: ['https://quinde.example.com'], introspeccion: true },
    });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  beforeEach(() => core.reiniciar());

  describe('profundidad', () => {
    it('la consulta más honda del esquema (8 niveles) pasa', async () => {
      const r = await consultar(app.servidor, Q_PROFUNDIDAD_8);

      expect(r.body.errors).toBeUndefined();
      expect(core.contar('search')).toBe(1);
    });

    it('9 niveles es QUERY_TOO_DEEP y no llama al core', async () => {
      const r = await consultar(
        app.servidor,
        `{ searchFlights(input: ${ENTRADA_BUSQUEDA}) { offers { itineraries { segments { seatMap { cabins { rows { seats { nuevo { x { y } } } } } } } } } } }`,
      );

      expect(r.status).toBe(400);
      expect(r.body.errors!.map((e) => e.extensions.code)).toContain('QUERY_TOO_DEEP');
      const hondo = r.body.errors!.find((e) => e.extensions.code === 'QUERY_TOO_DEEP')!;
      expect(hondo.extensions).toMatchObject({ problemCode: 'QUERY_TOO_DEEP', status: 400 });
      expect(hondo.extensions.requestId).toBe(r.headers['x-request-id']);
      expect(core.llamadas).toHaveLength(0);
    });
  });

  describe('sin consultas en lote', () => {
    it('un arreglo de operaciones es BAD_USER_INPUT y no llama al core', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set({ 'content-type': 'application/json', 'x-device-fingerprint': HUELLA })
        .send([{ query: Q_ESTADO }, { query: Q_ESTADO }]);

      expect(r.status).toBe(400);
      expect(r.body.errors[0].extensions).toMatchObject({
        code: 'BAD_USER_INPUT',
        status: 400,
        requestId: r.headers['x-request-id'],
      });
      expect(core.llamadas).toHaveLength(0);
    });
  });

  describe('cuerpo', () => {
    it('más de 100 kB es 413 con la forma de un error GraphQL', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ query: '{ __typename }', relleno: 'x'.repeat(101 * 1024) }));

      expect(r.status).toBe(413);
      expect(r.body.errors[0].extensions).toMatchObject({
        code: 'BAD_USER_INPUT',
        problemCode: 'PAYLOAD_TOO_LARGE',
        status: 413,
        requestId: r.headers['x-request-id'],
      });
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('un cuerpo justo por debajo de 100 kB se lee', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ query: '{ __typename }', relleno: 'x'.repeat(90 * 1024) }));

      expect(r.status).toBe(200);
    });

    it('un JSON roto es 400 y no repite lo que mandó el cliente', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send('{"query": "dato-que-no-debe-volver" ');

      expect(r.status).toBe(400);
      expect(r.body.errors[0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', status: 400 });
      expect(JSON.stringify(r.body)).not.toContain('dato-que-no-debe-volver');
    });
  });

  describe('introspección y landing del sandbox', () => {
    const INTROSPECCION = '{ __schema { queryType { name } } }';
    const pedirLanding = (servidor: AppDePrueba['servidor']) =>
      request(servidor).get('/graphql').set('accept', 'text/html');

    it('encendidos fuera de production: el esquema se puede consultar y hay landing', async () => {
      const r = await consultar(app.servidor, INTROSPECCION);
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.__schema.queryType.name).toBe('Query');

      const landing = await pedirLanding(app.servidor);
      expect(landing.status).toBe(200);
      expect(landing.headers['content-type']).toContain('text/html');
    });

    describe('en production', () => {
      let produccion: AppDePrueba;

      beforeAll(async () => {
        produccion = await crearApp({
          core,
          configuracion: validarEntorno({
            NODE_ENV: 'production',
            CORE_TRANSPORT: 'grpc',
            CORE_GRPC_URL: core.configuracion().grpcUrl,
          }),
        });
      });

      afterAll(() => produccion.cerrar());

      it('la introspección está apagada', async () => {
        for (const consulta of [INTROSPECCION, '{ __type(name: "Query") { name } }']) {
          const r = await consultar(produccion.servidor, consulta);
          expect(r.body.data ?? null).toBeNull();
          expect(r.body.errors![0].message).toMatch(/introspection/i);
        }
      });

      it('no hay landing del sandbox', async () => {
        const landing = await pedirLanding(produccion.servidor);

        expect(landing.headers['content-type'] ?? '').not.toContain('text/html');
        expect(landing.text).not.toMatch(/<html/i);
      });

      it('las consultas normales siguen funcionando', async () => {
        const r = await consultar(produccion.servidor, Q_ESTADO);
        expect(r.body.errors).toBeUndefined();
      });

      it('con GRAPHQL_INTROSPECTION=true vuelven la introspección y el landing', async () => {
        const abierta = await crearApp({
          core,
          configuracion: validarEntorno({
            NODE_ENV: 'production',
            GRAPHQL_INTROSPECTION: 'true',
            CORE_TRANSPORT: 'grpc',
            CORE_GRPC_URL: core.configuracion().grpcUrl,
          }),
        });
        try {
          const r = await consultar(abierta.servidor, INTROSPECCION);
          expect(r.body.errors).toBeUndefined();
          expect((await pedirLanding(abierta.servidor)).headers['content-type']).toContain(
            'text/html',
          );
        } finally {
          await abierta.cerrar();
        }
      });
    });
  });

  describe('CORS', () => {
    const ORIGEN = 'https://quinde.example.com';

    it('un origen permitido recibe sus cabeceras en el preflight', async () => {
      const r = await request(app.servidor).options('/graphql').set({
        origin: ORIGEN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-request-id,x-device-fingerprint',
      });

      expect(r.status).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(ORIGEN);
      expect(r.headers['access-control-allow-headers']).toBe(
        'content-type,x-request-id,x-device-fingerprint',
      );
      expect(r.headers['access-control-allow-methods']).toBe('GET,POST');
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('la respuesta expone x-request-id y retry-after al navegador', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set({ origin: ORIGEN, 'content-type': 'application/json' })
        .send({ query: '{ __typename }' });

      expect(r.headers['access-control-allow-origin']).toBe(ORIGEN);
      expect(r.headers['access-control-expose-headers']).toBe('x-request-id,retry-after');
    });

    it('un origen no permitido no recibe cabeceras CORS', async () => {
      const r = await request(app.servidor)
        .options('/graphql')
        .set({ origin: 'https://malo.example.com', 'access-control-request-method': 'POST' });

      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sin CORS_ORIGINS ningún origen de navegador pasa', async () => {
      const cerrada = await crearApp({ core, configuracion: { corsOrigenes: [] } });
      try {
        const r = await request(cerrada.servidor)
          .options('/graphql')
          .set({ origin: ORIGEN, 'access-control-request-method': 'POST' });
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        await cerrada.cerrar();
      }
    });

    it('una cabecera que no está en la lista (authorization) no se permite', async () => {
      const r = await request(app.servidor).options('/graphql').set({
        origin: ORIGEN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      });

      expect(r.headers['access-control-allow-headers']).toBe(
        'content-type,x-request-id,x-device-fingerprint',
      );
      expect(r.headers['access-control-allow-headers']).not.toContain('authorization');
    });
  });

  describe('cabeceras de seguridad', () => {
    it('helmet pone sus cabeceras y no queda x-powered-by', async () => {
      const r = await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send({ query: '{ __typename }' });

      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['strict-transport-security']).toBeDefined();
      expect(r.headers['x-powered-by']).toBeUndefined();
    });

    it('con el landing apagado (production) helmet deja su CSP estricta', async () => {
      const produccion = await crearApp({ core, configuracion: { introspeccion: false } });
      try {
        const r = await request(produccion.servidor)
          .post('/graphql')
          .set('content-type', 'application/json')
          .send({ query: '{ __typename }' });
        expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      } finally {
        await produccion.cerrar();
      }
    });
  });

  describe('logs', () => {
    // El logger de Nest es global: el último app que lo fija es el que captura. Este describe crea
    // el suyo después de los demás para que `logs` sea de verdad lo que escribió ese app.
    let app: AppDePrueba;

    beforeAll(async () => {
      app = await crearApp({ core });
    });

    afterAll(() => app.cerrar());

    it('cada petición deja una línea de acceso con id, operationName, duración y llamadas al core', async () => {
      app.logs.length = 0;

      const r = await consultar(app.servidor, `query BuscarVuelos ${Q_SOLO_OFFER_ID}`, {
        headers: { 'x-request-id': 'traza-de-acceso-001' },
      });
      expect(r.body.errors).toBeUndefined();

      const lineas = app.logs.filter((l) => l.includes('[Acceso]'));
      expect(lineas).toHaveLength(1);
      expect(lineas[0]).toMatch(
        /^log \[Acceso\] traza-de-acceso-001 POST \/graphql 200 op=BuscarVuelos \d+\.\d+ms core=1$/,
      );
    });

    it('la huella, los argumentos y los datos de la petición no salen en ningún log', async () => {
      app.logs.length = 0;
      const huellaSecreta = 'huella-ultra-secreta-QWERTY-12345';

      await consultar(app.servidor, `query Buscar ${Q_SOLO_OFFER_ID}`, {
        headers: { 'x-device-fingerprint': huellaSecreta },
      });
      await consultar(
        app.servidor,
        `query Mapa { seatMap(offerId: "${OFFER_ID}", segmentId: "${SEGMENT_ID_1}") { segmentId } }`,
      );
      core.responder('status', {
        tipo: 'error',
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'fallo interno',
      });
      await consultar(app.servidor, Q_ESTADO, {
        headers: { 'x-device-fingerprint': huellaSecreta },
      });
      core.reiniciar();
      await consultar(app.servidor, Q_SOLO_OFFER_ID, {
        headers: { 'x-device-fingerprint': 'mala huella con espacios' },
      });
      await consultar(
        app.servidor,
        'query { flightStatus(flightNumber: "ZZ9999", date: "2026-10-22") { status } }',
        { headers: { 'x-device-fingerprint': huellaSecreta } },
      );

      const todo = app.logs.join('\n');
      expect(todo).not.toContain(huellaSecreta);
      expect(todo).not.toContain('mala huella');
      expect(todo).not.toContain('ZZ9999');
      expect(todo).not.toContain('UIO');
      expect(todo).not.toContain(OFFER_ID);
      expect(app.logs.filter((l) => l.includes('[Acceso]')).length).toBe(5);
    });

    it('un operationName con saltos de línea no puede falsear una línea de log', async () => {
      app.logs.length = 0;

      await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send({ query: '{ __typename }', operationName: 'Falso\nlog [Acceso] x-falso-001 200' });

      const lineas = app.logs.filter((l) => l.includes('[Acceso]'));
      expect(lineas).toHaveLength(1);
      expect(lineas[0]).toContain('op=-');
      expect(lineas[0]).not.toContain('Falso');
      expect(lineas[0]).not.toContain('\n');
    });

    it('una petición rechazada (cuerpo grande) también deja su línea de acceso', async () => {
      app.logs.length = 0;

      await request(app.servidor)
        .post('/graphql')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ query: '{ __typename }', relleno: 'x'.repeat(101 * 1024) }));

      const lineas = app.logs.filter((l) => l.includes('[Acceso]'));
      expect(lineas).toHaveLength(1);
      expect(lineas[0]).toContain(' 413 ');
    });
  });
});
