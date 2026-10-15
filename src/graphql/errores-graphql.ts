import { unwrapResolverError } from '@apollo/server/errors';
import { Logger } from '@nestjs/common';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import { requestIdActual } from '../common/contexto-peticion';
import { CategoriaError, ErrorNucleo } from '../nucleo/error-nucleo';
import { CODIGOS } from './errores';

const logger = new Logger('Errores');

/** Mensaje de lo que no se explica al cliente: ni el del core, ni el de una excepción. */
export const MENSAJE_INTERNO = 'Internal server error';

/** Segundos que se sugieren si el core no estaba disponible y no dijo cuándo reintentar. */
export const REINTENTO_POR_DEFECTO_SEGUNDOS = 5;

interface Traduccion {
  code: string;
  /** Mensaje fijo; si es null, se usa el `detail` que dio el core (solo en 400 y 404). */
  mensaje: string | null;
  mensajePorDefecto: string;
  conReintento: boolean;
}

/**
 * Error del core → error GraphQL. Solo NOT_FOUND e INVALID_ARGUMENT dejan pasar el `detail` del
 * core, que el core garantiza sin datos de pasajero ni huella. Todo lo demás lleva un mensaje
 * fijo del BFF: ni el stack ni los mensajes internos del core llegan al cliente.
 */
const TRADUCCIONES: Readonly<Record<CategoriaError, Traduccion>> = {
  NOT_FOUND: {
    code: CODIGOS.NOT_FOUND,
    mensaje: null,
    mensajePorDefecto: 'The requested resource was not found',
    conReintento: false,
  },
  INVALID_ARGUMENT: {
    code: CODIGOS.BAD_USER_INPUT,
    mensaje: null,
    mensajePorDefecto: 'The request is not valid',
    conReintento: false,
  },
  UNAVAILABLE: {
    code: CODIGOS.SERVICE_UNAVAILABLE,
    mensaje: 'The flights service is temporarily unavailable',
    mensajePorDefecto: '',
    conReintento: true,
  },
  DEADLINE_EXCEEDED: {
    code: CODIGOS.GATEWAY_TIMEOUT,
    mensaje: 'The flights service did not respond in time',
    mensajePorDefecto: '',
    conReintento: false,
  },
  RESOURCE_EXHAUSTED: {
    code: CODIGOS.TOO_MANY_REQUESTS,
    mensaje: 'Too many requests; retry later',
    mensajePorDefecto: '',
    conReintento: false,
  },
  INTERNAL: {
    code: CODIGOS.INTERNAL_SERVER_ERROR,
    mensaje: MENSAJE_INTERNO,
    mensajePorDefecto: '',
    conReintento: false,
  },
};

/** Los errores que nacen en GraphQL o en Apollo, sin `problemCode` ni `status` propios. */
const STATUS_GRAPHQL: Readonly<Record<string, number>> = {
  GRAPHQL_PARSE_FAILED: 400,
  GRAPHQL_VALIDATION_FAILED: 400,
  BAD_USER_INPUT: 400,
  BAD_REQUEST: 400,
  OPERATION_RESOLUTION_FAILURE: 400,
  PERSISTED_QUERY_NOT_SUPPORTED: 400,
  PERSISTED_QUERY_NOT_FOUND: 400,
  QUERY_TOO_DEEP: 400,
  QUERY_TOO_EXPENSIVE: 400,
  TOO_MANY_REQUESTS: 429,
};

function desdeNucleo(error: ErrorNucleo, formateado: GraphQLFormattedError): GraphQLFormattedError {
  const t = TRADUCCIONES[error.categoria];
  const extensions: Record<string, unknown> = {
    code: t.code,
    problemCode: error.problemCode,
    status: error.status,
  };
  if (t.conReintento) extensions.retryAfter = error.retryAfter ?? REINTENTO_POR_DEFECTO_SEGUNDOS;
  else if (error.retryAfter !== null) extensions.retryAfter = error.retryAfter;
  if (error.categoria === 'INVALID_ARGUMENT' && error.invalidParams.length > 0) {
    extensions.invalidParams = error.invalidParams;
  }

  if (error.categoria === 'INTERNAL') {
    // Lo que falló queda en el log con el request id; al cliente, solo el código
    logger.error(
      `${requestIdActual() ?? '-'} core INTERNAL ${error.problemCode} status=${error.status} ${error.message}`,
    );
  } else if (error.categoria !== 'NOT_FOUND' && error.categoria !== 'INVALID_ARGUMENT') {
    logger.warn(
      `${requestIdActual() ?? '-'} core ${error.categoria} ${error.problemCode} status=${error.status}`,
    );
  }

  return {
    message: t.mensaje ?? error.detalle ?? t.mensajePorDefecto,
    locations: formateado.locations,
    path: formateado.path,
    extensions,
  };
}

/** Un error sin tipo conocido (una excepción inesperada): mensaje genérico y al log. */
function interno(original: unknown, formateado: GraphQLFormattedError): GraphQLFormattedError {
  const detalle =
    original instanceof Error ? (original.stack ?? original.message) : 'non-error thrown';
  logger.error(`${requestIdActual() ?? '-'} unexpected error\n${detalle}`);
  return {
    message: MENSAJE_INTERNO,
    locations: formateado.locations,
    path: formateado.path,
    extensions: { code: CODIGOS.INTERNAL_SERVER_ERROR, problemCode: 'INTERNAL_ERROR', status: 500 },
  };
}

/**
 * Formateador de errores de Apollo: toda respuesta de error sale con la misma forma,
 * `extensions { code, problemCode, status, requestId, retryAfter?, invalidParams? }`, sin stack.
 *
 * - `ErrorNucleo` (del core): se traduce con TRADUCCIONES.
 * - `GraphQLError` (de GraphQL, de Apollo o de este BFF): conserva su mensaje, que escribió este
 *   código o graphql-js, y se completa con `problemCode` y `status`.
 * - Cualquier otra cosa (una excepción inesperada): `INTERNAL_SERVER_ERROR` genérico.
 */
export function formatearError(
  formateado: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = unwrapResolverError(error);
  let resultado: GraphQLFormattedError;
  if (original instanceof ErrorNucleo) {
    resultado = desdeNucleo(original, formateado);
  } else if (original instanceof GraphQLError) {
    // Apollo envuelve el error de una regla de validación propia (QUERY_TOO_DEEP) en uno suyo,
    // GRAPHQL_VALIDATION_FAILED: si la regla puso su código, ese es el que vale
    const propio =
      original.originalError instanceof GraphQLError ? original.originalError : undefined;
    const extensiones = { ...formateado.extensions, ...propio?.extensions };
    const code = String(extensiones.code ?? CODIGOS.INTERNAL_SERVER_ERROR);
    const status = (extensiones.status as number | undefined) ?? STATUS_GRAPHQL[code] ?? 500;
    resultado = {
      ...formateado,
      extensions: {
        ...formateado.extensions,
        code,
        problemCode:
          formateado.extensions?.problemCode ??
          (status === 400 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR'),
        status,
      },
    };
  } else {
    resultado = interno(original, formateado);
  }

  const requestId = requestIdActual();
  return {
    ...resultado,
    extensions: { ...resultado.extensions, ...(requestId ? { requestId } : {}) },
  };
}
