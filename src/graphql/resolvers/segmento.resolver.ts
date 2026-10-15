import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { MapaAsientos, SegmentoVuelo } from '../../nucleo/modelo';
import { ContextoGraphQL } from '../contexto';

/**
 * Clave (símbolo, así no es un campo del GraphQL ni sale en JSON) donde searchFlights deja en
 * cada segmento el offerId de su oferta.
 */
export const OFERTA_DEL_SEGMENTO = Symbol('offerIdDelSegmento');

@Resolver('FlightSegment')
export class SegmentoResolver {
  /**
   * Perezoso: GraphQL solo llama a este resolver si la consulta pide `seatMap` en el segmento, y
   * recién entonces cuesta una llamada al core (con el offerId heredado del padre). El DataLoader
   * de la petición junta los pedidos iguales.
   */
  @ResolveField('seatMap')
  mapaAsientos(
    @Parent() segmento: SegmentoVuelo,
    @Context() contexto: ContextoGraphQL,
  ): Promise<MapaAsientos> {
    const offerId = (segmento as unknown as Record<symbol, string | undefined>)[
      OFERTA_DEL_SEGMENTO
    ];
    if (offerId === undefined) {
      // Un segmento sin oferta no puede llegar aquí: seatMap solo cuelga de searchFlights
      return Promise.reject(new Error('Segment without offer'));
    }
    return contexto.nucleo.mapaAsientos(offerId, segmento.segmentId);
  }
}
