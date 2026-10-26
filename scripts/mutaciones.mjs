#!/usr/bin/env node
// "Rompe a propósito lo que cada prueba cubre": aplica una mutación al código (no propagar el
// traceparent al core, poner la consulta como atributo de un span, usar el nombre de operación del
// cliente como etiqueta, dejar /metrics en el puerto principal...), corre la prueba que la debería
// detectar y exige que FALLE. Restaura los archivos siempre, también si se corta con Ctrl+C. Una
// prueba que no falla al romper lo que cubre no prueba nada (CLAUDE.md, sección Pruebas).
//
//   npm run test:mutaciones                 (todas; no necesita nada más que Node)
//   npm run test:mutaciones -- huella       (solo las que contienen ese texto en el nombre)
//
// Una mutación cuyo texto ya no está en el código (alguien cambió esa línea) cuenta como fallo del
// script: hay que actualizarla aquí. No corre en CI: tarda un par de minutos.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NUCLEO_GRPC = 'src/nucleo/grpc/nucleo-grpc.ts';
const NUCLEO_REST = 'src/nucleo/rest/nucleo-rest.ts';
const PLUGIN_OBS = 'src/telemetria/plugin-observabilidad.ts';
const MIDDLEWARE = 'src/telemetria/middleware.ts';
const CONFIGURAR = 'src/configurar-app.ts';
const CONTEXTO = 'src/graphql/contexto.ts';
const TRAZABILIDAD = 'src/graphql/trazabilidad.ts';
const METRICAS_BFF = 'src/telemetria/metricas-bff.ts';

const PROPAGACION = 'test/propagacion-core.spec.ts';
const SPANS = 'test/spans-graphql.spec.ts';
const TRAZAS = 'test/trazas.spec.ts';
const ESCANEO = 'test/escaneo-observabilidad.spec.ts';
const METRICAS_BFF_PRUEBA = 'test/metricas-bff.spec.ts';

/** nombre, cambios por archivo [{ archivo, cambios: [buscar, reemplazar] }], prueba y filtro (-t) que debe fallar. */
const MUTACIONES = [
  // --- las que pide la fase 7b -----------------------------------------------------------------
  {
    nombre: 'no-propagar-grpc: la llamada gRPC al core no manda traceparent',
    archivos: [
      {
        archivo: NUCLEO_GRPC,
        cambios: [
          [
            '    if (llamada.traceparent) metadata.set(METADATA.traceparent, llamada.traceparent);\n',
            '',
          ],
        ],
      },
    ],
    prueba: PROPAGACION,
    filtro: 'por grpc el core recibe un traceparent',
  },
  {
    nombre: 'no-propagar-rest: la llamada REST al core no manda traceparent',
    archivos: [
      {
        archivo: NUCLEO_REST,
        cambios: [
          ['    if (llamada.traceparent) cabeceras.traceparent = llamada.traceparent;\n', ''],
        ],
      },
    ],
    prueba: PROPAGACION,
    filtro: 'por rest el core recibe un traceparent',
  },
  {
    nombre: 'consulta-como-atributo: el texto de la consulta va en un atributo del span',
    archivos: [
      {
        archivo: PLUGIN_OBS,
        cambios: [
          [
            'attributes: filtrarAtributosBff({',
            "attributes: ({ 'graphql.document': contexto.source,",
          ],
        ],
      },
    ],
    prueba: SPANS,
    filtro: 'no llegan a ningún span',
  },
  {
    nombre: 'operacion-como-etiqueta: el nombre de operación del cliente es la etiqueta del campo',
    archivos: [
      {
        archivo: PLUGIN_OBS,
        cambios: [
          [
            'for (const [campo, veces] of campos) bff.campo(campo, veces);',
            "for (const [, veces] of campos) bff.camposRaiz.inc({ field: contexto.operationName ?? 'anonima' }, veces);",
          ],
        ],
      },
    ],
    prueba: ESCANEO,
    filtro: 'mil variantes dejan exactamente las mismas series',
  },
  {
    nombre: 'metrics-en-principal: /metrics se sirve también por el puerto de la aplicación',
    archivos: [
      {
        archivo: CONFIGURAR,
        cambios: [
          [
            '  app.use(middlewareObservabilidad(observabilidad));\n',
            "  app.use(middlewareObservabilidad(observabilidad));\n  app.use('/metrics', (_req: unknown, res: { end: (texto: string) => void }) => {\n    void observabilidad.metricas.exponer().then((texto) => res.end(texto));\n  });\n",
          ],
        ],
      },
    ],
    prueba: TRAZAS,
    filtro: 'en el puerto principal /metrics no existe',
  },
  // --- las demás del estándar ------------------------------------------------------------------
  {
    nombre: 'ruta-cruda: la ruta pedida (no la plantilla) llega al span y a la métrica',
    archivos: [
      {
        archivo: MIDDLEWARE,
        cambios: [
          ['const ruta = plantillaDeRuta(req.originalUrl);', 'const ruta = req.originalUrl;'],
        ],
      },
    ],
    prueba: TRAZAS,
    filtro: 'lleva la plantilla de la ruta',
  },
  {
    nombre: 'huella-en-log: el log de acceso lleva la X-Device-Fingerprint',
    archivos: [
      {
        archivo: TRAZABILIDAD,
        cambios: [
          [
            '        llamadasAlNucleo: acceso.llamadasAlNucleo(),\n',
            "        llamadasAlNucleo: acceso.llamadasAlNucleo(),\n        huella: req.headers['x-device-fingerprint'],\n",
          ],
        ],
      },
    ],
    prueba: ESCANEO,
    filtro: 'llevan la huella',
  },
  {
    nombre: 'ip-en-log: el log de acceso lleva la IP del cliente',
    archivos: [
      {
        archivo: TRAZABILIDAD,
        cambios: [
          [
            '        llamadasAlNucleo: acceso.llamadasAlNucleo(),\n',
            '        llamadasAlNucleo: acceso.llamadasAlNucleo(),\n        ip: req.ip,\n',
          ],
        ],
      },
    ],
    prueba: ESCANEO,
    filtro: 'llevan la IP del cliente',
  },
  {
    nombre: 'cliente-sin-padre: el span CLIENT no cuelga de la operación sino del SERVER',
    archivos: [
      {
        archivo: CONTEXTO,
        cambios: [
          [
            '      padre: observacion.operacion\n        ? trace.setSpan(observacion.contexto, observacion.operacion)\n        : observacion.contexto,',
            '      padre: observacion.contexto,',
          ],
        ],
      },
    ],
    prueba: PROPAGACION,
    filtro: 'por grpc jerarquía',
  },
  {
    nombre: 'sin-x-trace-id: la respuesta no devuelve X-Trace-Id',
    archivos: [
      {
        archivo: MIDDLEWARE,
        cambios: [['      res.setHeader(CABECERA_TRACE_ID, span.spanContext().traceId);\n', '']],
      },
    ],
    prueba: TRAZAS,
    filtro: 'X-Trace-Id también sale',
  },
  {
    nombre: 'errores-sin-codigo-cerrado: graphql_errors_total usa el code tal cual',
    archivos: [
      {
        archivo: METRICAS_BFF,
        cambios: [
          [
            "code: typeof codigo === 'string' && CODIGOS_DE_ERROR_CONOCIDOS.has(codigo) ? codigo : OTRO,",
            'code: String(codigo),',
          ],
        ],
      },
    ],
    prueba: METRICAS_BFF_PRUEBA,
    filtro: 'mil códigos inventados',
  },
];

