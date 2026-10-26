import { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { SpanKind } from '@opentelemetry/api';
import { marcarError } from '../observabilidad/trazas';
import { ContextoGraphQL } from '../graphql/contexto';
import { contarCamposRaiz } from '../graphql/plugin-limites';
import { campoRaizSeguro, filtrarAtributosBff } from './atributos-bff';
import { Observabilidad } from './observabilidad';
import { observacionDe } from './observacion';

/** `error.type` (lista cerrada del estándar) de un `code` de error: solo lo que es culpa del servicio. */
const TIPO_DE_ERROR: Readonly<Record<string, string>> = {
  GATEWAY_TIMEOUT: 'timeout',
  SERVICE_UNAVAILABLE: 'unavailable',
  INTERNAL_SERVER_ERROR: '500',
};

/**
 * Observabilidad de cada operación GraphQL:
 *  - un span INTERNAL con `graphql.operation.type` y los NOMBRES de los campos raíz del esquema
 *    (`searchFlights,seatMap`). Nunca el texto de la consulta, las variables, los argumentos, un
 *    alias ni el `operationName` del cliente;
 *  - `graphql_root_fields_total{field}`, `graphql_errors_total{code}` y `bff_core_calls_per_query`.
 *
 * El span cuelga del SERVER y es el padre de cada llamada al core (ClienteNucleo lo toma de
 * `res.locals.observacion.operacion`). Se cierra al responder, también si la operación se rechaza
 * (límite de peticiones) o hay errores de validación.
 */
export class PluginObservabilidad implements ApolloServerPlugin<BaseContext> {
  constructor(private readonly obs: Observabilidad) {}

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const { trazas, bff } = this.obs;
    return {
      async didResolveOperation(contexto) {
        const { res } = contexto.contextValue as ContextoGraphQL;
        const observacion = observacionDe(res);
        if (!observacion || !contexto.operation) return;

        const campos = contarCamposRaiz(contexto.document, contexto.operation);
        for (const [campo, veces] of campos) bff.campo(campo, veces);
        const nombres = [...new Set([...campos.keys()].map(campoRaizSeguro))].sort();

        const tipo = contexto.operation.operation;
        observacion.operacion = trazas.tracer.startSpan(
          nombres.length > 0 ? `graphql ${tipo} ${nombres.join(',')}` : `graphql ${tipo}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: filtrarAtributosBff({
              'graphql.operation.type': tipo,
              'graphql.root_fields': nombres.length > 0 ? nombres.join(',') : undefined,
            }),
          },
          observacion.contexto,
        );
      },

      async willSendResponse(contexto) {
        const { res, nucleo } = contexto.contextValue as ContextoGraphQL;
        const cuerpo = contexto.response.body;
        const errores = cuerpo.kind === 'single' ? (cuerpo.singleResult.errors ?? []) : [];
        let tipoDeError: string | undefined;
        for (const error of errores) {
          const code = error.extensions?.code;
          bff.error(code);
          tipoDeError ??= typeof code === 'string' ? TIPO_DE_ERROR[code] : undefined;
        }
        bff.consulta(nucleo?.totalLlamadas ?? 0);

        const operacion = observacionDe(res)?.operacion;
        if (operacion) {
          // Solo un fallo del servicio marca el span (nunca el mensaje); un error del cliente no
          if (tipoDeError) marcarError(operacion, tipoDeError);
          operacion.end();
        }
      },
    };
  }
}
