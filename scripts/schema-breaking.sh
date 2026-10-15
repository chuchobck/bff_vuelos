#!/usr/bin/env bash
# npm run schema:breaking [-- <ref>]
#
# Compara src/graphql/schema.graphql con el de la rama base (por defecto origin/main) con
# @graphql-inspector/cli: sale con 1 si hay un cambio que rompe a los clientes (quitar o renombrar
# un campo, tipo o valor de enum; hacer obligatorio un argumento; volver nulo un campo que no lo
# era...). Es el equivalente a `buf breaking` del proto del core. En GraphQL no se versiona la URL:
# se agrega y lo que sobra se marca @deprecated.
#
# En CI el clon no trae main: `git fetch --no-tags --depth=1 origin main` y
# `npm run schema:breaking -- FETCH_HEAD`.
set -euo pipefail

REF="${1:-origin/main}"
ESQUEMA="src/graphql/schema.graphql"

cd "$(dirname "$0")/.."

if ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  echo "No existe la referencia '$REF'. Trae la rama base: git fetch origin main" >&2
  exit 2
fi

if ! git cat-file -e "$REF:$ESQUEMA" 2>/dev/null; then
  echo "$ESQUEMA no existe en $REF: es la primera versión del esquema, no hay con qué compararlo."
  exit 0
fi

ANTERIOR="$(mktemp -d)/anterior.graphql"
trap 'rm -rf "$(dirname "$ANTERIOR")"' EXIT
git show "$REF:$ESQUEMA" > "$ANTERIOR"

echo "Comparando $ESQUEMA con el de $REF"
# diff sale con 1 si encuentra cambios que rompen; los cambios compatibles solo se listan
npx --no-install graphql-inspector diff "$ANTERIOR" "$ESQUEMA"