const filtroNombre = process.argv[2];
const elegidas = MUTACIONES.filter((m) => !filtroNombre || m.nombre.includes(filtroNombre));
const resultados = [];
const originales = new Map();

function restaurar() {
  for (const [archivo, contenido] of originales) writeFileSync(archivo, contenido);
  originales.clear();
}

// Ctrl+C a mitad de una mutación: se restauran los archivos antes de salir
process.on('SIGINT', () => {
  restaurar();
  process.exit(130);
});

for (const mutacion of elegidas) {
  const mutados = [];
  let aplicable = true;
  for (const { archivo, cambios } of mutacion.archivos) {
    const original = readFileSync(archivo, 'utf8');
    if (cambios.some(([buscar]) => original.split(buscar).length !== 2)) {
      aplicable = false;
      break;
    }
    let mutado = original;
    for (const [buscar, reemplazar] of cambios) mutado = mutado.replace(buscar, () => reemplazar);
    mutados.push({ archivo, original, mutado });
  }
  if (!aplicable) {
    resultados.push({ ...mutacion, estado: 'NO APLICABLE (el texto ya no está una sola vez)' });
    continue;
  }

  try {
    for (const { archivo, original, mutado } of mutados) {
      originales.set(archivo, original);
      writeFileSync(archivo, mutado);
    }
    const corrida = spawnSync(
      'npx',
      ['jest', '--runInBand', '--forceExit', mutacion.prueba, '-t', mutacion.filtro],
      { encoding: 'utf8', timeout: 180_000 },
    );
    const salida = `${corrida.stdout}${corrida.stderr}`;
    const fallidas = salida.match(/Tests:\s+(\d+) failed/)?.[1] ?? '0';
    // Una mutación que no compila no demuestra nada: la suite no corrió ninguna prueba
    const sinCorrer = /Test suite failed to run/.test(salida) || /Tests:\s+0 total/.test(salida);
    resultados.push({
      ...mutacion,
      estado: sinCorrer
        ? 'INVÁLIDA (la mutación no compila o no corrió ninguna prueba: arréglala aquí)'
        : corrida.status !== 0 && fallidas !== '0'
          ? `DETECTADA (${fallidas} prueba(s) fallan)`
          : 'SOBREVIVIÓ',
    });
  } finally {
    restaurar();
  }
}

for (const r of resultados) {
  console.log(
    `${r.estado.startsWith('DETECTADA') ? 'ok ' : 'MAL'}  ${r.nombre}\n     ${r.prueba} -t "${r.filtro}" → ${r.estado}`,
  );
}
const malas = resultados.filter((r) => !r.estado.startsWith('DETECTADA'));
console.log(`\n${resultados.length - malas.length} de ${resultados.length} mutaciones detectadas`);
process.exit(malas.length === 0 ? 0 : 1);
