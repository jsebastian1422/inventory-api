# inventory-api

Backend del sistema de inventario. Monorepo npm (workspaces) con arquitectura hexagonal.

## Estructura

- `services/core/` primer servicio (NestJS + Fastify). Capas en `src/`:
  - `domain/`: reglas y puertos; sin dependencias de frameworks, `pg` ni infraestructura (lo impone ESLint).
  - `application/`: casos de uso.
  - `infrastructure/`: Nest (modulos/controladores), adaptador PostgreSQL, configuracion (zod).
- `packages/shared/`: codigo compartido entre servicios.
- `migrations/`: migraciones versionadas (node-pg-migrate). Aun vacia.

## Requisitos

Node.js 24+, npm, Docker y Docker Compose. Docker Desktop debe estar encendido antes de ejecutar
`docker compose up -d`.

## Variables de entorno

Copia el ejemplo y ajustalo: `cp .env.example .env` (`.env` no se versiona).

| Variable                                              | Descripcion                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credenciales y base de datos                                |
| `POSTGRES_PORT`                                       | Puerto publicado en el host (cambialo si 5432 esta ocupado) |
| `POSTGRES_HOST`                                       | Host de la BD visto desde la API (`localhost`)              |
| `API_HOST` / `API_PORT`                               | Direccion y puerto de la API                                |

Las credenciales de `.env.example` (`change_me`) son solo de ejemplo: cambialas en tu `.env`.
Los puertos deben estar entre 1 y 65535.

Si falta una variable requerida, la API termina al arrancar indicando cual.

## Arranque desde cero

```bash
cp .env.example .env
npm install
docker compose up -d          # PostgreSQL con volumen persistente (inventory_pgdata)
npm run build
npm run start:core            # API en http://localhost:3000
curl -i http://localhost:3000/health
```

Al instalar puede aparecer el aviso `npm warn install-scripts` (fsevents); es informativo y no
impide el uso.

`GET /health` responde `200` con `{"api":"up","database":"up",...}`. Con la BD caida la API sigue
viva y responde `503` con `"database":"down"`.

## Migraciones

```bash
npm run migrate:up     # aplica
npm run migrate:down   # revierte la ultima
```

Aun no hay migraciones ni tablas de negocio (solo la tabla de control `pgmigrations`).

## Calidad

```bash
npm run build
npm run lint
npm test
```

## Base de datos

`docker compose stop postgres` detiene; `docker compose down` elimina el contenedor pero conserva el
volumen. No uses `down -v` salvo que quieras borrar los datos.
