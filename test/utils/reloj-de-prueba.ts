import { Reloj } from '../../src/common/reloj';

/** Un reloj que solo avanza cuando la prueba lo dice: nada espera de verdad ni lee Date.now(). */
export class RelojDePrueba extends Reloj {
  constructor(private instante = Date.parse('2026-10-20T10:00:00.000Z')) {
    super();
  }

  ahora(): Date {
    return new Date(this.instante);
  }

  avanzar(ms: number): void {
    this.instante += ms;
  }

  retroceder(ms: number): void {
    this.instante -= ms;
  }
}
