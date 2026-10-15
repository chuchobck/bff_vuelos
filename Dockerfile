# syntax=docker/dockerfile:1
# Imagen del BFF GraphQL. Render (o quien la corra) inyecta PORT; las demás variables se
# configuran en el servicio (ver .env.example y docs/DEPLOY.md). Esta imagen no lleva credenciales.
#
#   docker build -t quinde-vuelos-bff .
#   docker run --rm -p 4000:4000 -e CORE_TRANSPORT=rest \
#     -e CORE_REST_URL=https://quinde-vuelos-api.onrender.com quinde-vuelos-bff
#
# Con el gRPC interno del core: -e CORE_TRANSPORT=grpc -e CORE_GRPC_URL=<host>:50051

ARG NODE_VERSION=22

# --- 1. compilación: dependencias completas y dist/ ----------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS compilacion
WORKDIR /app

# --ignore-scripts: husky (prepare) es una dependencia de desarrollo y no hay .git en la imagen
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- 2. ejecución: solo dependencias de producción y lo compilado --------------
FROM node:${NODE_VERSION}-bookworm-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=compilacion /app/dist ./dist
# El contrato gRPC del core: el cliente lo carga al arrancar con CORE_TRANSPORT=grpc
# (src/nucleo/grpc/proto.ts lo busca en contracts/proto, a la altura de dist/)
COPY contracts/proto ./contracts/proto

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
