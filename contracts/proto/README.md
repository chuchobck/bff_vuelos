# Contrato gRPC del core

`flights/v1/flights.proto` es una **copia** del proto de
[`backend_vuelos`](https://github.com/chuchobck/backend_vuelos) (`contracts/proto/flights/v1/`).
**No se edita a mano**: el dueño del contrato es el core.

| Comando               | Qué hace                                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| `npm run proto:sync`  | Trae el proto de `main` del core y sobrescribe la copia                    |
| `npm run proto:check` | Lo compara con el de `main`; sale con 1 si difieren (2 si no pudo bajarlo) |

Los dos aceptan `-- --ref <rama>` (o `CORE_PROTO_REF`) para apuntar a otra rama del core, y
`CORE_PROTO_TOKEN` si el repositorio fuera privado (no se usa `GITHUB_TOKEN`: uno ajeno al core hace que GitHub responda 404 aun siendo público). Un cambio del proto del core se trae con
`proto:sync`, se revisa el diff y va en su propio commit.

Copiado de la rama `feat/r2-grpc` del core (fase R2-1, aún sin fusionar a `main`): hasta que se
fusione, `proto:check` contra `main` responde 2 (el archivo no existe allí).
