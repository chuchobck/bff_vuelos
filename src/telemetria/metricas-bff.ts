import { Counter, Histogram, Registry } from 'prom-client';
import { CODIGOS } from '../graphql/errores';
import { campoRaizSeguro, OTRO } from './atributos-bff';

/**
 * Los `code` de error que puede llevar una respuesta del BFF: los propios (graphql/errores.ts) y
 * los de GraphQL y Apollo. Cualquier otro valor es `__other__`: la etiqueta nunca sale de un texto
 * del cliente.
 */
export const CODIGOS_DE_ERROR_CONOCIDOS: ReadonlySet<string> = new Set([
  ...Object.values(CODIGOS),
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_REQUEST',
  'OPERATION_RESOLUTION_FAILURE',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
]);

/**
 * Cubetas de bff_core_calls_per_query: de 0 llamadas (un error de validación, un límite) hasta el
 * tope de CORE_MAX_LLAMADAS_POR_CONSULTA (10 por defecto) y más allá, por si se sube.
 */
export const CUBETAS_LLAMADAS_AL_CORE = [0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 50, 100];

/**
 * Las métricas propias del BFF, en el mismo Registry que las del estándar. Todas con etiquetas
 * acotadas (regla de cardinalidad de docs/OBSERVABILIDAD.md): un campo del esquema o `__other__`, un
 * código de la lista cerrada o `__other__`. Ni nombres de operación, ni alias, ni ids.
 */
export class MetricasBff {
  readonly camposRaiz: Counter<'field'>;
  readonly errores: Counter<'code'>;
  readonly llamadasPorConsulta: Histogram;

  constructor(registro: Registry) {
    this.camposRaiz = new Counter({
      name: 'graphql_root_fields_total',
      help: 'Campos raíz ejecutados (solo los del esquema; el resto, __other__)',
      labelNames: ['field'] as const,
      registers: [registro],
    });
    this.errores = new Counter({
      name: 'graphql_errors_total',
      help: 'Errores devueltos en respuestas GraphQL, por code (de una lista cerrada; el resto, __other__)',
      labelNames: ['code'] as const,
      registers: [registro],
    });
    this.llamadasPorConsulta = new Histogram({
      name: 'bff_core_calls_per_query',
      help: 'Llamadas reales al core que hizo cada consulta (después del DataLoader)',
      buckets: CUBETAS_LLAMADAS_AL_CORE,
      registers: [registro],
    });
  }

  campo(campo: string, veces = 1): void {
    this.camposRaiz.inc({ field: campoRaizSeguro(campo) }, veces);
  }

  error(codigo: unknown): void {
    this.errores.inc({
      code: typeof codigo === 'string' && CODIGOS_DE_ERROR_CONOCIDOS.has(codigo) ? codigo : OTRO,
    });
  }

  consulta(llamadasAlCore: number): void {
    this.llamadasPorConsulta.observe(llamadasAlCore);
  }
}
