import { GraphQLError } from 'graphql';

/**
 * Errores que nacen en el BFF. Llevan su `code` y `status`; `problemCode` y `requestId` los
 * completa el formateador de errores (errores-graphql.ts) para que todos tengan la misma forma.
 * Ninguno repite un valor del usuario ni de la huella.
 */
export const CODIGOS = {
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  QUERY_TOO_EXPENSIVE: 'QUERY_TOO_EXPENSIVE',
  QUERY_TOO_DEEP: 'QUERY_TOO_DEEP',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  NOT_FOUND: 'NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export function errorConsultaCostosa(maximo: number): GraphQLError {
  return new GraphQLError(
    `This query needs more than ${maximo} calls to the flights service; ask for less data per request`,
    {
      extensions: {
        code: CODIGOS.QUERY_TOO_EXPENSIVE,
        problemCode: 'QUERY_TOO_EXPENSIVE',
        status: 400,
      },
    },
  );
}

/** Falta la huella o no cumple el formato: el mensaje nombra la cabecera, nunca su valor. */
export function errorHuella(falta: boolean): GraphQLError {
  const razon = falta
    ? 'is required'
    : 'must be 8 to 128 characters: letters, digits or . _ : + / = -';
  return new GraphQLError(`X-Device-Fingerprint header ${razon}`, {
    extensions: {
      code: CODIGOS.BAD_USER_INPUT,
      problemCode: 'VALIDATION_FAILED',
      status: 400,
      invalidParams: [{ name: 'X-Device-Fingerprint', reason: razon }],
    },
  });
}
