import { TransporteNucleo } from '../src/config/entorno';
import {
  BUSQUEDA,
  ESTADO_VUELO,
  MAPA_ASIENTOS,
  OFFER_ID,
  OFFER_ID_2,
  SEGMENT_ID_1,
  SEGMENT_ID_2,
} from './fixtures/core';
import { CoreFalso, crearCoreFalso } from './utils/core-falso';
import { AppDePrueba, crearApp } from './utils/crear-app';
import { consultar, Q_BUSQUEDA_COMPLETA, Q_ESTADO, Q_MAPA, Q_SOLO_OFFER_ID } from './utils/graphql';

const TRANSPORTES: TransporteNucleo[] = ['grpc', 'rest'];

const MONTO_73 = { currency: 'USD', baseFare: '60.00', taxes: '13.92', total: '73.92' };

const PRIMERA_OFERTA = {
  offerId: OFFER_ID,
  airline: { code: 'AV', name: 'Avianca Ecuador' },
  grandTotal: MONTO_73,
  itineraries: [
    {
      itineraryId: 'c4f8e2a1-6b3d-4d7e-9a05-2e1f3a4b5c84',
      totalDurationMinutes: 55,
      stopsCount: 1,
      segments: [
        {
          segmentId: SEGMENT_ID_1,
          flightNumber: 'AV1500',
          layoverMinutes: null,
          marketingCarrier: 'AV',
          operatingCarrier: 'AV',
          aircraft: 'A320',
          durationMinutes: 55,
          status: 'SCHEDULED',
          departure: { iataCode: 'UIO', at: '2026-10-22T12:30:00.000Z', terminal: 'A' },
          arrival: { iataCode: 'GYE', at: '2026-10-22T13:25:00.000Z', terminal: null },
        },
        {
          segmentId: SEGMENT_ID_2,
          flightNumber: 'AV1500',
          layoverMinutes: 45,
          marketingCarrier: 'AV',
          operatingCarrier: 'AV',
          aircraft: null,
          durationMinutes: 55,
          status: null,
          departure: { iataCode: 'UIO', at: '2026-10-22T12:30:00.000Z', terminal: 'A' },
          arrival: { iataCode: 'GYE', at: '2026-10-22T13:25:00.000Z', terminal: null },
        },
      ],
      pricingOptions: [
        {
          cabinClass: 'ECONOMY',
          fareBrand: 'BASIC',
          availableSeats: 9,
          fareRules: { isRefundable: false, isChangeable: false },
          baggageAllowance: {
            personalItemIncluded: true,
            carryOnIncluded: 1,
            checkedBaggageIncluded: 0,
          },
          extraCheckedBaggagePrice: {
            currency: 'USD',
            baseFare: null,
            taxes: null,
            total: '20.00',
          },
          pricePerPassengerType: [{ passengerType: 'ADULT', price: MONTO_73 }],
        },
        {
          cabinClass: 'BUSINESS',
          fareBrand: 'FLEX',
          availableSeats: 9,
          fareRules: { isRefundable: false, isChangeable: true },
          baggageAllowance: {
            personalItemIncluded: true,
            carryOnIncluded: 1,
            checkedBaggageIncluded: 0,
          },
          extraCheckedBaggagePrice: {
            currency: 'USD',
            baseFare: null,
            taxes: null,
            total: '20.00',
          },
          pricePerPassengerType: [
            {
              passengerType: 'ADULT',
              price: { currency: 'USD', baseFare: '60.00', taxes: '13.92', total: '189.50' },
            },
          ],
        },
      ],
    },
  ],
};

