import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import { Request, Response } from 'express';
import { Configuracion, CONFIGURACION } from '../config/entorno';
import { LimitadorPeticiones } from '../limites/limitador';
import { LimitesModule } from '../limites/limites.module';
import { NucleoModule } from '../nucleo/nucleo.module';
import { NUCLEO_VUELOS, NucleoVuelos } from '../nucleo/nucleo-vuelos';
import { crearContexto } from './contexto';
import { EscalarFecha, EscalarInstante } from './escalares';
import { formatearError } from './errores-graphql';
import { PluginAcceso } from './plugin-acceso';
import { PluginLimites } from './plugin-limites';
import { PluginObservabilidad } from '../telemetria/plugin-observabilidad';
import { Observabilidad, OBSERVABILIDAD } from '../telemetria/observabilidad';
import { reglaProfundidadMaxima } from './profundidad';
import { ConsultasResolver } from './resolvers/consultas.resolver';
import { SegmentoResolver } from './resolvers/segmento.resolver';

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
      imports: [NucleoModule, LimitesModule],
      inject: [CONFIGURACION, NUCLEO_VUELOS, LimitadorPeticiones, OBSERVABILIDAD],
      useFactory: (
        configuracion: Configuracion,
        nucleo: NucleoVuelos,
        limitador: LimitadorPeticiones,
        observabilidad: Observabilidad,
      ): ApolloDriverConfig => ({
        typePaths: [join(__dirname, 'schema.graphql')],
        path: RUTA_GRAPHQL,
        introspection: configuracion.introspeccion,
        // El landing del sandbox va con la introspección: ambos solo cuando el esquema es público
        playground: configuracion.introspeccion,
        includeStacktraceInErrorResponses: false,
        allowBatchedHttpRequests: false,
        csrfPrevention: true,
        formatError: formatearError,
        plugins: [
          new PluginAcceso(),
          // Antes del límite: el span de la operación cubre también lo que el límite rechaza
          new PluginObservabilidad(observabilidad),
          new PluginLimites(limitador, configuracion),
        ],
        // Profundidad máxima 8 (ver profundidad.ts)
        validationRules: [reglaProfundidadMaxima()],
        // Un contexto nuevo por petición: request id, huella, llamadas al core y DataLoader
        context: ({ req, res }: { req: Request; res: Response }) =>
          crearContexto(req, res, nucleo, configuracion),
      }),
    }),
  ],
  providers: [EscalarFecha, EscalarInstante, ConsultasResolver, SegmentoResolver],
})
export class GraphqlModule {}
