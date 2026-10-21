import { filtrarAtributos } from '../observabilidad/atributos';

/**
 * Los atributos de span que el BFF agrega a los del estándar (`observabilidad/atributos.ts`, que se
 * copia tal cual del gateway y no se edita). Siguen la misma regla: lista cerrada, y el valor solo
 * pasa si es de un conjunto cerrado. NUNCA el texto de la consulta, las variables, un offerId ni la
 * huella: no hay forma de poner un texto libre del cliente aquí.
 *
 * - `graphql.operation.type`: query, mutation o subscription.
 * - `graphql.root_fields`: los campos raíz del ESQUEMA que pide la operación (`searchFlights,seatMap`);
 *   cualquier otro nombre, incluido un alias o un campo inventado, es `__other__`.
 * - `rpc.system`: grpc. `rpc.service` y `rpc.method`: los del proto del core. `rpc.grpc.status_code`: 0 a 16.
 */
export const CAMPOS_RAIZ_DEL_ESQUEMA = ['searchFlights', 'seatMap', 'flightStatus'] as const;
export const OTRO = '__other__';

export const SERVICIO_RPC = 'quinde.flights.v1.FlightsService';
export const METODOS_RPC = ['SearchFlights', 'GetSeatMap', 'GetFlightStatus'] as const;
const TIPOS_OPERACION = new Set(['query', 'mutation', 'subscription']);

type Valor = string | number | boolean;

const VALIDADORES: Record<string, (valor: Valor) => boolean> = {
  'graphql.operation.type': (v) => typeof v === 'string' && TIPOS_OPERACION.has(v),
  'graphql.root_fields': (v) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v
      .split(',')
      .every(
        (campo) => (CAMPOS_RAIZ_DEL_ESQUEMA as readonly string[]).includes(campo) || campo === OTRO,
      ),
  'rpc.system': (v) => v === 'grpc',
  'rpc.service': (v) => v === SERVICIO_RPC,
  'rpc.method': (v) => (METODOS_RPC as readonly string[]).includes(String(v)),
  'rpc.grpc.status_code': (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 16,
};

export const ATRIBUTOS_DEL_BFF = new Set(Object.keys(VALIDADORES));

/** Un campo raíz del esquema, o `__other__`: lo único que sale de una consulta hacia un span o una etiqueta. */
export function campoRaizSeguro(campo: string): string {
  return (CAMPOS_RAIZ_DEL_ESQUEMA as readonly string[]).includes(campo) ? campo : OTRO;
}

/** Los del estándar (filtrados por `filtrarAtributos`) más los del BFF cuyo valor es de un conjunto cerrado. */
export function filtrarAtributosBff(
  atributos: Record<string, Valor | undefined>,
): Record<string, Valor> {
  const salida: Record<string, Valor> = { ...filtrarAtributos(atributos) };
  for (const [nombre, valor] of Object.entries(atributos)) {
    const valida = VALIDADORES[nombre];
    if (valor !== undefined && valida?.(valor)) salida[nombre] = valor;
  }
  return salida;
}
