import { crearErrorNucleo } from './error-nucleo';
import {
  Asiento,
  CARACTERISTICAS_ASIENTO,
  CLASES_CABINA,
  ESTADOS_VUELO,
  EstadoVueloDetalle,
  MapaAsientos,
  OfertaVuelo,
  OpcionItinerario,
  PrecioCabina,
  ResultadoBusqueda,
  SegmentoVuelo,
  TIPOS_PASAJERO,
} from './modelo';
import type { ExtremoEstado, ExtremoVuelo, Monto } from './modelo';

type Crudo = Record<string, unknown>;

/** Sin valor: un optional de gRPC que no llegó o un null de REST. */
const ausente = (valor: unknown): boolean => valor === undefined || valor === null;

/** Un decimal en texto: "73.92", "0", "-1.5". El dinero nunca es un número. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Convierte la respuesta cruda del core (el mensaje de gRPC o el JSON de REST) al tipo de dominio
 * de modelo.ts. Es el único lugar que arma ese tipo: así los dos adaptadores devuelven la misma
 * forma, campo por campo.
 *
 * - `prefijosEnum`: gRPC entrega `FLIGHT_STATUS_SCHEDULED`; REST, `SCHEDULED`.
 * - Falta de valor: undefined, null y `*_UNSPECIFIED` pasan a `null`.
 * - Un campo obligatorio ausente o con otro tipo es una respuesta inválida del core: ErrorNucleo
 *   INTERNAL que nombra el campo, nunca su valor.
 */
export class Normalizador {
  constructor(private readonly prefijosEnum: boolean) {}

  busqueda(crudo: unknown): ResultadoBusqueda {
    const raiz = this.objeto(crudo, 'SearchResponse');
    return {
      totalOffers: this.entero(raiz, 'totalOffers', 'SearchResponse'),
      offers: this.lista(raiz, 'offers', 'SearchResponse').map((o, i) =>
        this.oferta(o, `offers[${i}]`),
      ),
    };
  }

  mapaAsientos(crudo: unknown): MapaAsientos {
    const raiz = this.objeto(crudo, 'SeatMapResponse');
    return {
      segmentId: this.cadena(raiz, 'segmentId', 'SeatMapResponse'),
      cabins: this.lista(raiz, 'cabins', 'SeatMapResponse').map((c, i) => {
        const ruta = `cabins[${i}]`;
        return {
          cabinClass: this.enumeracionRequerida(c.cabinClass, 'CABIN_CLASS', CLASES_CABINA, ruta),
          rows: this.lista(c, 'rows', ruta).map((f, j) => ({
            rowNumber: this.entero(f, 'rowNumber', `${ruta}.rows[${j}]`),
            seats: this.lista(f, 'seats', `${ruta}.rows[${j}]`).map((a, k) =>
              this.asiento(a, `${ruta}.rows[${j}].seats[${k}]`),
            ),
          })),
        };
      }),
    };
  }

  estadoVuelo(crudo: unknown): EstadoVueloDetalle {
    const raiz = this.objeto(crudo, 'FlightStatus');
    return {
      flightNumber: this.cadena(raiz, 'flightNumber', 'FlightStatus'),
      date: this.cadena(raiz, 'date', 'FlightStatus'),
      marketingCarrier: this.cadena(raiz, 'marketingCarrier', 'FlightStatus'),
      operatingCarrier: this.cadena(raiz, 'operatingCarrier', 'FlightStatus'),
      departure: this.extremoEstado(this.hijo(raiz, 'departure', 'FlightStatus'), 'departure'),
      arrival: this.extremoEstado(this.hijo(raiz, 'arrival', 'FlightStatus'), 'arrival'),
      aircraft: this.cadenaONull(raiz.aircraft),
      status: this.enumeracionRequerida(
        raiz.status,
        'FLIGHT_STATUS',
        ESTADOS_VUELO,
        'FlightStatus',
      ),
    };
  }

  // --- SearchResponse -------------------------------------------------------------------------

  private oferta(crudo: Crudo, ruta: string): OfertaVuelo {
    const aerolinea = this.hijo(crudo, 'airline', ruta);
    return {
      offerId: this.cadena(crudo, 'offerId', ruta),
      airline: {
        code: this.cadena(aerolinea, 'code', `${ruta}.airline`),
        name: this.cadena(aerolinea, 'name', `${ruta}.airline`),
      },
      itineraries: this.lista(crudo, 'itineraries', ruta).map((i, j) =>
        this.itinerario(i, `${ruta}.itineraries[${j}]`),
      ),
      grandTotal: this.monto(this.hijo(crudo, 'grandTotal', ruta), `${ruta}.grandTotal`),
    };
  }

