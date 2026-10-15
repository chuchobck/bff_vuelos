import { GraphQLFormattedError } from 'graphql';
import { requestIdActual } from '../common/contexto-peticion';

/**
 * Formateador de errores de Apollo. Agrega el request id de la petición a `extensions` de cada
 * error, venga de donde venga (validación, resolver, parser, límite).
 */
export function formatearError(formateado: GraphQLFormattedError): GraphQLFormattedError {
  const requestId = requestIdActual();
  return {
    ...formateado,
    extensions: { ...formateado.extensions, ...(requestId ? { requestId } : {}) },
  };
}
