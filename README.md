# Quinde · BFF GraphQL de Vuelos

BFF (backend for frontend) GraphQL, sin estado ni base de datos, que agrega en una consulta las tres
lecturas públicas del core de vuelos ([`backend_vuelos`](https://github.com/chuchobck/backend_vuelos)):
búsqueda de vuelos, mapa de asientos y estado de vuelo.

```text
Marketplace ──GraphQL──▶ BFF ──gRPC (o REST de respaldo)──▶ Quinde · API de Vuelos
```

> Fase R2-2 en curso: la base del proyecto está lista; el resto de la fase se documenta aquí al
> cerrarla (ver `docs/PLAN.md`).

## Arranque rápido

```bash
nvm use                 # Node >= 20.19 (.nvmrc)
npm ci
cp .env.example .env    # y completa lo que falte
npm run build
node --env-file=.env dist/main
```

Las variables están comentadas en [`.env.example`](.env.example). Si falta una obligatoria o una
es inválida, el BFF no arranca y el error nombra la variable (nunca su valor).

Las reglas del proyecto están en [`CLAUDE.md`](CLAUDE.md).