describe.each(TRANSPORTES)('BFF GraphQL sobre el core por %s', (transporte) => {
  let core: CoreFalso;
  let app: AppDePrueba;

  beforeAll(async () => {
    core = await crearCoreFalso(transporte);
    app = await crearApp({ core });
  });

  afterAll(async () => {
    await app.cerrar();
    await core.detener();
  });

  beforeEach(() => core.reiniciar());

  describe('lecturas con fixtures', () => {
    it('searchFlights devuelve las ofertas con la forma del contrato', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_COMPLETA);

      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.searchFlights.totalOffers).toBe(2);
      expect(r.body.data?.searchFlights.offers[0]).toEqual(PRIMERA_OFERTA);
      expect(r.body.data?.searchFlights.offers[1].offerId).toBe(OFFER_ID_2);
    });

    it('seatMap devuelve cabinas, filas y asientos con sus características', async () => {
      const r = await consultar(app.servidor, Q_MAPA());

      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.seatMap).toEqual({
        segmentId: SEGMENT_ID_1,
        cabins: [
          {
            cabinClass: 'ECONOMY',
            rows: [
              {
                rowNumber: 12,
                seats: [
                  {
                    seatNumber: '12A',
                    isAvailable: true,
                    characteristics: ['WINDOW', 'EXTRA_LEGROOM'],
                  },
                  { seatNumber: '12B', isAvailable: false, characteristics: [] },
                  {
                    seatNumber: '12C',
                    isAvailable: true,
                    characteristics: ['AISLE', 'EMERGENCY_EXIT'],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it('flightStatus devuelve el estado con lo que falta como null', async () => {
      const r = await consultar(app.servidor, Q_ESTADO);

      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.flightStatus).toEqual({
        flightNumber: 'AV1500',
        date: '2026-10-22',
        marketingCarrier: 'AV',
        operatingCarrier: 'AV',
        aircraft: null,
        status: 'DELAYED',
        departure: {
          iataCode: 'UIO',
          terminal: 'A',
          scheduledAt: '2026-10-22T12:30:00.000Z',
          estimatedAt: '2026-10-22T12:50:00.000Z',
          actualAt: null,
        },
        arrival: {
          iataCode: 'GYE',
          terminal: null,
          scheduledAt: '2026-10-22T13:25:00.000Z',
          estimatedAt: null,
          actualAt: null,
        },
      });
    });

    it('searchFlights sin resultados es la lista vacía', async () => {
      core.responder('search', { tipo: 'ok', cuerpo: { totalOffers: 0, offers: [] } });

      const r = await consultar(app.servidor, Q_SOLO_OFFER_ID);

      expect(r.body.errors).toBeUndefined();
      expect(r.body.data?.searchFlights).toEqual({ totalOffers: 0, offers: [] });
    });

    it('manda al core lo que pidió el cliente', async () => {
      await consultar(
        app.servidor,
        `{ searchFlights(input: {
          itineraries: [
            { origin: "UIO", destination: "GYE", departureDate: "2026-10-22" }
            { origin: "GYE", destination: "UIO", departureDate: "2026-10-29" }
          ]
          passengers: { adults: 2, infants: 1 }
        }) { totalOffers } }`,
      );
      await consultar(app.servidor, Q_MAPA(OFFER_ID, SEGMENT_ID_2));
      await consultar(app.servidor, Q_ESTADO);

      expect(core.llamadas.map((l) => l.peticion)).toEqual([
        {
          itineraries: [
            { origin: 'UIO', destination: 'GYE', departureDate: '2026-10-22' },
            { origin: 'GYE', destination: 'UIO', departureDate: '2026-10-29' },
          ],
          passengers: { adults: 2, infants: 1 },
        },
        { offerId: OFFER_ID, segmentId: SEGMENT_ID_2 },
        { flightNumber: 'AV1500', date: '2026-10-22' },
      ]);
    });
  });

  describe('enums, null y dinero', () => {
    it('un enum UNSPECIFIED o ausente es null, y los demás van sin prefijo', async () => {
      const estados = [
        'SCHEDULED',
        'BOARDING',
        'DEPARTED',
        'DELAYED',
        'ARRIVED',
        'CANCELLED',
        'DIVERTED',
      ];
      const resultados: unknown[] = [];
      for (const estado of estados) {
        core.responder('status', { tipo: 'ok', cuerpo: { ...ESTADO_VUELO, status: estado } });
        const r = await consultar(app.servidor, Q_ESTADO);
        resultados.push(r.body.data?.flightStatus.status);
      }
      expect(resultados).toEqual(estados);

      // El segmento 2 de la fixture no trae estado: null en REST, FLIGHT_STATUS_UNSPECIFIED en gRPC
      core.reiniciar();
      const r = await consultar(app.servidor, Q_BUSQUEDA_COMPLETA);
      const segmentos = r.body.data?.searchFlights.offers[0].itineraries[0].segments;
      expect(segmentos[0].status).toBe('SCHEDULED');
      expect(segmentos[1].status).toBeNull();
    });

    it('lo opcional que falta (terminal, aircraft, layoverMinutes, baseFare) es null', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_COMPLETA);
      const itinerario = r.body.data?.searchFlights.offers[0].itineraries[0];

      expect(itinerario.segments[0].layoverMinutes).toBeNull();
      expect(itinerario.segments[1].aircraft).toBeNull();
      expect(itinerario.segments[0].arrival.terminal).toBeNull();
      expect(itinerario.pricingOptions[0].extraCheckedBaggagePrice.baseFare).toBeNull();
      expect(itinerario.pricingOptions[0].extraCheckedBaggagePrice.taxes).toBeNull();
    });

    it('un enum que el contrato exige y no llega es un error interno, sin el dato del core', async () => {
      const sinCabina: any = structuredClone(MAPA_ASIENTOS);
      sinCabina.cabins[0].cabinClass = null;
      core.responder('seatMap', { tipo: 'ok', cuerpo: sinCabina });

      const r = await consultar(app.servidor, Q_MAPA());

      expect(r.body.errors?.[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
      expect(r.body.errors?.[0].message).toBe('Internal server error');
    });

    it('el dinero siempre llega como texto decimal, nunca como número', async () => {
      const r = await consultar(app.servidor, Q_BUSQUEDA_COMPLETA);

      const montos: Record<string, unknown>[] = [];
      for (const oferta of r.body.data?.searchFlights.offers ?? []) {
        montos.push(oferta.grandTotal);
        for (const itinerario of oferta.itineraries) {
          for (const opcion of itinerario.pricingOptions) {
            montos.push(
              opcion.extraCheckedBaggagePrice,
              ...opcion.pricePerPassengerType.map((p: any) => p.price),
            );
          }
        }
      }
      expect(montos.length).toBeGreaterThan(4);
      for (const monto of montos) {
        for (const campo of ['baseFare', 'taxes', 'total'] as const) {
          const valor = monto[campo];
          expect(valor === null || (typeof valor === 'string' && /^\d+\.\d{2}$/.test(valor))).toBe(
            true,
          );
        }
      }
    });

    // En gRPC un number no cabe en un campo string del proto: solo REST puede mandarlo así
    (transporte === 'rest' ? it : it.skip)(
      'un monto que el core manda como número es una respuesta inválida, no un dinero redondeado',
      async () => {
        const numerico = structuredClone(BUSQUEDA);
        (numerico.offers[0].grandTotal as Record<string, unknown>).total = 73.92;
        core.responder('search', { tipo: 'ok', cuerpo: numerico });

        const r = await consultar(app.servidor, Q_SOLO_OFFER_ID);

        expect(r.body.errors?.[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
        expect(r.body.errors?.[0].message).toBe('Internal server error');
      },
    );
  });
});
