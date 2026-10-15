import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import {
  EntradaBusqueda,
  EstadoVueloDetalle,
  MapaAsientos,
  ResultadoBusqueda,
} from '../../nucleo/modelo';
import { ContextoGraphQL } from '../contexto';
import { errorHuella } from '../errores';
import { OFERTA_DEL_SEGMENTO } from './segmento.resolver';

/** La entrada de graphql-js trae objetos sin prototipo: se copia a objetos planos. */
function aEntradaBusqueda(input: EntradaBusqueda): EntradaBusqueda {
  return {
    itineraries: input.itineraries.map((tramo) => ({
      origin: tramo.origin,
      destination: tramo.destination,
      departureDate: tramo.departureDate,
    })),
    passengers: {
      adults: input.passengers.adults,
      youths: input.passengers.youths,
      children: input.passengers.children,
      infants: input.passengers.infants,
    },
  };
}

@Resolver('Query')
export class ConsultasResolver {
  @Query('searchFlights')
  async buscarVuelos(
    @Args('input') input: EntradaBusqueda,
    @Context() contexto: ContextoGraphQL,
  ): Promise<ResultadoBusqueda> {
    // La huella es obligatoria solo aquí; sin ella no se llama al core
    if (typeof contexto.huella !== 'string') throw errorHuella(contexto.huella === undefined);
    const resultado = await contexto.nucleo.buscarVuelos(aEntradaBusqueda(input));
    // Cada segmento recuerda de qué oferta es, para pedir su mapa solo si la consulta lo pide
    for (const oferta of resultado.offers) {
      for (const itinerario of oferta.itineraries) {
        for (const segmento of itinerario.segments) {
          (segmento as unknown as Record<symbol, string>)[OFERTA_DEL_SEGMENTO] = oferta.offerId;
        }
      }
    }
    return resultado;
  }

  @Query('seatMap')
  mapaAsientos(
    @Args('offerId') offerId: string,
    @Args('segmentId') segmentId: string,
    @Context() contexto: ContextoGraphQL,
  ): Promise<MapaAsientos> {
    return contexto.nucleo.mapaAsientos(offerId, segmentId);
  }

  @Query('flightStatus')
  estadoVuelo(
    @Args('flightNumber') flightNumber: string,
    @Args('date') date: string,
    @Context() contexto: ContextoGraphQL,
  ): Promise<EstadoVueloDetalle> {
    return contexto.nucleo.estadoVuelo(flightNumber, date);
  }
}
