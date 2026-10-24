# inventory-api

Backend del sistema de inventario. Monorepo npm (workspaces) con arquitectura hexagonal.

## Estructura

- `services/identity/` autenticacion, usuarios, roles y permisos (NestJS + Fastify, puerto 3001). Misma
  estructura hexagonal que `core`.
- `services/core/` primer servicio (NestJS + Fastify). Capas en `src/`:
  - `domain/`: reglas y puertos; sin dependencias de frameworks, `pg` ni infraestructura (lo impone ESLint).
  - `application/`: casos de uso.
  - `infrastructure/`: Nest (modulos/controladores), adaptador PostgreSQL, configuracion (zod).
- `packages/shared/`: codigo compartido entre servicios (verificacion de JWT y tipos de permisos, sin Nest).
- `migrations/`: migraciones versionadas (node-pg-migrate, archivos `.cjs`).
- `scripts/`: utilidades (`generate-keys.mjs`).

## Requisitos

Node.js 24+, npm, Docker y Docker Compose. Docker Desktop debe estar encendido antes de ejecutar
`docker compose up -d`.

## Variables de entorno

Copia el ejemplo y ajustalo: `cp .env.example .env` (`.env` no se versiona).

| Variable                                              | Descripcion                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credenciales y base de datos                                 |
| `POSTGRES_PORT`                                       | Puerto publicado en el host (cambialo si 5432 esta ocupado)  |
| `POSTGRES_HOST`                                       | Host de la BD visto desde la API (`localhost`)               |
| `API_HOST` / `API_PORT`                               | Direccion de la API y puerto de `core`                       |
| `IDENTITY_API_PORT`                                   | Puerto de identity (3001 por defecto)                        |
| `JWT_PRIVATE_KEY_PATH` o `JWT_PRIVATE_KEY`            | Clave privada ES256 (PKCS8 PEM): ruta o contenido            |
| `JWT_PUBLIC_KEY_PATH` o `JWT_PUBLIC_KEY`              | Clave publica (SPKI PEM): ruta o contenido (identity y core) |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL`              | Vigencias (`15m`, `7d`; numero + s/m/h/d)                    |
| `POSTGRES_TEST_DB`                                    | BD de pruebas de integracion (`inventory_test`)              |

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

Leen `.env` si existe; sin `.env` funcionan igual si las variables `POSTGRES_*` estan en el entorno.

Migraciones actuales (4):

| Migracion                    | Contenido                                                                              | `migrate:down` que la revierten |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `identity-tables`            | roles, permissions, role_permissions, users, refresh_tokens                            | identity: 2 en total            |
| `identity-seed`              | permisos de usuarios/roles y rol de sistema "Administrador" con todos ellos            | (ver arriba)                    |
| `establishments`             | tabla `establishments` (nombre unico sin distinguir mayusculas, checks de coordenadas) | establecimientos: 2 en total    |
| `establishments-permissions` | permisos `establishments.*` asignados al rol Administrador                             | (ver arriba)                    |

`migrate:down` revierte de una en una, en orden inverso: el modulo de establecimientos requiere 2
ejecuciones (`establishments-permissions`, luego `establishments`) y el de identity otras 2 (`identity-seed`,
luego `identity-tables`); para volver al estado vacio hacen falta 4. Revertir la semilla de identity falla si
ya hay usuarios con el rol Administrador (la FK lo impide).

## Servicio identity

### Claves de firma (JWT ES256)

```bash
npm run keys:generate        # crea keys/jwt-private.pem y keys/jwt-public.pem (git-ignorados)
```

Configura `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` en `.env` (las rutas son relativas al directorio del
servicio, por eso el ejemplo usa `../../keys/...`). Se niega a sobrescribir claves existentes (usa
`--force`). **Si se pierde o cambia la clave privada, todas las sesiones activas quedan invalidas.** Los demas
servicios solo necesitan la clave publica.

### Primer administrador

```bash
ADMIN_EMAIL=admin@tu-negocio.com ADMIN_PASSWORD='<clave>' npm run identity:create-admin
```

Opcional `ADMIN_FULL_NAME`. Falla con mensaje si ya existe un administrador. Pasa las variables en la linea de
comandos: no las dejes guardadas en `.env`. Requiere las migraciones aplicadas y `npm run build`.

### Arranque

```bash
npm run build
npm run start:identity       # http://localhost:3001
```

### Endpoints

Todos exigen `Authorization: Bearer <accessToken>` salvo los publicos. Errores en JSON uniforme:
`{ statusCode, error, code?, message, details? }`.

| Metodo y ruta                                                                | Permiso            |
| ---------------------------------------------------------------------------- | ------------------ |
| `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /health` | publico            |
| `GET /auth/me`, `POST /auth/change-password`                                 | autenticado        |
| `GET /users`, `GET /users/:id`                                               | `users.read`       |
| `POST /users`                                                                | `users.create`     |
| `PATCH /users/:id`, `POST /users/:id/reset-password`                         | `users.update`     |
| `PATCH /users/:id/status` (`{"isActive": bool}`)                             | `users.deactivate` |
| `GET /roles`, `GET /roles/:id`, `GET /permissions`                           | `roles.read`       |
| `POST /roles`                                                                | `roles.create`     |
| `PATCH /roles/:id`, `PUT /roles/:id/permissions`                             | `roles.update`     |
| `DELETE /roles/:id`                                                          | `roles.delete`     |

Contrasena: minimo 8 caracteres (maximo 128), al menos una letra y un numero. El access token dura 15 min;
el refresh token es opaco, dura 7 dias y rota en cada uso (reutilizar uno ya usado cierra todas las sesiones
del usuario). Desactivar a un usuario o cambiar/restablecer su contrasena revoca sus refresh tokens.

### Proteger endpoints (en identity o servicios futuros)

`packages/shared` expone `verifyAccessToken(token, publicKeyPem)` y `hasAllPermissions`. En identity, el guard
global exige autenticacion por defecto; `@Public()` la omite y `@RequirePermissions('modulo.accion')` exige
permisos. El guard consulta la BD en cada peticion (usuario activo y permisos vigentes de su rol).
Los modulos nuevos agregan sus permisos por migracion (y los asignan al rol Administrador).

## Core: establecimientos (sedes)

`core` (puerto 3000) exige `JWT_PUBLIC_KEY_PATH` o `JWT_PUBLIC_KEY` (solo la clave publica: no puede emitir
tokens); sin ella no arranca. Verifica el JWT con `@inventory/shared` y lee en vivo, **solo lectura**, el
estado del usuario y los permisos de su rol en las tablas de identity (ADR-0001, `USER_ACCESS_QUERY` y
`assertAccess` de shared): un cambio de rol o una desactivacion aplica en la siguiente peticion.

| Metodo y ruta                                                                  | Permiso                     |
| ------------------------------------------------------------------------------ | --------------------------- |
| `GET /health`                                                                  | publico                     |
| `POST /establishments`                                                         | `establishments.create`     |
| `GET /establishments` (`status=active\|inactive\|all`, `q`, `limit`, `offset`) | `establishments.read`       |
| `GET /establishments/:id`                                                      | `establishments.read`       |
| `PATCH /establishments/:id` (cualquier subconjunto; `phone: null` borra)       | `establishments.update`     |
| `PATCH /establishments/:id/status` (`{"isActive": bool}`)                      | `establishments.deactivate` |

Campos: `name` (max 150, unico sin distinguir mayusculas), `address` (255), `city` (100), `department` (100),
`phone` (opcional, max 30, solo `0-9 + - ( )` y espacio), `latitude` [-90, 90] y `longitude` [-180, 180] como
numeros JSON (6 decimales). Toda respuesta incluye `mapsUrl` (enlace de Google Maps). No hay borrado:
las sedes se desactivan. Errores: 400 `VALIDATION_ERROR`, 401, 403, 404, 409 `ESTABLISHMENT_NAME_TAKEN`.

## Calidad

```bash
npm run build
npm run lint
npm test
```

`npm test` incluye pruebas de integracion HTTP de identity contra PostgreSQL: usan una BD **separada**
(`inventory_test`), que debe existir en el mismo contenedor y se migra sola al iniciar:

```bash
docker exec inventory-postgres psql -U inventory -d inventory -c "CREATE DATABASE inventory_test"
```

Esas pruebas borran los datos de usuarios/roles de esa BD de pruebas (nunca de la de desarrollo; el nombre
debe terminar en `_test`).

## Base de datos

`docker compose stop postgres` detiene; `docker compose down` elimina el contenedor pero conserva el
volumen. No uses `down -v` salvo que quieras borrar los datos.
