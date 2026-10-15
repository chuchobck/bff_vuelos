import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo mínimo de la petición que necesita quien no recibe el contexto GraphQL: el formateador de
 * errores de Apollo y el log. Se abre en el middleware, después del parser del cuerpo (que
 * perdería el contexto asíncrono si se abriera antes).
 */
export interface ContextoAsincrono {
  requestId: string;
}

export const contextoPeticion = new AsyncLocalStorage<ContextoAsincrono>();

export function requestIdActual(): string | undefined {
  return contextoPeticion.getStore()?.requestId;
}
