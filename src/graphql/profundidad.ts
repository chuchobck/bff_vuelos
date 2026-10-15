import {
  ASTVisitor,
  FragmentDefinitionNode,
  GraphQLError,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
} from 'graphql';

/** Profundidad máxima de una consulta (CLAUDE.md). */
export const PROFUNDIDAD_MAXIMA = 8;

/**
 * Regla de validación: ninguna operación puede anidar más de `maximo` campos con sub-selección.
 * Cuenta los campos que abren llaves (`offers { ... }`), no las hojas (`offerId`), y sigue
 * fragmentos con y sin nombre (los ciclos de fragmentos los rechaza otra regla; aquí solo se
 * cortan para no recorrerlos sin fin). Los campos de introspección (`__schema`, `__type`) no
 * cuentan: la consulta estándar de introspección es más honda que 8 y solo existe si el esquema
 * es público.
 *
 * La consulta legítima más honda del esquema (búsqueda con el mapa de asientos de cada segmento)
 * llega a 8: searchFlights, offers, itineraries, segments, seatMap, cabins, rows, seats.
 */
export function reglaProfundidadMaxima(maximo = PROFUNDIDAD_MAXIMA) {
  return (contexto: ValidationContext): ASTVisitor => {
    const fragmentos = new Map<string, FragmentDefinitionNode>();
    for (const definicion of contexto.getDocument().definitions) {
      if (definicion.kind === Kind.FRAGMENT_DEFINITION) {
        fragmentos.set(definicion.name.value, definicion);
      }
    }

    const profundidad = (seleccion: SelectionSetNode, enCurso: Set<string>): number => {
      let mayor = 0;
      for (const nodo of seleccion.selections) {
        if (nodo.kind === Kind.FIELD) {
          if (nodo.name.value.startsWith('__') || !nodo.selectionSet) continue;
          mayor = Math.max(mayor, 1 + profundidad(nodo.selectionSet, enCurso));
        } else if (nodo.kind === Kind.INLINE_FRAGMENT) {
          mayor = Math.max(mayor, profundidad(nodo.selectionSet, enCurso));
        } else {
          const nombre = nodo.name.value;
          const fragmento = fragmentos.get(nombre);
          if (!fragmento || enCurso.has(nombre)) continue;
          enCurso.add(nombre);
          mayor = Math.max(mayor, profundidad(fragmento.selectionSet, enCurso));
          enCurso.delete(nombre);
        }
      }
      return mayor;
    };

    return {
      OperationDefinition(operacion: OperationDefinitionNode) {
        const alcanzada = profundidad(operacion.selectionSet, new Set());
        if (alcanzada > maximo) {
          contexto.reportError(
            new GraphQLError(
              `Query is too deep: it nests ${alcanzada} levels and the maximum is ${maximo}`,
              {
                nodes: [operacion],
                extensions: {
                  code: 'QUERY_TOO_DEEP',
                  problemCode: 'QUERY_TOO_DEEP',
                  status: 400,
                },
              },
            ),
          );
        }
      },
    };
  };
}
