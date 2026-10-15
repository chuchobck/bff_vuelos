/**
 * Error de dominio de una llamada al core. Los dos adaptadores lo producen con la misma forma:
 * el resto del BFF no sabe si vino de gRPC o de REST.
 *
 * `categoria` es la clase de fallo (la que decide el código GraphQL); `problemCode` y `status`
 * son los del ProblemDetails del core (problem-code y problem-status en gRPC) y, si el core no
 * los mandó (UNAVAILABLE, DEADLINE_EXCEEDED, UNIMPLEMENTED de grpc-js, o un proxy), los del BFF.
 */
export type CategoriaError =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'RESOURCE_EXHAUSTED'
  | 'INTERNAL';

export interface ParametroInvalido {
  name: string;
  reason: string;
}

export interface DatosErrorNucleo {
  categoria: CategoriaError;
  /** El `code` del ProblemDetails del core, o uno del BFF si el core no lo mandó. */
  problemCode: string;
  /** El status HTTP del ProblemDetails (o el que le tocaría). */
  status: number;
  /**
   * El `detail` del core. Solo se muestra al cliente en NOT_FOUND e INVALID_ARGUMENT: el core
   * asegura que nunca lleva datos del pasajero ni la huella. En lo demás se ignora.
   */
  detalle?: string | null;
  invalidParams?: ParametroInvalido[];
  /** Segundos, de `retry-after`. */
  retryAfter?: number | null;
  /** Para el log del BFF: nunca llega al cliente. */
  causa?: string;
}

export class ErrorNucleo extends Error {
  readonly categoria: CategoriaError;
  readonly problemCode: string;
  readonly status: number;
  readonly detalle: string | null;
  readonly invalidParams: ParametroInvalido[];
  readonly retryAfter: number | null;

  constructor(datos: DatosErrorNucleo) {
    // El mensaje de la excepción es solo para el log: sin detalle del core ni datos de usuario
    super(`${datos.categoria} ${datos.problemCode}${datos.causa ? ` (${datos.causa})` : ''}`);
    this.name = 'ErrorNucleo';
    this.categoria = datos.categoria;
    this.problemCode = datos.problemCode;
    this.status = datos.status;
    this.detalle = datos.detalle ?? null;
    this.invalidParams = datos.invalidParams ?? [];
    this.retryAfter = datos.retryAfter ?? null;
  }
}

/** Código y status del BFF para un fallo que el core no explicó (sin problem-*). */
export const SIN_PROBLEMA: Readonly<
  Record<CategoriaError, { problemCode: string; status: number }>
> = {
  NOT_FOUND: { problemCode: 'NOT_FOUND', status: 404 },
  INVALID_ARGUMENT: { problemCode: 'VALIDATION_FAILED', status: 400 },
  UNAVAILABLE: { problemCode: 'CORE_UNAVAILABLE', status: 503 },
  DEADLINE_EXCEEDED: { problemCode: 'CORE_TIMEOUT', status: 504 },
  RESOURCE_EXHAUSTED: { problemCode: 'RATE_LIMIT_EXCEEDED', status: 429 },
  INTERNAL: { problemCode: 'CORE_ERROR', status: 500 },
};

/** Un `retry-after` válido en segundos (entero de 1 a un día); cualquier otra cosa, null. */
export function leerRetryAfter(valor: unknown): number | null {
  if (typeof valor !== 'string' || !/^\d{1,6}$/.test(valor.trim())) return null;
  const segundos = Number(valor);
  return segundos >= 1 && segundos <= 86_400 ? segundos : null;
}

const LARGO_MAXIMO_TEXTO = 300;

/** Texto corto y sin saltos de línea: lo único que se deja pasar del `detail` del core. */
export function textoSeguro(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const limpio = valor.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return limpio === '' ? null : limpio.slice(0, LARGO_MAXIMO_TEXTO);
}

/** Lo que se toma de un ProblemDetails (JSON de problem-details-bin o cuerpo REST). */
export function leerProblemDetails(valor: unknown): {
  code: string | null;
  status: number | null;
  detalle: string | null;
  invalidParams: ParametroInvalido[];
} {
  const problema =
    typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : {};
  const invalidParams = Array.isArray(problema.invalidParams)
    ? problema.invalidParams
        .map((p): ParametroInvalido | null => {
          const dato = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
          const name = textoSeguro(dato.name);
          const reason = textoSeguro(dato.reason);
          return name && reason ? { name, reason } : null;
        })
        .filter((p): p is ParametroInvalido => p !== null)
        .slice(0, 50)
    : [];
  return {
    code:
      typeof problema.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(problema.code)
        ? problema.code
        : null,
    status: Number.isInteger(problema.status) ? (problema.status as number) : null,
    detalle: textoSeguro(problema.detail),
    invalidParams,
  };
}

/** Arma el error con los valores del BFF para lo que el core no mandó. */
export function crearErrorNucleo(
  categoria: CategoriaError,
  problema: ReturnType<typeof leerProblemDetails> | null,
  extra: {
    problemCode?: string | null;
    status?: number | null;
    retryAfter?: number | null;
    causa?: string;
  } = {},
): ErrorNucleo {
  const porDefecto = SIN_PROBLEMA[categoria];
  return new ErrorNucleo({
    categoria,
    problemCode: extra.problemCode ?? problema?.code ?? porDefecto.problemCode,
    status: extra.status ?? problema?.status ?? porDefecto.status,
    detalle: problema?.detalle ?? null,
    invalidParams: problema?.invalidParams ?? [],
    retryAfter: extra.retryAfter ?? null,
    causa: extra.causa,
  });
}
