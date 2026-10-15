import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { esOrigenValido, listarOrigenes } from './origenes-cors';
import { parsearTrustProxy, ValorTrustProxy } from './proxy';

export const ENTORNOS = ['development', 'production', 'test'] as const;
export const TRANSPORTES = ['grpc', 'rest'] as const;
export type Entorno = (typeof ENTORNOS)[number];
export type TransporteNucleo = (typeof TRANSPORTES)[number];

export const PUERTO_POR_DEFECTO = 4000;
export const GRPC_URL_POR_DEFECTO = 'localhost:50051';
export const TIMEOUT_POR_DEFECTO_MS = 8000;
export const MAX_LLAMADAS_POR_DEFECTO = 10;
export const VENTANA_LIMITE_POR_DEFECTO_SEGUNDOS = 60;
export const LIMITE_GLOBAL_POR_DEFECTO = 100;
// Los mismos topes por IP que el core aplica en REST a cada operación.
export const LIMITE_BUSQUEDA_POR_DEFECTO = 20;
export const LIMITE_MAPA_ASIENTOS_POR_DEFECTO = 60;
export const LIMITE_ESTADO_VUELO_POR_DEFECTO = 60;

/** Los mensajes de validación nombran la variable, nunca su valor (puede ser una URL con clave). */
@ValidatorConstraint({ name: 'listaDeOrigenes' })
class ListaDeOrigenes implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && listarOrigenes(valor).every(esOrigenValido);
  }

  defaultMessage(): string {
    return (
      'CORS_ORIGINS debe ser una lista de orígenes separados por coma, como ' +
      'https://app.example.com (sin ruta, sin barra final y sin "*")'
    );
  }
}

@ValidatorConstraint({ name: 'trustProxyValido' })
class TrustProxyValido implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && parsearTrustProxy(valor) !== undefined;
  }

  defaultMessage(): string {
    return (
      'TRUST_PROXY debe ser false, un número de proxies (1, 2...) o una lista separada por coma ' +
      'de IP, CIDR, loopback, linklocal o uniquelocal; "true" no se acepta porque deja falsear la IP'
    );
  }
}

/** Origen del core por REST: http(s) sin usuario, ruta, query ni fragmento. */
export function esUrlRestValida(valor: unknown): boolean {
  if (typeof valor !== 'string') return false;
  try {
    const url = new URL(valor);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'urlRestValida' })
class UrlRestValida implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return esUrlRestValida(valor);
  }

  defaultMessage(): string {
    return (
      'CORE_REST_URL debe ser el origen del core, como https://quinde-vuelos-api.onrender.com ' +
      '(http o https, sin usuario, ruta ni query)'
    );
  }
}

/**
 * Variables de entorno del BFF. Las obligatorias no tienen valor por defecto: si falta una o
 * es inválida, el BFF no arranca y el error nombra la variable (nunca su valor). Las opcionales
 * (`@IsOptional`) llevan su valor por defecto documentado en `.env.example`.
 */
