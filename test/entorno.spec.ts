import { validarEntorno } from '../src/config/entorno';

const BASE = { NODE_ENV: 'test', CORE_TRANSPORT: 'grpc' };

/** El mensaje del error de validación (lanza si no lo hay). */
function mensajeDe(entorno: Record<string, unknown>): string {
  try {
    validarEntorno(entorno);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('debía fallar');
}

describe('validación del entorno al arrancar', () => {
  describe('valores por defecto', () => {
    it('PORT 4000, gRPC en localhost:50051, plazo de 8 s, 10 llamadas y los límites del core', () => {
      const c = validarEntorno(BASE);

      expect(c).toMatchObject({
        puerto: 4000,
        transporte: 'grpc',
        grpcUrl: 'localhost:50051',
        restUrl: undefined,
        timeoutMs: 8000,
        maxLlamadasPorConsulta: 10,
        corsOrigenes: [],
        trustProxy: false,
        limites: {
          ventanaSegundos: 60,
          global: 100,
          searchFlights: 20,
          seatMap: 60,
          flightStatus: 60,
        },
      });
    });

    it('la introspección se apaga en production y se enciende en development y test', () => {
      expect(validarEntorno({ ...BASE, NODE_ENV: 'production' }).introspeccion).toBe(false);
      expect(validarEntorno({ ...BASE, NODE_ENV: 'development' }).introspeccion).toBe(true);
      expect(validarEntorno({ ...BASE, NODE_ENV: 'test' }).introspeccion).toBe(true);
    });

    it('GRAPHQL_INTROSPECTION manda sobre NODE_ENV', () => {
      expect(
        validarEntorno({ ...BASE, NODE_ENV: 'production', GRAPHQL_INTROSPECTION: 'true' })
          .introspeccion,
      ).toBe(true);
      expect(
        validarEntorno({ ...BASE, NODE_ENV: 'development', GRAPHQL_INTROSPECTION: 'false' })
          .introspeccion,
      ).toBe(false);
    });
  });

  describe('variables obligatorias', () => {
    it('sin CORE_TRANSPORT no arranca y nombra la variable', () => {
      expect(mensajeDe({ NODE_ENV: 'test' })).toMatch(/CORE_TRANSPORT/);
    });

    it('sin NODE_ENV no arranca (de él depende la introspección)', () => {
      expect(mensajeDe({ CORE_TRANSPORT: 'grpc' })).toMatch(/NODE_ENV/);
    });

    it('un CORE_TRANSPORT inválido no arranca y no repite el valor', () => {
      const mensaje = mensajeDe({ ...BASE, CORE_TRANSPORT: 'soap-secreto' });
      expect(mensaje).toMatch(/CORE_TRANSPORT/);
      expect(mensaje).not.toContain('soap-secreto');
    });

    it('con rest, CORE_REST_URL es obligatoria', () => {
      expect(mensajeDe({ ...BASE, CORE_TRANSPORT: 'rest' })).toMatch(/CORE_REST_URL/);
    });

    it('con grpc, CORE_REST_URL no hace falta', () => {
      expect(() => validarEntorno(BASE)).not.toThrow();
    });

    it('con rest, la URL se guarda como origen, sin barra final', () => {
      const c = validarEntorno({
        ...BASE,
        CORE_TRANSPORT: 'rest',
        CORE_REST_URL: 'https://quinde-vuelos-api.onrender.com/',
      });
      expect(c.restUrl).toBe('https://quinde-vuelos-api.onrender.com');
    });
  });

  describe('variables inválidas: el error nombra la variable, nunca su valor', () => {
    it.each([
      [
        'CORE_REST_URL',
        'https://usuario:clave-secreta@core.example.com',
        { CORE_TRANSPORT: 'rest' },
      ],
      ['CORE_REST_URL', 'ftp://core.example.com', { CORE_TRANSPORT: 'rest' }],
      ['CORE_REST_URL', 'https://core.example.com/flights/v1', { CORE_TRANSPORT: 'rest' }],
      ['CORE_REST_URL', 'https://core.example.com?token=secreto-123', { CORE_TRANSPORT: 'rest' }],
      ['CORE_GRPC_URL', 'sin-puerto-secreto', {}],
      ['PORT', '99999', {}],
      ['PORT', 'abc', {}],
      ['CORE_TIMEOUT_MS', '499', {}],
      ['CORE_TIMEOUT_MS', '60001', {}],
      ['CORE_TIMEOUT_MS', 'lento', {}],
      ['CORE_MAX_LLAMADAS_POR_CONSULTA', '0', {}],
      ['CORS_ORIGINS', '*', {}],
      ['CORS_ORIGINS', 'https://ok.example.com,https://malo.example.com/ruta', {}],
      ['TRUST_PROXY', 'true', {}],
      ['GRAPHQL_INTROSPECTION', 'quizas', {}],
      ['RATE_LIMIT_MAX', '0', {}],
      ['RATE_LIMIT_SEARCH_MAX', 'muchos', {}],
      ['RATE_LIMIT_SEATMAP_MAX', '-3', {}],
      ['RATE_LIMIT_FLIGHT_STATUS_MAX', '1.5', {}],
      ['RATE_LIMIT_WINDOW_SECONDS', '0', {}],
    ])('%s=%s', (variable, valor, extra) => {
      const mensaje = mensajeDe({ ...BASE, ...extra, [variable]: valor });

      expect(mensaje).toContain(variable);
      // Un valor corto ("0") puede aparecer dentro del rango que explica el mensaje; los largos no
      if (valor.length > 6) expect(mensaje).not.toContain(valor);
      expect(mensaje).not.toMatch(/clave-secreta|secreto-123|sin-puerto-secreto/);
    });
  });

  describe('observabilidad', () => {
    it('valores por defecto: quinde-bff, sin exportador, confía en el gateway, métricas en 9464', () => {
      const c = validarEntorno(BASE);

      expect(c.observabilidad).toMatchObject({
        servicio: 'quinde-bff',
        endpointOtlp: undefined,
        muestreo: 1,
        confiarEntrante: true,
        puertoMetricas: 9464,
      });
      expect(c.observabilidad.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('el muestreo por defecto es 0.1 en production y 1 fuera de ella', () => {
      expect(validarEntorno({ ...BASE, NODE_ENV: 'production' }).observabilidad.muestreo).toBe(0.1);
      expect(validarEntorno({ ...BASE, NODE_ENV: 'development' }).observabilidad.muestreo).toBe(1);
      expect(
        validarEntorno({ ...BASE, NODE_ENV: 'production', OTEL_TRACES_SAMPLER_ARG: '0.5' })
          .observabilidad.muestreo,
      ).toBe(0.5);
      expect(
        validarEntorno({ ...BASE, OTEL_TRACES_SAMPLER_ARG: '0' }).observabilidad.muestreo,
      ).toBe(0);
    });

    it('lee las variables y quita la barra final del endpoint', () => {
      const c = validarEntorno({
        ...BASE,
        OTEL_SERVICE_NAME: 'quinde-bff-2',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318/',
        TRACE_TRUST_INCOMING: 'false',
        METRICS_PORT: '9465',
      });
      expect(c.observabilidad).toMatchObject({
        servicio: 'quinde-bff-2',
        endpointOtlp: 'http://jaeger:4318',
        confiarEntrante: false,
        puertoMetricas: 9465,
      });
    });

    it('una variable vacía (como en .env.example) es una variable sin definir', () => {
      const c = validarEntorno({
        ...BASE,
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        OTEL_TRACES_SAMPLER_ARG: '',
        METRICS_PORT: '',
      });
      expect(c.observabilidad).toMatchObject({
        endpointOtlp: undefined,
        muestreo: 1,
        puertoMetricas: 9464,
      });
    });

    it('METRICS_PORT=0 apaga el puerto de métricas', () => {
      expect(validarEntorno({ ...BASE, METRICS_PORT: '0' }).observabilidad.puertoMetricas).toBe(0);
    });

    it.each([
      ['OTEL_SERVICE_NAME', 'nombre con espacios'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'ftp://jaeger:4318'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://usuario:clave-secreta@jaeger:4318'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://jaeger:4318?token=secreto-123'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'no-es-una-url'],
      ['OTEL_TRACES_SAMPLER_ARG', '1.5'],
      ['OTEL_TRACES_SAMPLER_ARG', '-0.1'],
      ['OTEL_TRACES_SAMPLER_ARG', 'mucho'],
      ['TRACE_TRUST_INCOMING', 'quizas'],
      ['METRICS_PORT', '70000'],
      ['METRICS_PORT', '-1'],
      ['METRICS_PORT', 'abc'],
    ])('%s=%s no arranca y no repite el valor', (variable, valor) => {
      const mensaje = mensajeDe({ ...BASE, [variable]: valor });

      expect(mensaje).toContain(variable);
      if (valor.length > 6) expect(mensaje).not.toContain(valor);
      expect(mensaje).not.toMatch(/clave-secreta|secreto-123/);
    });

    it('METRICS_PORT igual a PORT no arranca (el /metrics saldría por el puerto público)', () => {
      expect(mensajeDe({ ...BASE, PORT: '4000', METRICS_PORT: '4000' })).toMatch(/METRICS_PORT/);
      expect(() => validarEntorno({ ...BASE, PORT: '4000', METRICS_PORT: '0' })).not.toThrow();
    });
  });

  describe('valores válidos', () => {
    it('acepta los extremos de CORE_TIMEOUT_MS (500 y 60000)', () => {
      expect(validarEntorno({ ...BASE, CORE_TIMEOUT_MS: '500' }).timeoutMs).toBe(500);
      expect(validarEntorno({ ...BASE, CORE_TIMEOUT_MS: '60000' }).timeoutMs).toBe(60000);
    });

    it('lee la lista de orígenes CORS y TRUST_PROXY como el core', () => {
      const c = validarEntorno({
        ...BASE,
        CORS_ORIGINS: 'https://a.example.com, http://localhost:5173',
        TRUST_PROXY: '1',
      });
      expect(c.corsOrigenes).toEqual(['https://a.example.com', 'http://localhost:5173']);
      expect(c.trustProxy).toBe(1);
    });

    it('lee los límites de peticiones', () => {
      const c = validarEntorno({
        ...BASE,
        RATE_LIMIT_WINDOW_SECONDS: '30',
        RATE_LIMIT_MAX: '200',
        RATE_LIMIT_SEARCH_MAX: '5',
        RATE_LIMIT_SEATMAP_MAX: '6',
        RATE_LIMIT_FLIGHT_STATUS_MAX: '7',
      });
      expect(c.limites).toEqual({
        ventanaSegundos: 30,
        global: 200,
        searchFlights: 5,
        seatMap: 6,
        flightStatus: 7,
      });
    });
  });
});
