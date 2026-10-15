import {
  esFechaValida,
  esInstanteValido,
  EscalarFecha,
  EscalarInstante,
} from '../src/graphql/escalares';

describe('escalar Date', () => {
  it.each(['2026-10-22', '2024-02-29', '2026-12-31', '0001-01-01'])('acepta %s', (fecha) => {
    expect(esFechaValida(fecha)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-32',
    '2026-1-5',
    '22-10-2026',
    '2026-10-22T00:00:00Z',
    ' 2026-10-22',
    '',
    20261022,
    null,
    undefined,
  ])('rechaza %p', (valor) => {
    expect(esFechaValida(valor)).toBe(false);
  });

  it('parseValue y serialize validan, y el error no repite el valor', () => {
    const escalar = new EscalarFecha();

    expect(escalar.parseValue('2026-10-22')).toBe('2026-10-22');
    expect(escalar.serialize('2026-10-22')).toBe('2026-10-22');
    expect(() => escalar.parseValue('2026-02-30')).toThrow(/valid calendar date/);
    expect(() => escalar.parseValue('2026-02-30')).not.toThrow(/2026-02-30/);
    expect(() => escalar.serialize('basura')).toThrow(TypeError);
  });
});

describe('escalar DateTime', () => {
  it.each(['2026-10-22T12:30:00.000Z', '2026-10-22T12:30:00Z', '2026-10-22T12:30:00.123456789Z'])(
    'acepta %s',
    (instante) => {
      expect(esInstanteValido(instante)).toBe(true);
    },
  );

  it.each([
    '2026-10-22T12:30:00',
    '2026-10-22T12:30:00-05:00',
    '2026-10-22T25:00:00Z',
    '2026-02-30T12:00:00Z',
    '2026-10-22',
    'ayer',
    '',
    1_700_000_000,
    null,
  ])('rechaza %p (solo UTC con Z)', (valor) => {
    expect(esInstanteValido(valor)).toBe(false);
  });

  it('serializa un Date de JavaScript como ISO UTC', () => {
    expect(new EscalarInstante().serialize(new Date('2026-10-22T12:30:00.000Z'))).toBe(
      '2026-10-22T12:30:00.000Z',
    );
  });
});
