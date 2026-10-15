import { GraphQLError, Kind, ValueNode } from 'graphql';
import { Scalar, CustomScalar } from '@nestjs/graphql';

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** "2026-10-22" y que exista en el calendario (no "2026-02-30"). */
export function esFechaValida(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const partes = FECHA.exec(valor);
  if (!partes) return false;
  const [anio, mes, dia] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia
  );
}

/** ISO 8601 en UTC con "Z" y que exista ("2026-10-22T12:30:00.000Z"). */
export function esInstanteValido(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !INSTANTE.test(valor)) return false;
  const fecha = new Date(valor);
  return !Number.isNaN(fecha.getTime()) && esFechaValida(valor.slice(0, 10));
}

// Los mensajes no repiten el valor recibido
function error(mensaje: string): GraphQLError {
  return new GraphQLError(mensaje, { extensions: { code: 'BAD_USER_INPUT' } });
}

function textoDe(nodo: ValueNode, nombre: string): string {
  if (nodo.kind !== Kind.STRING) throw error(`${nombre} must be a string`);
  return nodo.value;
}

@Scalar('Date')
export class EscalarFecha implements CustomScalar<string, string> {
  description = 'Fecha local "YYYY-MM-DD"';

  serialize(valor: unknown): string {
    if (!esFechaValida(valor)) throw new TypeError('Date: value is not a YYYY-MM-DD date');
    return valor;
  }

  parseValue(valor: unknown): string {
    if (!esFechaValida(valor)) throw error('Date must be a valid calendar date as "YYYY-MM-DD"');
    return valor;
  }

  parseLiteral(nodo: ValueNode): string {
    return this.parseValue(textoDe(nodo, 'Date'));
  }
}

@Scalar('DateTime')
export class EscalarInstante implements CustomScalar<string, string> {
  description = 'Instante en UTC, ISO 8601 con "Z"';

  serialize(valor: unknown): string {
    if (valor instanceof Date && !Number.isNaN(valor.getTime())) return valor.toISOString();
    if (!esInstanteValido(valor))
      throw new TypeError('DateTime: value is not an ISO 8601 UTC instant');
    return valor;
  }

  parseValue(valor: unknown): string {
    if (!esInstanteValido(valor)) {
      throw error('DateTime must be an ISO 8601 UTC instant such as "2026-10-22T12:30:00.000Z"');
    }
    return valor;
  }

  parseLiteral(nodo: ValueNode): string {
    return this.parseValue(textoDe(nodo, 'DateTime'));
  }
}
