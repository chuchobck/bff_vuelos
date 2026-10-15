import request from 'supertest';
import { Server } from 'node:http';
import { OFFER_ID, SEGMENT_ID_1 } from '../fixtures/core';

export const HUELLA = 'huella-de-prueba-0123456789';

export interface Respuesta {
  status: number;
  headers: Record<string, string>;
  body: {
    data?: Record<string, any> | null;
    errors?: {
      message: string;
      path?: (string | number)[];
      extensions: Record<string, any>;
    }[];
  };
}

/** POST /graphql con JSON. La huella va por defecto: searchFlights la exige. */
export async function consultar(
  servidor: Server,
  query: string,
  opciones: { variables?: object; headers?: Record<string, string>; sinHuella?: boolean } = {},
): Promise<Respuesta> {
  const cabeceras: Record<string, string> = {
    'content-type': 'application/json',
    ...(opciones.sinHuella ? {} : { 'x-device-fingerprint': HUELLA }),
    ...opciones.headers,
  };
  const r = await request(servidor)
    .post('/graphql')
    .set(cabeceras)
    .send({ query, variables: opciones.variables });
  return { status: r.status, headers: r.headers as Record<string, string>, body: r.body };
}

export const ENTRADA_BUSQUEDA = `{
  itineraries: [{ origin: "UIO", destination: "GYE", departureDate: "2026-10-22" }]
  passengers: { adults: 1 }
}`;

export const Q_SOLO_OFFER_ID = `{ searchFlights(input: ${ENTRADA_BUSQUEDA}) { totalOffers offers { offerId } } }`;

export const Q_BUSQUEDA_COMPLETA = `{
  searchFlights(input: ${ENTRADA_BUSQUEDA}) {
    totalOffers
    offers {
      offerId
      airline { code name }
      grandTotal { currency baseFare taxes total }
      itineraries {
        itineraryId totalDurationMinutes stopsCount
        segments {
          segmentId flightNumber layoverMinutes marketingCarrier operatingCarrier
          aircraft durationMinutes status
          departure { iataCode at terminal }
          arrival { iataCode at terminal }
        }
        pricingOptions {
          cabinClass fareBrand availableSeats
          fareRules { isRefundable isChangeable }
          baggageAllowance { personalItemIncluded carryOnIncluded checkedBaggageIncluded }
          extraCheckedBaggagePrice { currency baseFare taxes total }
          pricePerPassengerType { passengerType price { currency baseFare taxes total } }
        }
      }
    }
  }
}`;

export const Q_MAPA = (offerId = OFFER_ID, segmentId = SEGMENT_ID_1) => `{
  seatMap(offerId: "${offerId}", segmentId: "${segmentId}") {
    segmentId
    cabins { cabinClass rows { rowNumber seats { seatNumber isAvailable characteristics } } }
  }
}`;

export const Q_ESTADO = `{
  flightStatus(flightNumber: "AV1500", date: "2026-10-22") {
    flightNumber date marketingCarrier operatingCarrier aircraft status
    departure { iataCode terminal scheduledAt estimatedAt actualAt }
    arrival { iataCode terminal scheduledAt estimatedAt actualAt }
  }
}`;
