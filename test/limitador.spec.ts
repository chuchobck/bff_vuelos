import { LimitadorPeticiones } from '../src/limites/limitador';
import { RelojDePrueba } from './utils/reloj-de-prueba';

const MINUTO = 60_000;

describe('LimitadorPeticiones (ventana deslizante con Reloj)', () => {
  let reloj: RelojDePrueba;
  let limitador: LimitadorPeticiones;

  beforeEach(() => {
    reloj = new RelojDePrueba();
    limitador = new LimitadorPeticiones(reloj);
  });

  afterEach(() => limitador.onApplicationShutdown());

  it('deja pasar hasta el límite y rechaza la siguiente', () => {
    for (let i = 0; i < 3; i++) expect(limitador.consumir('a', 1, 3, MINUTO).permitido).toBe(true);

    expect(limitador.consumir('a', 1, 3, MINUTO)).toEqual({
      permitido: false,
      reintentarEnSegundos: 60,
    });
  });

  it('Retry-After es lo que falta para que salga la petición más vieja', () => {
    limitador.consumir('a', 1, 2, MINUTO);
    reloj.avanzar(10_000);
    limitador.consumir('a', 1, 2, MINUTO);
    reloj.avanzar(5_000);

    // La más vieja tiene 15 s: salen en 45 s
    expect(limitador.consumir('a', 1, 2, MINUTO)).toEqual({
      permitido: false,
      reintentarEnSegundos: 45,
    });
  });

  it('la ventana desliza: al salir la más vieja cabe otra, sin esperar a que pase todo', () => {
    limitador.consumir('a', 1, 2, MINUTO);
    reloj.avanzar(30_000);
    limitador.consumir('a', 1, 2, MINUTO);

    reloj.avanzar(30_001); // la primera ya salió; la segunda sigue

    expect(limitador.consumir('a', 1, 2, MINUTO).permitido).toBe(true);
    expect(limitador.consumir('a', 1, 2, MINUTO).permitido).toBe(false);
  });

  it('una rechazada no consume cupo', () => {
    limitador.consumir('a', 1, 1, MINUTO);
    for (let i = 0; i < 10; i++) limitador.consumir('a', 1, 1, MINUTO);

    reloj.avanzar(MINUTO + 1);

    expect(limitador.consumir('a', 1, 1, MINUTO).permitido).toBe(true);
  });

  it('consumir varias a la vez es todo o nada', () => {
    limitador.consumir('a', 3, 5, MINUTO);

    const r = limitador.consumir('a', 3, 5, MINUTO);

    expect(r.permitido).toBe(false);
    // No consumió 3: todavía caben 2
    expect(limitador.consumir('a', 2, 5, MINUTO).permitido).toBe(true);
  });

  it('pedir más que el límite entero nunca cabe y espera una ventana', () => {
    expect(limitador.consumir('a', 6, 5, MINUTO)).toEqual({
      permitido: false,
      reintentarEnSegundos: 60,
    });
  });

  it('comprobar no consume', () => {
    expect(limitador.comprobar('a', 1, 1, MINUTO).permitido).toBe(true);
    expect(limitador.comprobar('a', 1, 1, MINUTO).permitido).toBe(true);
    expect(limitador.consumir('a', 1, 1, MINUTO).permitido).toBe(true);
    expect(limitador.comprobar('a', 1, 1, MINUTO).permitido).toBe(false);
  });

  it('cada clave tiene su contador', () => {
    limitador.consumir('a', 1, 1, MINUTO);

    expect(limitador.consumir('b', 1, 1, MINUTO).permitido).toBe(true);
  });

  it('si el reloj retrocede, el bloqueo no dura más de una ventana', () => {
    limitador.consumir('a', 1, 1, MINUTO);
    reloj.retroceder(10 * MINUTO);

    const r = limitador.consumir('a', 1, 1, MINUTO);

    expect(r.permitido).toBe(false);
    expect(r.reintentarEnSegundos).toBeLessThanOrEqual(60);
    reloj.avanzar(MINUTO + 1);
    expect(limitador.consumir('a', 1, 1, MINUTO).permitido).toBe(true);
  });

  it('Retry-After nunca baja de 1 segundo', () => {
    limitador.consumir('a', 1, 1, MINUTO);
    reloj.avanzar(MINUTO - 1);

    expect(limitador.consumir('a', 1, 1, MINUTO).reintentarEnSegundos).toBe(1);
  });
});
