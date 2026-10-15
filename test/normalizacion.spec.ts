import { ErrorNucleo } from '../src/nucleo/error-nucleo';
import { NORMALIZADOR_GRPC, NORMALIZADOR_REST } from '../src/nucleo/normalizacion';
import { BUSQUEDA, ESTADO_VUELO, MAPA_ASIENTOS } from './fixtures/core';
import { aMensajeProto } from './utils/core-falso';

/** Lo que llega por gRPC: enums con prefijo y los optional sin valor omitidos. */
const comoGrpc = (valor: unknown): any => aMensajeProto(valor);
/** Lo que llega por REST: el JSON del contrato tal cual. */
const comoRest = (valor: unknown): any => structuredClone(valor);

function falla(accion: () => unknown): ErrorNucleo {
  try {
    accion();
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorNucleo);
    return e as ErrorNucleo;
  }
  throw new Error('debía fallar');
}

/** Una búsqueda de un solo segmento con el `status` dado (undefined = el campo no viene). */
function busquedaConEstado(status: unknown, comoPrefijado: boolean) {
  const base = structuredClone(BUSQUEDA) as any;
  base.offers = [base.offers[1]];
  const segmento = base.offers[0].itineraries[0].segments[0];
  if (status === undefined) delete segmento.status;
  else segmento.status = status;
  const entrada = comoPrefijado ? comoGrpc(base) : base;
  // aMensajeProto convierte el status de la fixture; el valor de la prueba manda
  if (comoPrefijado) {
    const s = entrada.offers[0].itineraries[0].segments[0];
    if (status === undefined) delete s.status;
    else s.status = status;
  }
  return entrada;
}
const estadoDelSegmento = (r: any) => r.offers[0].itineraries[0].segments[0].status;

describe('Normalizador: enums sin prefijo', () => {
  it.each(['SCHEDULED', 'BOARDING', 'DEPARTED', 'DELAYED', 'ARRIVED', 'CANCELLED', 'DIVERTED'])(
    'FlightStatus %s',
    (estado) => {
      const g = NORMALIZADOR_GRPC.estadoVuelo({
        ...comoGrpc(ESTADO_VUELO),
        status: `FLIGHT_STATUS_${estado}`,
      });
      const r = NORMALIZADOR_REST.estadoVuelo({ ...ESTADO_VUELO, status: estado });

      expect(g.status).toBe(estado);
      expect(r.status).toBe(estado);
    },
  );

  it.each(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'])('CabinClass %s', (clase) => {
    const g = comoGrpc(MAPA_ASIENTOS);
    g.cabins[0].cabinClass = `CABIN_CLASS_${clase}`;
    const r = comoRest(MAPA_ASIENTOS);
    r.cabins[0].cabinClass = clase;

    expect(NORMALIZADOR_GRPC.mapaAsientos(g).cabins[0].cabinClass).toBe(clase);
    expect(NORMALIZADOR_REST.mapaAsientos(r).cabins[0].cabinClass).toBe(clase);
  });

  it.each(['ADULT', 'YOUTH', 'CHILD', 'INFANT'])('PassengerType %s', (tipo) => {
    const g = comoGrpc(BUSQUEDA);
    g.offers[0].itineraries[0].pricingOptions[0].pricePerPassengerType[0].passengerType = `PASSENGER_TYPE_${tipo}`;
    const r = comoRest(BUSQUEDA);
    r.offers[0].itineraries[0].pricingOptions[0].pricePerPassengerType[0].passengerType = tipo;

    const precio = (x: any) =>
      x.offers[0].itineraries[0].pricingOptions[0].pricePerPassengerType[0];
    expect(precio(NORMALIZADOR_GRPC.busqueda(g)).passengerType).toBe(tipo);
    expect(precio(NORMALIZADOR_REST.busqueda(r)).passengerType).toBe(tipo);
  });

  it.each(['WINDOW', 'AISLE', 'EXTRA_LEGROOM', 'EMERGENCY_EXIT'])('SeatCharacteristic %s', (c) => {
    const g = comoGrpc(MAPA_ASIENTOS);
    g.cabins[0].rows[0].seats[0].characteristics = [`SEAT_CHARACTERISTIC_${c}`];
    const r = comoRest(MAPA_ASIENTOS);
    r.cabins[0].rows[0].seats[0].characteristics = [c];

    expect(NORMALIZADOR_GRPC.mapaAsientos(g).cabins[0].rows[0].seats[0].characteristics).toEqual([
      c,
    ]);
    expect(NORMALIZADOR_REST.mapaAsientos(r).cabins[0].rows[0].seats[0].characteristics).toEqual([
      c,
    ]);
  });
});