  private itinerario(crudo: Crudo, ruta: string): OpcionItinerario {
    return {
      itineraryId: this.cadena(crudo, 'itineraryId', ruta),
      totalDurationMinutes: this.entero(crudo, 'totalDurationMinutes', ruta),
      stopsCount: this.entero(crudo, 'stopsCount', ruta),
      segments: this.lista(crudo, 'segments', ruta).map((s, i) =>
        this.segmento(s, `${ruta}.segments[${i}]`),
      ),
      pricingOptions: this.lista(crudo, 'pricingOptions', ruta).map((p, i) =>
        this.precioCabina(p, `${ruta}.pricingOptions[${i}]`),
      ),
    };
  }

  private segmento(crudo: Crudo, ruta: string): SegmentoVuelo {
    return {
      segmentId: this.cadena(crudo, 'segmentId', ruta),
      flightNumber: this.cadena(crudo, 'flightNumber', ruta),
      departure: this.extremoVuelo(this.hijo(crudo, 'departure', ruta), `${ruta}.departure`),
      arrival: this.extremoVuelo(this.hijo(crudo, 'arrival', ruta), `${ruta}.arrival`),
      layoverMinutes: this.enteroONull(crudo.layoverMinutes),
      marketingCarrier: this.cadena(crudo, 'marketingCarrier', ruta),
      operatingCarrier: this.cadena(crudo, 'operatingCarrier', ruta),
      aircraft: this.cadenaONull(crudo.aircraft),
      durationMinutes: this.enteroONull(crudo.durationMinutes),
      status: this.enumeracion(crudo.status, 'FLIGHT_STATUS', ESTADOS_VUELO),
    };
  }

  private extremoVuelo(crudo: Crudo, ruta: string): ExtremoVuelo {
    return {
      iataCode: this.cadena(crudo, 'iataCode', ruta),
      at: this.cadena(crudo, 'at', ruta),
      terminal: this.cadenaONull(crudo.terminal),
    };
  }

  private precioCabina(crudo: Crudo, ruta: string): PrecioCabina {
    const reglas = this.hijo(crudo, 'fareRules', ruta);
    const equipaje = this.hijo(crudo, 'baggageAllowance', ruta);
    return {
      cabinClass: this.enumeracionRequerida(crudo.cabinClass, 'CABIN_CLASS', CLASES_CABINA, ruta),
      fareBrand: this.cadena(crudo, 'fareBrand', ruta),
      availableSeats: this.entero(crudo, 'availableSeats', ruta),
      fareRules: {
        isRefundable: this.booleano(reglas, 'isRefundable', `${ruta}.fareRules`),
        isChangeable: this.booleano(reglas, 'isChangeable', `${ruta}.fareRules`),
      },
      baggageAllowance: {
        personalItemIncluded: this.booleano(
          equipaje,
          'personalItemIncluded',
          `${ruta}.baggageAllowance`,
        ),
        carryOnIncluded: this.entero(equipaje, 'carryOnIncluded', `${ruta}.baggageAllowance`),
        checkedBaggageIncluded: this.entero(
          equipaje,
          'checkedBaggageIncluded',
          `${ruta}.baggageAllowance`,
        ),
      },
      extraCheckedBaggagePrice: ausente(crudo.extraCheckedBaggagePrice)
        ? null
        : this.monto(
            this.hijo(crudo, 'extraCheckedBaggagePrice', ruta),
            `${ruta}.extraCheckedBaggagePrice`,
          ),
      pricePerPassengerType: this.lista(crudo, 'pricePerPassengerType', ruta).map((p, i) => ({
        passengerType: this.enumeracionRequerida(
          p.passengerType,
          'PASSENGER_TYPE',
          TIPOS_PASAJERO,
          `${ruta}.pricePerPassengerType[${i}]`,
        ),
        price: this.monto(
          this.hijo(p, 'price', `${ruta}.pricePerPassengerType[${i}]`),
          `${ruta}.pricePerPassengerType[${i}].price`,
        ),
      })),
    };
  }

  private monto(crudo: Crudo, ruta: string): Monto {
    return {
      currency: this.cadena(crudo, 'currency', ruta),
      baseFare: this.dineroONull(crudo, 'baseFare', ruta),
      taxes: this.dineroONull(crudo, 'taxes', ruta),
      total: this.dinero(crudo, 'total', ruta),
    };
  }

  // --- SeatMapResponse y FlightStatus ---------------------------------------------------------

  private asiento(crudo: Crudo, ruta: string): Asiento {
    return {
      seatNumber: this.cadena(crudo, 'seatNumber', ruta),
      isAvailable: this.booleano(crudo, 'isAvailable', ruta),
      // Un valor desconocido o *_UNSPECIFIED no es una característica: se descarta
      characteristics: this.lista(crudo, 'characteristics', ruta, false)
        .map((c) => this.enumeracion(c, 'SEAT_CHARACTERISTIC', CARACTERISTICAS_ASIENTO))
        .filter((c): c is NonNullable<typeof c> => c !== null),
    };
  }