export class VariablesEntorno {
  // class-validator evalúa de abajo hacia arriba: lo obligatorio va pegado a la propiedad.
  @Min(1, { message: 'PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'PORT debe ser un número entero' })
  @IsOptional()
  PORT?: number;

  @IsIn(ENTORNOS, { message: `NODE_ENV es obligatorio y debe ser uno de: ${ENTORNOS.join(', ')}` })
  NODE_ENV: Entorno;

  /** Cómo habla el BFF con el core: `grpc` (interno) o `rest` (respaldo, p. ej. Render). */
  @IsIn(TRANSPORTES, {
    message: `CORE_TRANSPORT es obligatoria y debe ser uno de: ${TRANSPORTES.join(', ')}`,
  })
  CORE_TRANSPORT: TransporteNucleo;

  /** host:puerto del servidor gRPC del core. Sin valor: localhost:50051. */
  @Matches(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):\d{1,5}$/, {
    message: 'CORE_GRPC_URL debe tener la forma host:puerto (por ejemplo localhost:50051)',
  })
  @IsOptional()
  CORE_GRPC_URL?: string;

  /** Origen REST del core; obligatoria solo con CORE_TRANSPORT=rest. */
  @Validate(UrlRestValida)
  @IsString({ message: 'CORE_REST_URL es obligatoria con CORE_TRANSPORT=rest' })
  @ValidateIf((o: VariablesEntorno) => o.CORE_TRANSPORT === 'rest')
  CORE_REST_URL?: string;

  /** Plazo de cada llamada al core, en milisegundos. Sin valor: 8000. */
  @Max(60_000, { message: 'CORE_TIMEOUT_MS debe estar entre 500 y 60000' })
  @Min(500, { message: 'CORE_TIMEOUT_MS debe estar entre 500 y 60000' })
  @IsInt({ message: 'CORE_TIMEOUT_MS debe ser un número entero' })
  @IsOptional()
  CORE_TIMEOUT_MS?: number;

  /** Llamadas al core que puede costar una consulta GraphQL. Sin valor: 10. */
  @Max(1000, { message: 'CORE_MAX_LLAMADAS_POR_CONSULTA debe estar entre 1 y 1000' })
  @Min(1, { message: 'CORE_MAX_LLAMADAS_POR_CONSULTA debe estar entre 1 y 1000' })
  @IsInt({ message: 'CORE_MAX_LLAMADAS_POR_CONSULTA debe ser un número entero' })
  @IsOptional()
  CORE_MAX_LLAMADAS_POR_CONSULTA?: number;

  /** Orígenes que pueden llamar desde un navegador. Sin valor: ninguno. */
  @Validate(ListaDeOrigenes)
  @IsOptional()
  CORS_ORIGINS?: string;

  /** Proxies delante del BFF (Render: 1). Sin valor: ninguno. Ver src/config/proxy.ts. */
  @Validate(TrustProxyValido)
  @IsOptional()
  TRUST_PROXY?: string;

  /**
   * Introspección del esquema y landing del sandbox. Sin valor: encendidas fuera de production
   * y apagadas en production.
   */
  @IsIn(['true', 'false'], { message: 'GRAPHQL_INTROSPECTION debe ser true o false' })
  @IsOptional()
  GRAPHQL_INTROSPECTION?: string;

  /** Duración de la ventana de todos los límites, en segundos. Sin valor: 60. */
  @Max(86_400, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @Min(1, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @IsInt({ message: 'RATE_LIMIT_WINDOW_SECONDS debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_WINDOW_SECONDS?: number;

  /** Peticiones por IP y ventana a /graphql, sea cual sea la operación. Sin valor: 100. */
  @Max(100_000, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_MAX?: number;

  /** searchFlights por IP y ventana. Sin valor: 20. */
  @Max(100_000, { message: 'RATE_LIMIT_SEARCH_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_SEARCH_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_SEARCH_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_SEARCH_MAX?: number;

  /** seatMap por IP y ventana. Sin valor: 60. */
  @Max(100_000, { message: 'RATE_LIMIT_SEATMAP_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_SEATMAP_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_SEATMAP_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_SEATMAP_MAX?: number;

  /** flightStatus por IP y ventana. Sin valor: 60. */
  @Max(100_000, { message: 'RATE_LIMIT_FLIGHT_STATUS_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_FLIGHT_STATUS_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_FLIGHT_STATUS_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_FLIGHT_STATUS_MAX?: number;
}

/** Límites de peticiones por IP y ventana: uno global y uno por operación raíz. */
export interface LimitesConfiguracion {
  ventanaSegundos: number;
  global: number;
  searchFlights: number;
  seatMap: number;
  flightStatus: number;
}

/** El entorno ya validado y con los valores por defecto aplicados; es lo que inyecta Nest. */
export interface Configuracion {
  puerto: number;
  entorno: Entorno;
  transporte: TransporteNucleo;
  grpcUrl: string;
  /** Origen del core por REST, sin barra final. Solo con transporte `rest`. */
  restUrl?: string;
  timeoutMs: number;
  maxLlamadasPorConsulta: number;
  corsOrigenes: string[];
  trustProxy: ValorTrustProxy;
  /** Introspección del esquema y landing del sandbox. */
  introspeccion: boolean;
  limites: LimitesConfiguracion;
}

export const CONFIGURACION = Symbol('CONFIGURACION');

/** Valida `process.env` (o el objeto que se pase); si algo falta o es inválido, lanza. */
export function validarEntorno(entorno: Record<string, unknown>): Configuracion {
  const variables = plainToInstance(VariablesEntorno, entorno, { enableImplicitConversion: true });
  const errores = validateSync(variables, { stopAtFirstError: true });

  if (errores.length > 0) {
    // Solo propiedad y mensaje: el valor recibido no se imprime nunca
    const detalle = errores
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas o faltantes:\n${detalle}`);
  }

  const enProduccion = variables.NODE_ENV === 'production';
  return {
    puerto: variables.PORT ?? PUERTO_POR_DEFECTO,
    entorno: variables.NODE_ENV,
    transporte: variables.CORE_TRANSPORT,
    grpcUrl: variables.CORE_GRPC_URL ?? GRPC_URL_POR_DEFECTO,
    restUrl:
      variables.CORE_TRANSPORT === 'rest'
        ? new URL(variables.CORE_REST_URL as string).origin
        : undefined,
    timeoutMs: variables.CORE_TIMEOUT_MS ?? TIMEOUT_POR_DEFECTO_MS,
    maxLlamadasPorConsulta: variables.CORE_MAX_LLAMADAS_POR_CONSULTA ?? MAX_LLAMADAS_POR_DEFECTO,
    corsOrigenes: listarOrigenes(variables.CORS_ORIGINS),
    trustProxy: parsearTrustProxy(variables.TRUST_PROXY) ?? false,
    introspeccion: variables.GRAPHQL_INTROSPECTION
      ? variables.GRAPHQL_INTROSPECTION === 'true'
      : !enProduccion,
    limites: {
      ventanaSegundos: variables.RATE_LIMIT_WINDOW_SECONDS ?? VENTANA_LIMITE_POR_DEFECTO_SEGUNDOS,
      global: variables.RATE_LIMIT_MAX ?? LIMITE_GLOBAL_POR_DEFECTO,
      searchFlights: variables.RATE_LIMIT_SEARCH_MAX ?? LIMITE_BUSQUEDA_POR_DEFECTO,
      seatMap: variables.RATE_LIMIT_SEATMAP_MAX ?? LIMITE_MAPA_ASIENTOS_POR_DEFECTO,
      flightStatus: variables.RATE_LIMIT_FLIGHT_STATUS_MAX ?? LIMITE_ESTADO_VUELO_POR_DEFECTO,
    },
  };
}
