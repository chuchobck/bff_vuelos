import { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import {
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLError,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import { Configuracion } from '../config/entorno';
import { LimitadorPeticiones } from '../limites/limitador';
import { ContextoGraphQL } from './contexto';

/** El nombre de cada operación raíz con su tope por IP y ventana (iguales a los del core en REST). */
export function topesPorOperacion(configuracion: Configuracion): Record<string, number> {
  const { limites } = configuracion;
  return {
    searchFlights: limites.searchFlights,
    seatMap: limites.seatMap,
    flightStatus: limites.flightStatus,
  };
}

/**
 * Cuántas veces se ejecuta cada campo raíz de la operación. Cuenta claves de respuesta distintas:
 * `a: seatMap(...) b: seatMap(...)` son dos ejecuciones; el mismo campo repetido sin alias se
 * fusiona en una. Sigue fragmentos con y sin nombre. Ignora `@skip` y `@include` (de más, no de menos).
 */
export function contarCamposRaiz(
  documento: DocumentNode,
  operacion: OperationDefinitionNode,
): Map<string, number> {
  const fragmentos = new Map<string, FragmentDefinitionNode>();
  for (const definicion of documento.definitions) {
    if (definicion.kind === Kind.FRAGMENT_DEFINITION)
      fragmentos.set(definicion.name.value, definicion);
  }
  const clavesPorCampo = new Map<string, Set<string>>();
  const visitados = new Set<string>();
  const recorrer = (seleccion: SelectionSetNode): void => {
    for (const nodo of seleccion.selections) {
      if (nodo.kind === Kind.FIELD) {
        const campo = nodo.name.value;
        if (campo.startsWith('__')) continue;
        const clave = nodo.alias?.value ?? campo;
        if (!clavesPorCampo.has(campo)) clavesPorCampo.set(campo, new Set());
        clavesPorCampo.get(campo)!.add(clave);
      } else if (nodo.kind === Kind.INLINE_FRAGMENT) {
        recorrer(nodo.selectionSet);
      } else if (!visitados.has(nodo.name.value)) {
        visitados.add(nodo.name.value);
        const fragmento = fragmentos.get(nodo.name.value);
        if (fragmento) recorrer(fragmento.selectionSet);
      }
    }
  };
  recorrer(operacion.selectionSet);
  return new Map([...clavesPorCampo].map(([campo, claves]) => [campo, claves.size]));
}

export function errorLimite(segundos: number): GraphQLError {
  return new GraphQLError(`Too many requests; retry in ${segundos} seconds`, {
    extensions: {
      code: 'TOO_MANY_REQUESTS',
      problemCode: 'RATE_LIMIT_EXCEEDED',
      status: 429,
      retryAfter: segundos,
      // Apollo lo quita del cuerpo y lo convierte en estado y cabecera HTTP
      http: { status: 429, headers: new Map([['retry-after', String(segundos)]]) },
    },
  });
}

/**
 * Límite por IP y por operación raíz (searchFlights 20 por minuto, seatMap 60, flightStatus 60),
 * como el core lo hace en REST y no en gRPC. Corre al resolverse la operación, cuando ya se sabe
 * qué campos pide; antes de llamar al core. Si una consulta pide más ejecuciones de las que
 * caben, se rechaza entera y no consume cupo. El límite global (100) lo cuenta el middleware.
 */
export class PluginLimites implements ApolloServerPlugin<BaseContext> {
  private readonly topes: Record<string, number>;

  constructor(
    private readonly limitador: LimitadorPeticiones,
    private readonly configuracion: Configuracion,
  ) {
    this.topes = topesPorOperacion(configuracion);
  }

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const { limitador, configuracion, topes } = this;
    return {
      async didResolveOperation(contexto) {
        const { req } = contexto.contextValue as ContextoGraphQL;
        if (!contexto.operation) return;
        const ventanaMs = configuracion.limites.ventanaSegundos * 1000;
        const ip = req.ip ?? 'desconocida';

        const pedidos = [...contarCamposRaiz(contexto.document, contexto.operation)]
          .filter(([campo]) => topes[campo] !== undefined)
          .map(([campo, cantidad]) => ({
            clave: `op|${campo}|${ip}`,
            cantidad,
            tope: topes[campo],
          }));

        // Primero se mira todo: o caben todas las operaciones o no se consume ninguna
        const resultados = pedidos.map((p) =>
          limitador.comprobar(p.clave, p.cantidad, p.tope, ventanaMs),
        );
        if (resultados.some((r) => !r.permitido)) {
          throw errorLimite(Math.max(...resultados.map((r) => r.reintentarEnSegundos)));
        }
        for (const p of pedidos) limitador.consumir(p.clave, p.cantidad, p.tope, ventanaMs);
      },
    };
  }
}
