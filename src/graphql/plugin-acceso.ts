import { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { ContextoGraphQL } from './contexto';
import { datosAccesoDe, nombreOperacionSeguro } from './trazabilidad';

/**
 * Deja en `res.locals.acceso` el nombre de la operación, que el middleware de acceso escribe al
 * terminar. El nombre sale del documento ya resuelto (nunca del campo `operationName` crudo).
 */
export class PluginAcceso implements ApolloServerPlugin<BaseContext> {
  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    return {
      async didResolveOperation(contexto) {
        const { res } = contexto.contextValue as ContextoGraphQL;
        datosAccesoDe(res).operationName = nombreOperacionSeguro(contexto.operationName);
      },
    };
  }
}
