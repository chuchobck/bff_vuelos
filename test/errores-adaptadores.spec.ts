import { Metadata, ServiceError, status } from '@grpc/grpc-js';
import { aErrorNucleo as deGrpc } from '../src/nucleo/grpc/nucleo-grpc';
import { aErrorNucleo as deRest } from '../src/nucleo/rest/nucleo-rest';

function errorGrpc(codigo: status, meta: Record<string, string | Buffer> = {}): ServiceError {
  const metadata = new Metadata();
  for (const [clave, valor] of Object.entries(meta)) metadata.set(clave, valor);
  return Object.assign(new Error(`${codigo} mensaje con 127.0.0.1:50051`), {
    code: codigo,
    details: 'mensaje con 127.0.0.1:50051',
    metadata,
  }) as ServiceError;
}

describe('gRPC → ErrorNucleo', () => {
  it.each([
    [status.INVALID_ARGUMENT, 'INVALID_ARGUMENT', 'VALIDATION_FAILED', 400],
    [status.NOT_FOUND, 'NOT_FOUND', 'NOT_FOUND', 404],
    [status.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 429],
    [status.UNAVAILABLE, 'UNAVAILABLE', 'CORE_UNAVAILABLE', 503],
    [status.DEADLINE_EXCEEDED, 'DEADLINE_EXCEEDED', 'CORE_TIMEOUT', 504],
    [status.UNIMPLEMENTED, 'INTERNAL', 'CORE_ERROR', 500],
    [status.INTERNAL, 'INTERNAL', 'CORE_ERROR', 500],
    [status.FAILED_PRECONDITION, 'INTERNAL', 'CORE_ERROR', 500],
    [status.UNAUTHENTICATED, 'INTERNAL', 'CORE_ERROR', 500],
  ])('el código %i sin problem-* es %s (%s, %i)', (codigo, categoria, problemCode, estado) => {
    const e = deGrpc(errorGrpc(codigo));

    expect(e).toMatchObject({
      categoria,
      problemCode,
      status: estado,
      detalle: null,
      retryAfter: null,
    });
    expect(e.message).not.toContain('127.0.0.1');
  });

  it('lee problem-code, problem-status, problem-details-bin y retry-after', () => {
    const problema = {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'The database is not responding',
      code: 'SERVICE_UNAVAILABLE',
      invalidParams: [{ name: 'campo', reason: 'motivo' }],
    };
    const e = deGrpc(
      errorGrpc(status.UNAVAILABLE, {
        'problem-code': 'SERVICE_UNAVAILABLE',
        'problem-status': '503',
        'problem-details-bin': Buffer.from(JSON.stringify(problema), 'utf8'),
        'retry-after': '5',
      }),
    );

    expect(e).toMatchObject({
      categoria: 'UNAVAILABLE',
      problemCode: 'SERVICE_UNAVAILABLE',
      status: 503,
      detalle: 'The database is not responding',
      retryAfter: 5,
      invalidParams: [{ name: 'campo', reason: 'motivo' }],
    });
  });

  it('lee el JSON de problem-details-bin como UTF-8', () => {
    const e = deGrpc(
      errorGrpc(status.NOT_FOUND, {
        'problem-details-bin': Buffer.from(
          JSON.stringify({ detail: 'Vuelo no encontrado: ñandú ✈' }),
          'utf8',
        ),
      }),
    );

    expect(e.detalle).toBe('Vuelo no encontrado: ñandú ✈');
  });

  it('un problem-details-bin que no es JSON no rompe: queda lo que dicen problem-code y problem-status', () => {
    const e = deGrpc(
      errorGrpc(status.NOT_FOUND, {
        'problem-code': 'FLIGHT_STATUS_NOT_AVAILABLE',
        'problem-status': '404',
        'problem-details-bin': Buffer.from('{no es json', 'utf8'),
      }),
    );

    expect(e).toMatchObject({
      categoria: 'NOT_FOUND',
      problemCode: 'FLIGHT_STATUS_NOT_AVAILABLE',
      status: 404,
      detalle: null,
    });
  });

  it.each(['abc', '0', '-5', '1.5', '86401', '', ' '])(
    'un retry-after inválido (%p) se ignora',
    (valor) => {
      expect(deGrpc(errorGrpc(status.UNAVAILABLE, { 'retry-after': valor })).retryAfter).toBeNull();
    },
  );

  it.each(['minuscula', 'CON ESPACIO', 'X', 'a;b'])(
    'un problem-code raro (%p) no se acepta',
    (codigo) => {
      expect(deGrpc(errorGrpc(status.NOT_FOUND, { 'problem-code': codigo })).problemCode).toBe(
        'NOT_FOUND',
      );
    },
  );

  it('el detail se limpia de saltos de línea y se acorta', () => {
    const e = deGrpc(
      errorGrpc(status.NOT_FOUND, {
        'problem-details-bin': Buffer.from(
          JSON.stringify({ detail: `uno\ndos\r\ntres ${'x'.repeat(1000)}` }),
          'utf8',
        ),
      }),
    );

    expect(e.detalle).not.toMatch(/[\n\r]/);
    expect(e.detalle!.length).toBeLessThanOrEqual(300);
  });
});

describe('REST → ErrorNucleo', () => {
  const respuesta = (statusHttp: number, cabeceras: Record<string, string> = {}) =>
    new Response('', { status: statusHttp, headers: cabeceras });

  it.each([
    [400, 'INVALID_ARGUMENT'],
    [404, 'NOT_FOUND'],
    [413, 'RESOURCE_EXHAUSTED'],
    [429, 'RESOURCE_EXHAUSTED'],
    [502, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
    [504, 'DEADLINE_EXCEEDED'],
    [500, 'INTERNAL'],
    [409, 'INTERNAL'],
    [401, 'INTERNAL'],
  ])('un %i es %s', (estado, categoria) => {
    expect(deRest(respuesta(estado), '').categoria).toBe(categoria);
  });

  it('lee el ProblemDetails y Retry-After', () => {
    const cuerpo = JSON.stringify({
      type: 'x',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many requests; retry in 12 seconds',
      code: 'RATE_LIMIT_EXCEEDED',
    });

    const e = deRest(respuesta(429, { 'Retry-After': '12' }), cuerpo);

    expect(e).toMatchObject({
      categoria: 'RESOURCE_EXHAUSTED',
      problemCode: 'RATE_LIMIT_EXCEEDED',
      status: 429,
      retryAfter: 12,
      detalle: 'Too many requests; retry in 12 seconds',
    });
  });

  it('un cuerpo HTML (proxy) no rompe: se explica por el status', () => {
    const e = deRest(respuesta(502), '<html>Bad gateway</html>');

    expect(e).toMatchObject({
      categoria: 'UNAVAILABLE',
      problemCode: 'CORE_UNAVAILABLE',
      status: 502,
      detalle: null,
    });
  });

  it('un Retry-After como fecha HTTP se ignora', () => {
    expect(
      deRest(respuesta(503, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }), '').retryAfter,
    ).toBeNull();
  });
});
