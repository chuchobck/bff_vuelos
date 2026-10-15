// Lo que comparten proto:sync y proto:check: de dónde sale el proto del core y cómo se baja.
const path = require('node:path');

const REPO_CORE = process.env.CORE_REPO || 'chuchobck/backend_vuelos';
const RUTA_PROTO = 'contracts/proto/flights/v1/flights.proto';
const DESTINO = path.join(__dirname, '..', RUTA_PROTO);

/** La rama del core: `--ref <rama>` o CORE_PROTO_REF; por defecto, main. */
function resolverRef(argv) {
  const i = argv.indexOf('--ref');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ref necesita un valor (rama, etiqueta o commit)');
    return argv[i + 1];
  }
  return process.env.CORE_PROTO_REF || 'main';
}

/** Baja el proto de esa ref del core. CORE_PROTO_TOKEN es opcional (repo privado); GITHUB_TOKEN no se usa a propósito: uno ajeno al core da 404. */
async function bajarProto(ref) {
  const url = `https://raw.githubusercontent.com/${REPO_CORE}/${ref.split('/').map(encodeURIComponent).join('/')}/${RUTA_PROTO}`;
  const cabeceras = process.env.CORE_PROTO_TOKEN
    ? { Authorization: `Bearer ${process.env.CORE_PROTO_TOKEN}` }
    : {};
  const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(15_000) });
  if (!respuesta.ok) {
    throw new Error(
      `No se pudo bajar ${RUTA_PROTO} de ${REPO_CORE}@${ref} (HTTP ${respuesta.status}). ` +
        'Si el proto aún no está en main del core, usa --ref <rama> (p. ej. feat/r2-grpc).',
    );
  }
  return normalizar(await respuesta.text());
}

/** Compara sin que un CRLF de Windows cuente como diferencia. */
function normalizar(texto) {
  return texto.replace(/\r\n/g, '\n');
}

module.exports = { REPO_CORE, RUTA_PROTO, DESTINO, resolverRef, bajarProto, normalizar };
