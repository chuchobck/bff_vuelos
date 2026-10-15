import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Reloj } from '../common/reloj';

/** Cada cuánto se quitan de memoria los contadores sin peticiones vigentes. */
const BARRIDO_MS = 60_000;

export interface ResultadoLimite {
  permitido: boolean;
  /** Segundos hasta que cabría esa cantidad de peticiones (1 como mínimo); 0 si se permitió. */
  reintentarEnSegundos: number;
}

interface Contador {
  ventanaMs: number;
  /** Instantes (ms) de las peticiones contadas, del más viejo al más nuevo. */
  instantes: number[];
}

/**
 * El límite de peticiones del BFF, el más simple que sirve: una ventana deslizante en memoria,
 * con la hora del `Reloj` inyectable (las pruebas la adelantan; nada usa `Date.now()`).
 *
 * Por qué propio y no @nestjs/throttler: el throttler decide con el contexto HTTP/GraphQL antes de
 * resolver y cuenta una vez por petición, y aquí hace falta contar por operación raíz (varios
 * campos con alias en una sola petición son varias operaciones) y de forma atómica. Son ~50 líneas
 * sin dependencias, y el almacén del throttler tampoco acepta un reloj.
 *
 * Ventana deslizante: cuenta las peticiones de los últimos `ventana` ms. Si no caben, no se
 * cuenta ninguna (todo o nada) y se dice en cuántos segundos cabrían (`Retry-After`). Una
 * rechazada no consume cupo.
 *
 * Saltos de reloj: si la hora retrocede, una petición anotada "en el futuro" se toma como hecha
 * ahora (un bloqueo nunca dura más de una ventana); si avanza, las viejas salen antes.
 *
 * Es por proceso: con varias instancias el límite se multiplica. Hoy hay una (Render free); si
 * hubiera más haría falta un almacén compartido.
 */
@Injectable()
export class LimitadorPeticiones implements OnApplicationShutdown {
  private readonly contadores = new Map<string, Contador>();
  private barrido: NodeJS.Timeout | undefined;

  constructor(private readonly reloj: Reloj) {}

  /** ¿Caben `cantidad` peticiones más en el contador `clave`? No consume nada. */
  comprobar(clave: string, cantidad: number, limite: number, ventanaMs: number): ResultadoLimite {
    return this.evaluar(clave, cantidad, limite, ventanaMs).resultado;
  }

  /** Consume `cantidad` peticiones del contador `clave` si caben; si no, no consume ninguna. */
  consumir(clave: string, cantidad: number, limite: number, ventanaMs: number): ResultadoLimite {
    const { resultado, instantes, ahora } = this.evaluar(clave, cantidad, limite, ventanaMs);
    if (resultado.permitido) {
      for (let i = 0; i < cantidad; i++) instantes.push(ahora);
      this.contadores.set(clave, { ventanaMs, instantes });
    }
    return resultado;
  }

  /** Borra todos los contadores (las pruebas lo usan entre casos). */
  reiniciar(): void {
    this.contadores.clear();
  }

  onApplicationShutdown(): void {
    clearInterval(this.barrido);
    this.barrido = undefined;
    this.contadores.clear();
  }

  private evaluar(clave: string, cantidad: number, limite: number, ventanaMs: number) {
    this.iniciarBarrido();
    const ahora = this.reloj.ahora().getTime();
    const instantes = vigentes(this.contadores.get(clave)?.instantes ?? [], ahora, ventanaMs);

    // Cuántas peticiones tendrían que salir de la ventana para que quepan
    const sobran = instantes.length + cantidad - limite;
    if (sobran <= 0) {
      return { resultado: { permitido: true, reintentarEnSegundos: 0 }, instantes, ahora };
    }
    // Pedir más que el límite entero nunca cabe: se espera una ventana completa
    const hastaQueSalga = cantidad > limite ? ventanaMs : instantes[sobran - 1] + ventanaMs - ahora;
    return {
      resultado: {
        permitido: false,
        reintentarEnSegundos: Math.min(
          Math.ceil(ventanaMs / 1000),
          Math.max(1, Math.ceil(hastaQueSalga / 1000)),
        ),
      },
      instantes,
      ahora,
    };
  }

  private iniciarBarrido(): void {
    if (this.barrido) return;
    this.barrido = setInterval(() => {
      const ahora = this.reloj.ahora().getTime();
      for (const [clave, contador] of this.contadores) {
        if (vigentes(contador.instantes, ahora, contador.ventanaMs).length === 0) {
          this.contadores.delete(clave);
        }
      }
    }, BARRIDO_MS);
    this.barrido.unref();
  }
}

/** Las peticiones dentro de la ventana; una "del futuro" (el reloj retrocedió) cuenta como ahora. */
function vigentes(instantes: readonly number[], ahora: number, ventanaMs: number): number[] {
  return instantes.map((t) => Math.min(t, ahora)).filter((t) => t > ahora - ventanaMs);
}
