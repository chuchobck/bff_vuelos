/**
 * Respuestas de ejemplo del core, en la forma de su contrato REST (OpenAPI 1.5.0.0). El core
 * falso de gRPC las convierte a mensajes del proto igual que lo hacen los `*.grpc.ts` del core.
 */

export const OFFER_ID = '0f5e8a64-1c63-4c6f-9a07-3c1d6a2b7e10';
export const SEGMENT_ID_1 = '8d2b7c2e-5d0a-4a8e-b3a9-0c1f2e3d4a51';
export const SEGMENT_ID_2 = '5a9c1e7b-2f4d-4c6e-8b0a-7d3e9f1a2c62';
export const OFFER_ID_2 = '9b1d3f5a-7c2e-4e8a-a6b4-1d2c3e4f5a73';

const monto = (total: string, baseFare: string | null = null, taxes: string | null = null) => ({
  currency: 'USD',
  ...(baseFare === null ? {} : { baseFare }),
  ...(taxes === null ? {} : { taxes }),
  total,
});

export function segmento(segmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    segmentId,
    flightNumber: 'AV1500',
    departure: { iataCode: 'UIO', at: '2026-10-22T12:30:00.000Z', terminal: 'A' },
    arrival: { iataCode: 'GYE', at: '2026-10-22T13:25:00.000Z', terminal: null },
    marketingCarrier: 'AV',
    operatingCarrier: 'AV',
    aircraft: 'A320',
    durationMinutes: 55,
    status: 'SCHEDULED',
    ...overrides,
  };
}

function precioCabina(cabinClass: string, total: string) {
  return {
    cabinClass,
    fareBrand: cabinClass === 'ECONOMY' ? 'BASIC' : 'FLEX',
    availableSeats: 9,
    fareRules: { isRefundable: false, isChangeable: cabinClass !== 'ECONOMY' },
    baggageAllowance: { personalItemIncluded: true, carryOnIncluded: 1, checkedBaggageIncluded: 0 },
    extraCheckedBaggagePrice: { currency: 'USD', total: '20.00' },
    pricePerPassengerType: [{ passengerType: 'ADULT', price: monto(total, '60.00', '13.92') }],
  };
}

export function oferta(offerId: string, segmentIds: string[]) {
  return {
    offerId,
    airline: { code: 'AV', name: 'Avianca Ecuador' },
    itineraries: [
      {
        itineraryId: 'c4f8e2a1-6b3d-4d7e-9a05-2e1f3a4b5c84',
        totalDurationMinutes: 55,
        stopsCount: segmentIds.length - 1,
        segments: segmentIds.map((id, i) =>
          segmento(id, i === 0 ? {} : { layoverMinutes: 45, status: null, aircraft: null }),
        ),
        pricingOptions: [precioCabina('ECONOMY', '73.92'), precioCabina('BUSINESS', '189.50')],
      },
    ],
    grandTotal: monto('73.92', '60.00', '13.92'),
  };
}

export const BUSQUEDA = {
  totalOffers: 2,
  offers: [oferta(OFFER_ID, [SEGMENT_ID_1, SEGMENT_ID_2]), oferta(OFFER_ID_2, [SEGMENT_ID_1])],
};

export const MAPA_ASIENTOS = {
  segmentId: SEGMENT_ID_1,
  cabins: [
    {
      cabinClass: 'ECONOMY',
      rows: [
        {
          rowNumber: 12,
          seats: [
            { seatNumber: '12A', isAvailable: true, characteristics: ['WINDOW', 'EXTRA_LEGROOM'] },
            { seatNumber: '12B', isAvailable: false, characteristics: [] },
            { seatNumber: '12C', isAvailable: true, characteristics: ['AISLE', 'EMERGENCY_EXIT'] },
          ],
        },
      ],
    },
  ],
};

export const ESTADO_VUELO = {
  flightNumber: 'AV1500',
  date: '2026-10-22',
  marketingCarrier: 'AV',
  operatingCarrier: 'AV',
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
  aircraft: null,
  status: 'DELAYED',
};
