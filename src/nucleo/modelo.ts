/**
 * El tipo de dominio del BFF: la misma forma que el GraphQL (src/graphql/schema.graphql) y que
 * los esquemas del contrato OpenAPI del core. Los dos adaptadores (gRPC y REST) devuelven
 * exactamente esto:
 *   - enums sin prefijo (FLIGHT_STATUS_SCHEDULED del proto es 'SCHEDULED');
 *   - lo que falta es `null` (un optional sin valor, un null de REST y *_UNSPECIFIED);
 *   - dinero siempre texto decimal ('73.92'), fechas y horas como texto.
 */

export const ESTADOS_VUELO = [
  'SCHEDULED',
  'BOARDING',
  'DEPARTED',
  'DELAYED',
  'ARRIVED',
  'CANCELLED',
  'DIVERTED',
] as const;
export const CLASES_CABINA = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const;
export const TIPOS_PASAJERO = ['ADULT', 'YOUTH', 'CHILD', 'INFANT'] as const;
export const CARACTERISTICAS_ASIENTO = [
  'WINDOW',
  'AISLE',
  'EXTRA_LEGROOM',
  'EMERGENCY_EXIT',
] as const;

export type EstadoVuelo = (typeof ESTADOS_VUELO)[number];
export type ClaseCabina = (typeof CLASES_CABINA)[number];
export type TipoPasajero = (typeof TIPOS_PASAJERO)[number];
export type CaracteristicaAsiento = (typeof CARACTERISTICAS_ASIENTO)[number];

// --- Entrada de la búsqueda (SearchInput) -----------------------------------------------------

export interface TramoBusqueda {
  origin: string;
  destination: string;
  /** "YYYY-MM-DD" */
  departureDate: string;
}

/** Un campo que no viene toma el valor por defecto del contrato (lo decide el core). */
export interface PasajerosBusqueda {
  adults?: number | null;
  youths?: number | null;
  children?: number | null;
  infants?: number | null;
}

export interface EntradaBusqueda {
  itineraries: TramoBusqueda[];
  passengers: PasajerosBusqueda;
}

// --- SearchResult -----------------------------------------------------------------------------

export interface Monto {
  currency: string;
  baseFare: string | null;
  taxes: string | null;
  total: string;
}

export interface Aerolinea {
  code: string;
  name: string;
}

export interface ExtremoVuelo {
  iataCode: string;
  /** Instante en UTC (ISO 8601). */
  at: string;
  terminal: string | null;
}

export interface SegmentoVuelo {
  segmentId: string;
  flightNumber: string;
  departure: ExtremoVuelo;
  arrival: ExtremoVuelo;
  layoverMinutes: number | null;
  marketingCarrier: string;
  operatingCarrier: string;
  aircraft: string | null;
  durationMinutes: number | null;
  status: EstadoVuelo | null;
}

export interface PrecioPorTipoPasajero {
  passengerType: TipoPasajero;
  price: Monto;
}

export interface PrecioCabina {
  cabinClass: ClaseCabina;
  fareBrand: string;
  availableSeats: number;
  fareRules: { isRefundable: boolean; isChangeable: boolean };
  baggageAllowance: {
    personalItemIncluded: boolean;
    carryOnIncluded: number;
    checkedBaggageIncluded: number;
  };
  extraCheckedBaggagePrice: Monto | null;
  pricePerPassengerType: PrecioPorTipoPasajero[];
}

export interface OpcionItinerario {
  itineraryId: string;
  totalDurationMinutes: number;
  stopsCount: number;
  segments: SegmentoVuelo[];
  pricingOptions: PrecioCabina[];
}

export interface OfertaVuelo {
  offerId: string;
  airline: Aerolinea;
  itineraries: OpcionItinerario[];
  grandTotal: Monto;
}

export interface ResultadoBusqueda {
  totalOffers: number;
  offers: OfertaVuelo[];
}

// --- SeatMap ----------------------------------------------------------------------------------

export interface Asiento {
  seatNumber: string;
  isAvailable: boolean;
  characteristics: CaracteristicaAsiento[];
}

export interface FilaAsientos {
  rowNumber: number;
  seats: Asiento[];
}

export interface CabinaMapa {
  cabinClass: ClaseCabina;
  rows: FilaAsientos[];
}

export interface MapaAsientos {
  segmentId: string;
  cabins: CabinaMapa[];
}

// --- FlightStatusDetail -----------------------------------------------------------------------

export interface ExtremoEstado {
  iataCode: string;
  terminal: string | null;
  scheduledAt: string;
  estimatedAt: string | null;
  actualAt: string | null;
}

export interface EstadoVueloDetalle {
  flightNumber: string;
  /** Fecha local de salida: "YYYY-MM-DD". */
  date: string;
  marketingCarrier: string;
  operatingCarrier: string;
  departure: ExtremoEstado;
  arrival: ExtremoEstado;
  aircraft: string | null;
  status: EstadoVuelo;
}