describe('Normalizador: lo que falta es null', () => {
  it('FLIGHT_STATUS_UNSPECIFIED, un status ausente y un null son null', () => {
    expect(
      estadoDelSegmento(
        NORMALIZADOR_GRPC.busqueda(busquedaConEstado('FLIGHT_STATUS_UNSPECIFIED', true)),
      ),
    ).toBeNull();
    expect(
      estadoDelSegmento(NORMALIZADOR_GRPC.busqueda(busquedaConEstado(undefined, true))),
    ).toBeNull();
    expect(
      estadoDelSegmento(NORMALIZADOR_REST.busqueda(busquedaConEstado(null, false))),
    ).toBeNull();
    expect(
      estadoDelSegmento(NORMALIZADOR_REST.busqueda(busquedaConEstado(undefined, false))),
    ).toBeNull();
  });

  it('un estado que el BFF aún no conoce es null donde el contrato lo permite', () => {
    expect(
      estadoDelSegmento(
        NORMALIZADOR_GRPC.busqueda(busquedaConEstado('FLIGHT_STATUS_HOLDING', true)),
      ),
    ).toBeNull();
    expect(
      estadoDelSegmento(NORMALIZADOR_REST.busqueda(busquedaConEstado('HOLDING', false))),
    ).toBeNull();
  });

  it('REST no reconoce un valor con prefijo y gRPC no reconoce uno sin prefijo', () => {
    // Cada adaptador espera la forma de su transporte: mezclarlas daría estados falsos
    expect(
      estadoDelSegmento(
        NORMALIZADOR_REST.busqueda(busquedaConEstado('FLIGHT_STATUS_SCHEDULED', false)),
      ),
    ).toBeNull();
    expect(
      estadoDelSegmento(NORMALIZADOR_GRPC.busqueda(busquedaConEstado('SCHEDULED', true))),
    ).toBeNull();
  });

  it('un enum obligatorio sin valor conocido es una respuesta inválida del core (INTERNAL)', () => {
    for (const status of ['FLIGHT_STATUS_UNSPECIFIED', 'FLIGHT_STATUS_HOLDING', undefined]) {
      const entrada = comoGrpc(ESTADO_VUELO);
      if (status === undefined) delete entrada.status;
      else entrada.status = status;
      const e = falla(() => NORMALIZADOR_GRPC.estadoVuelo(entrada));
      expect(e).toMatchObject({
        categoria: 'INTERNAL',
        problemCode: 'CORE_BAD_RESPONSE',
        status: 502,
      });
    }
    const cabina = comoRest(MAPA_ASIENTOS);
    cabina.cabins[0].cabinClass = null;
    expect(falla(() => NORMALIZADOR_REST.mapaAsientos(cabina)).categoria).toBe('INTERNAL');
  });

  it('una característica de asiento desconocida o UNSPECIFIED se descarta, sin romper el mapa', () => {
    const g = comoGrpc(MAPA_ASIENTOS);
    g.cabins[0].rows[0].seats[0].characteristics = [
      'SEAT_CHARACTERISTIC_UNSPECIFIED',
      'SEAT_CHARACTERISTIC_WINDOW',
      'SEAT_CHARACTERISTIC_JETBRIDGE',
    ];

    expect(NORMALIZADOR_GRPC.mapaAsientos(g).cabins[0].rows[0].seats[0].characteristics).toEqual([
      'WINDOW',
    ]);
  });

  it('terminal, aircraft, layoverMinutes y baseFare ausentes son null en los dos', () => {
    const g = NORMALIZADOR_GRPC.busqueda(comoGrpc(BUSQUEDA)).offers[0].itineraries[0];
    const r = NORMALIZADOR_REST.busqueda(comoRest(BUSQUEDA)).offers[0].itineraries[0];

    for (const itinerario of [g, r]) {
      expect(itinerario.segments[0].layoverMinutes).toBeNull();
      expect(itinerario.segments[1].aircraft).toBeNull();
      expect(itinerario.segments[0].arrival.terminal).toBeNull();
      expect(itinerario.pricingOptions[0].extraCheckedBaggagePrice?.baseFare).toBeNull();
    }
    expect(g).toStrictEqual(r);
  });

  it('extraCheckedBaggagePrice ausente es null', () => {
    const r = comoRest(BUSQUEDA);
    delete r.offers[0].itineraries[0].pricingOptions[0].extraCheckedBaggagePrice;

    expect(
      NORMALIZADOR_REST.busqueda(r).offers[0].itineraries[0].pricingOptions[0]
        .extraCheckedBaggagePrice,
    ).toBeNull();
  });
});

