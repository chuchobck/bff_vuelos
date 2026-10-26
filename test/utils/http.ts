import { request as pedirHttp } from 'node:http';

/** GET/POST a una URL absoluta (el puerto de métricas no es el del servidor de la app). */
export function pedirUrl(
  url: string,
  opciones: {
    metodo?: string;
    cabeceras?: Record<string, string | string[]>;
    cuerpo?: string;
  } = {},
): Promise<{
  status: number;
  texto: string;
  cabeceras: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolver, rechazar) => {
    const peticion = pedirHttp(
      url,
      { method: opciones.metodo ?? 'GET', headers: opciones.cabeceras },
      (r) => {
        const trozos: Buffer[] = [];
        r.on('data', (t: Buffer) => trozos.push(t));
        r.on('end', () =>
          resolver({
            status: r.statusCode ?? 0,
            texto: Buffer.concat(trozos).toString('utf8'),
            cabeceras: r.headers,
          }),
        );
      },
    );
    peticion.on('error', rechazar);
    peticion.end(opciones.cuerpo);
  });
}

/** Las series de una métrica como { etiquetas: valor }. */
export function series(texto: string, nombre: string): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}{`) && !linea.startsWith(`${nombre} `)) continue;
    const espacio = linea.lastIndexOf(' ');
    mapa.set(linea.slice(nombre.length, espacio), Number(linea.slice(espacio + 1)));
  }
  return mapa;
}
