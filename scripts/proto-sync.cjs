// npm run proto:sync [-- --ref <rama>]
// Trae contracts/proto/flights/v1/flights.proto de main del core. El proto no se edita a mano:
// es el contrato del core y el BFF solo lo copia.
const fs = require('node:fs');
const path = require('node:path');
const { RUTA_PROTO, DESTINO, REPO_CORE, resolverRef, bajarProto } = require('./proto-comun.cjs');

(async () => {
  const ref = resolverRef(process.argv.slice(2));
  const contenido = await bajarProto(ref);
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  const anterior = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8') : null;
  fs.writeFileSync(DESTINO, contenido);
  console.log(
    anterior === contenido
      ? `${RUTA_PROTO}: ya era igual al de ${REPO_CORE}@${ref}`
      : `${RUTA_PROTO}: actualizado desde ${REPO_CORE}@${ref}`,
  );
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