describe('Normalizador: dinero y forma', () => {
  it.each([73.92, 0, '73,92', 'abc', '1e5', '', null, undefined, {}])(
    'un total que no es un decimal en texto (%p) es una respuesta inválida',
    (total) => {
      const r = comoRest(BUSQUEDA);
      if (total === undefined) delete r.offers[0].grandTotal.total;
      else r.offers[0].grandTotal.total = total;

      const e = falla(() => NORMALIZADOR_REST.busqueda(r));

      expect(e.problemCode).toBe('CORE_BAD_RESPONSE');
      expect(e.message).toContain('grandTotal.total');
    },
  );

  it('acepta decimales válidos como texto y los deja intactos', () => {
    for (const total of ['0', '73.92', '1000000.5', '-5.00']) {
      const r = comoRest(BUSQUEDA);
      r.offers[0].grandTotal.total = total;
      expect(NORMALIZADOR_REST.busqueda(r).offers[0].grandTotal.total).toBe(total);
    }
  });

  it('el error nombra el campo y nunca el valor recibido', () => {
    const r = comoRest(BUSQUEDA);
    r.offers[0].grandTotal.total = 'valor-que-no-debe-salir';

    const e = falla(() => NORMALIZADOR_REST.busqueda(r));

    expect(e.message).not.toContain('valor-que-no-debe-salir');
  });

  it.each([
    ['offers no es una lista', (r: any) => (r.offers = 'x')],
    ['totalOffers no es un entero', (r: any) => (r.totalOffers = '2')],
    ['falta la aerolínea', (r: any) => delete r.offers[0].airline],
    ['falta fareRules', (r: any) => delete r.offers[0].itineraries[0].pricingOptions[0].fareRules],
  ])('%s es una respuesta inválida y no un dato a medias', (_caso, mutar) => {
    const r = comoRest(BUSQUEDA);
    mutar(r);

    expect(falla(() => NORMALIZADOR_REST.busqueda(r)).problemCode).toBe('CORE_BAD_RESPONSE');
  });

  it('una respuesta que no es un objeto es inválida', () => {
    for (const crudo of [null, undefined, 'texto', 42, []]) {
      expect(falla(() => NORMALIZADOR_REST.busqueda(crudo)).problemCode).toBe('CORE_BAD_RESPONSE');
    }
  });

  it('un asiento con isAvailable que no es booleano es inválido', () => {
    const r = comoRest(MAPA_ASIENTOS);
    r.cabins[0].rows[0].seats[0].isAvailable = 'si';

    expect(falla(() => NORMALIZADOR_REST.mapaAsientos(r)).message).toContain('isAvailable');
  });
});
