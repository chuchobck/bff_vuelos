import { join } from 'node:path';

/** Paquete y servicio de contracts/proto/flights/v1/flights.proto. */
export const PAQUETE_GRPC = 'quinde.flights.v1';
export const SERVICIO_GRPC = 'FlightsService';

/** dist/nucleo/grpc y src/nucleo/grpc quedan a la misma altura de contracts/. */
export const RUTA_PROTO = join(
  __dirname,
  '..',
  '..',
  '..',
  'contracts/proto/flights/v1/flights.proto',
);

/**
 * Cómo se carga el proto. Son EXACTAMENTE las `OPCIONES_CARGA_PROTO` del core
 * (src/config/grpc.ts de backend_vuelos): con otras, el cliente recibiría otra forma que el
 * servidor describe (docs/GRPC.md del core). Si el core las cambia, se cambian aquí.
 * - `keepCase: false`: `total_offers` llega como `totalOffers`, el nombre del JSON del contrato.
 * - `enums: String`: `FLIGHT_STATUS_SCHEDULED` y no 1.
 * - `defaults: true`: un campo sin valor llega con el de proto3 (0, false, ''); los `optional`
 *   sin valor no llegan, como un null de REST.
 * - `oneofs: false`: sin la propiedad virtual de los `optional` (`_terminal`).
 */
export const OPCIONES_CARGA_PROTO = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: false,
};
