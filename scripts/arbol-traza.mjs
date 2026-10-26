#!/usr/bin/env node
// Imprime el árbol de spans de una traza a partir del archivo que escribe el recolector OTLP falso
// del gateway (scripts/e2e/recolector-otlp.mjs, RECOLECTOR_ARCHIVO): un span por línea en JSON.
//
//   node scripts/arbol-traza.mjs spans.jsonl <trace-id>      (el trace-id es el X-Trace-Id de la respuesta)
import { readFileSync } from 'node:fs';
const [archivo, traza] = process.argv.slice(2);
const spans = readFileSync(archivo, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((s) => s.traceId === traza);
const tipos = { 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT' };
const hijos = (id) => spans.filter((s) => s.parentSpanId === id);
const ids = new Set(spans.map((s) => s.spanId));
const raices = spans.filter((s) => !ids.has(s.parentSpanId));
const imprimir = (s, prof) => {
  const a = Object.entries(s.atributos)
    .filter(([k]) => !['quinde.request_id'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(
    `${'   '.repeat(prof)}${prof ? '└─ ' : ''}[${s.recurso['service.name']}] ${tipos[s.tipo]} "${s.nombre}"  span=${s.spanId.slice(0, 8)} parent=${(s.parentSpanId || '-').slice(0, 8)}${s.estado.code === 2 ? ' ERROR' : ''}\n${'   '.repeat(prof)}${prof ? '   ' : ''}     ${a}`,
  );
  hijos(s.spanId)
    .sort((x, y) => x.nombre.localeCompare(y.nombre))
    .forEach((h) => imprimir(h, prof + 1));
};
console.log(
  `trace-id ${traza}: ${spans.length} spans, ${new Set(spans.map((s) => s.traceId)).size} traza(s)`,
);
raices.forEach((r) => imprimir(r, 0));
