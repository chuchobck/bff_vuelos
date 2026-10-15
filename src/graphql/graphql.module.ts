import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import { Configuracion, CONFIGURACION } from '../config/entorno';
import { EscalarFecha, EscalarInstante } from './escalares';

/** La ruta del endpoint GraphQL. */
export const RUTA_GRAPHQL = '/graphql';

/**
 * Apollo Server 4 sobre Express, schema-first: el contrato es `schema.graphql`.
 *
 * - Introspección y landing del sandbox: encendidos según `Configuracion.introspeccion`
 *   (apagados en production salvo GRAPHQL_INTROSPECTION=true).
 * - Sin stacktrace en las respuestas de error, nunca, ni en desarrollo.
 * - Sin consultas en lote (`allowBatchedHttpRequests: false`) y con la protección CSRF de Apollo.
 */
@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [CONFIGURACION],
      useFactory: (configuracion: Configuracion): ApolloDriverConfig => ({
        typePaths: [join(__dirname, 'schema.graphql')],
        path: RUTA_GRAPHQL,
        introspection: configuracion.introspeccion,
        // El landing del sandbox va con la introspección: ambos solo cuando el esquema es público
        playground: configuracion.introspeccion,
        includeStacktraceInErrorResponses: false,
        allowBatchedHttpRequests: false,
        csrfPrevention: true,
      }),
    }),
  ],
  providers: [EscalarFecha, EscalarInstante],
})
export class GraphqlModule {}
