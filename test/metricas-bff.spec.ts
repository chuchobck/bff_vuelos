import { Registry } from 'prom-client';
import { CUBETAS_LLAMADAS_AL_CORE, MetricasBff } from '../src/telemetria/metricas-bff';
import {
  CAMPOS_RAIZ_DEL_ESQUEMA,
  campoRaizSeguro,
  filtrarAtributosBff,
} from '../src/telemetria/atributos-bff';
import { series } from './utils/http';

describe('MetricasBff', () => {
  let registro: Registry;
  let bff: MetricasBff;

  beforeEach(() => {
    registro = new Registry();
    bff = new MetricasBff(registro);
  });

  it('mil campos raíz inventados son una sola serie: __other__', async () => {
    for (let i = 0; i < 1000; i++) bff.campo(`campoInventado${i}`);
    bff.campo('searchFlights');
    bff.campo('seatMap', 3);

    const s = series(await registro.metrics(), 'graphql_root_fields_total');
    expect([...s.keys()].sort()).toEqual([
      '{field="__other__"}',
      '{field="searchFlights"}',
      '{field="seatMap"}',
    ]);
    expect(s.get('{field="__other__"}')).toBe(1000);
    expect(s.get('{field="seatMap"}')).toBe(3);
  });

  it('mil códigos inventados son una sola serie: __other__', async () => {
    for (let i = 0; i < 1000; i++) bff.error(`CODIGO_INVENTADO_${i}`);
    bff.error(undefined);
    bff.error(42);
    bff.error({ code: 'NOT_FOUND' });
    bff.error('NOT_FOUND');
    bff.error('NOT_FOUND');

    const s = series(await registro.metrics(), 'graphql_errors_total');
    expect([...s.keys()].sort()).toEqual(['{code="NOT_FOUND"}', '{code="__other__"}']);
    expect(s.get('{code="__other__"}')).toBe(1003);
    expect(s.get('{code="NOT_FOUND"}')).toBe(2);
  });

  it('bff_core_calls_per_query usa las cubetas 0 a 100 y acumula', async () => {
    for (const n of [0, 1, 1, 4, 10, 11]) bff.consulta(n);

    const texto = await registro.metrics();
    const cubetas = series(texto, 'bff_core_calls_per_query_bucket');
    expect([...cubetas.keys()].map((k) => /le="([^"]+)"/.exec(k)?.[1])).toEqual([
      ...CUBETAS_LLAMADAS_AL_CORE.map(String),
      '+Inf',
    ]);
    expect(cubetas.get('{le="0"}')).toBe(1);
    expect(cubetas.get('{le="1"}')).toBe(3);
    expect(cubetas.get('{le="10"}')).toBe(5);
    expect(cubetas.get('{le="+Inf"}')).toBe(6);
    expect(series(texto, 'bff_core_calls_per_query_sum').get('')).toBe(27);
  });
});

describe('atributos del BFF', () => {
  it('campoRaizSeguro deja pasar solo los campos del esquema', () => {
    for (const campo of CAMPOS_RAIZ_DEL_ESQUEMA) expect(campoRaizSeguro(campo)).toBe(campo);
    for (const otro of [
      '',
      'a',
      'estadoSecreto',
      'SEARCHFLIGHTS',
      'searchFlights,seatMap',
      '__typename',
    ]) {
      expect(campoRaizSeguro(otro)).toBe('__other__');
    }
  });

  it('un atributo del BFF con un valor fuera de su conjunto cerrado se descarta', () => {
    expect(
      filtrarAtributosBff({
        'graphql.operation.type': 'query { secreto }',
        'graphql.root_fields': 'searchFlights,aliasInventado',
        'rpc.system': 'http',
        'rpc.service': 'otro.Servicio',
        'rpc.method': 'Inventada',
        'rpc.grpc.status_code': 99,
      }),
    ).toEqual({});
  });

  it('los valores de los conjuntos cerrados pasan, y un atributo desconocido nunca', () => {
    expect(
      filtrarAtributosBff({
        'graphql.operation.type': 'query',
        'graphql.root_fields': 'flightStatus,seatMap,__other__',
        'rpc.system': 'grpc',
        'rpc.service': 'quinde.flights.v1.FlightsService',
        'rpc.method': 'GetSeatMap',
        'rpc.grpc.status_code': 14,
        'graphql.document': '{ secreto }',
        'http.request.query': 'token=secreto',
        'quinde.upstream': 'core',
      }),
    ).toEqual({
      'graphql.operation.type': 'query',
      'graphql.root_fields': 'flightStatus,seatMap,__other__',
      'rpc.system': 'grpc',
      'rpc.service': 'quinde.flights.v1.FlightsService',
      'rpc.method': 'GetSeatMap',
      'rpc.grpc.status_code': 14,
      'quinde.upstream': 'core',
    });
  });
});