  private extremoEstado(crudo: Crudo, ruta: string): ExtremoEstado {
    return {
      iataCode: this.cadena(crudo, 'iataCode', ruta),
      terminal: this.cadenaONull(crudo.terminal),
      scheduledAt: this.cadena(crudo, 'scheduledAt', ruta),
      estimatedAt: this.cadenaONull(crudo.estimatedAt),
      actualAt: this.cadenaONull(crudo.actualAt),
    };
  }

  // --- Lectura con tipo -----------------------------------------------------------------------

  private invalida(ruta: string, esperado: string): never {
    throw crearErrorNucleo('INTERNAL', null, {
      problemCode: 'CORE_BAD_RESPONSE',
      status: 502,
      causa: `respuesta del core inválida: ${ruta} debe ser ${esperado}`,
    });
  }

  private objeto(valor: unknown, ruta: string): Crudo {
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
      this.invalida(ruta, 'un objeto');
    }
    return valor as Crudo;
  }

  private hijo(padre: Crudo, clave: string, ruta: string): Crudo {
    return this.objeto(padre[clave], `${ruta}.${clave}`);
  }

  /** Una lista de objetos; con `objetos = false`, de valores sueltos (las características). */
  private lista(padre: Crudo, clave: string, ruta: string): Crudo[];
  private lista(padre: Crudo, clave: string, ruta: string, objetos: false): unknown[];
  private lista(padre: Crudo, clave: string, ruta: string, objetos = true): unknown[] {
    const valor = padre[clave];
    // proto3 con defaults: una lista vacía llega como []; ausente en REST es inválido
    if (!Array.isArray(valor)) this.invalida(`${ruta}.${clave}`, 'una lista');
    const elementos = valor as unknown[];
    return objetos ? elementos.map((e, i) => this.objeto(e, `${ruta}.${clave}[${i}]`)) : elementos;
  }

  private cadena(padre: Crudo, clave: string, ruta: string): string {
    const valor = padre[clave];
    if (typeof valor !== 'string') this.invalida(`${ruta}.${clave}`, 'un texto');
    return valor as string;
  }

  private cadenaONull(valor: unknown): string | null {
    return typeof valor === 'string' ? valor : null;
  }

  private entero(padre: Crudo, clave: string, ruta: string): number {
    const valor = padre[clave];
    if (typeof valor !== 'number' || !Number.isInteger(valor)) {
      this.invalida(`${ruta}.${clave}`, 'un entero');
    }
    return valor as number;
  }

  private enteroONull(valor: unknown): number | null {
    return typeof valor === 'number' && Number.isInteger(valor) ? valor : null;
  }

  private booleano(padre: Crudo, clave: string, ruta: string): boolean {
    const valor = padre[clave];
    if (typeof valor !== 'boolean') this.invalida(`${ruta}.${clave}`, 'un booleano');
    return valor as boolean;
  }

  private dinero(padre: Crudo, clave: string, ruta: string): string {
    const valor = padre[clave];
    if (typeof valor !== 'string' || !DECIMAL.test(valor)) {
      this.invalida(`${ruta}.${clave}`, 'un decimal en texto');
    }
    return valor as string;
  }

  private dineroONull(padre: Crudo, clave: string, ruta: string): string | null {
    return ausente(padre[clave]) ? null : this.dinero(padre, clave, ruta);
  }

  // --- Enums ----------------------------------------------------------------------------------

  /** El valor sin prefijo, o null si falta, es *_UNSPECIFIED o el BFF no lo conoce todavía. */
  private enumeracion<T extends string>(
    valor: unknown,
    familia: string,
    validos: readonly T[],
  ): T | null {
    if (typeof valor !== 'string') return null;
    let nombre = valor;
    if (this.prefijosEnum) {
      const prefijo = `${familia}_`;
      if (!valor.startsWith(prefijo)) return null;
      nombre = valor.slice(prefijo.length);
    }
    return (validos as readonly string[]).includes(nombre) ? (nombre as T) : null;
  }

  /** Un enum que el contrato exige: sin valor es una respuesta inválida del core. */
  private enumeracionRequerida<T extends string>(
    valor: unknown,
    familia: string,
    validos: readonly T[],
    ruta: string,
  ): T {
    const resultado = this.enumeracion(valor, familia, validos);
    if (resultado === null) this.invalida(`${ruta}.${familia.toLowerCase()}`, 'un valor conocido');
    return resultado as T;
  }
}

/** Los adaptadores usan uno cada uno: gRPC con prefijos de enum, REST sin ellos. */
export const NORMALIZADOR_GRPC = new Normalizador(true);
export const NORMALIZADOR_REST = new Normalizador(false);
