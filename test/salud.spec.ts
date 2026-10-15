import request from 'supertest';
import { TransporteNucleo } from '../src/config/entorno';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';

describe.each<TransporteNucleo>(['grpc', 'rest'])('salud con el core por %s', (transporte) => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso(transporte);
    app = await crearApp({ core, configuracion: { timeoutMs: 700 } });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  it('GET /health responde 200 sin mirar el core', async () => {
    const r = await request(app.servidor).get('/health');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'UP' });
    expect(r.headers['x-request-id']).toBeDefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('GET /health/ready responde 200 si el core responde', async () => {
    const r = await request(app.servidor).get('/health/ready');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'UP', core: { transport: transporte, status: 'UP' } });
  });

  it('GET /health/ready responde 503 si el core no responde, y /health sigue en 200', async () => {
    await core.detener();

    const listo = await request(app.servidor).get('/health/ready');
    const vivo = await request(app.servidor).get('/health');

    expect(listo.status).toBe(503);
    expect(listo.body).toEqual({ status: 'DOWN', core: { transport: transporte, status: 'DOWN' } });
    // Ni la dirección ni el error del core salen en la respuesta
    expect(JSON.stringify(listo.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    expect(vivo.status).toBe(200);
  });
});

describe('la salud no cuenta contra el límite de /graphql', () => {
  it('más de 100 sondeos a /health no son 429', async () => {
    const core = await crearCoreFalso('rest');
    const app = await crearApp({ core });
    try {
      let ultimo = 0;
      for (let i = 0; i < 105; i++) ultimo = (await request(app.servidor).get('/health')).status;
      expect(ultimo).toBe(200);
    } finally {
      await app.cerrar();
      await core.detener();
    }
  });
});
