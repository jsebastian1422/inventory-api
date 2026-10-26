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
| `CORS_ORIGINS`                                        | Origenes permitidos (core e identity), separados por comas   |
| `POSTGRES_TEST_DB`                                    | BD de pruebas de integracion (`inventory_test`)              |

Las credenciales de `.env.example` (`change_me`) son solo de ejemplo: cambialas en tu `.env`.
Los puertos deben estar entre 1 y 65535.

`CORS_ORIGINS` es opcional: lista de origenes exactos (`http://localhost:5173,https://app.example.com`),
sin ruta ni `/` final. Vacia o ausente = sin CORS. Un origen mal formado hace fallar el arranque indicando
la variable. Se permiten los metodos `GET, POST, PUT, PATCH, DELETE, OPTIONS` y las cabeceras
`Authorization, Content-Type, Idempotency-Key, If-Match` (sin cookies ni comodin).

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

Migraciones actuales (11):

| Migracion                       | Contenido                                                                                | `migrate:down` que la revierten |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| `identity-tables`               | roles, permissions, role_permissions, users, refresh_tokens                              | identity: 2 en total            |
| `identity-seed`                 | permisos de usuarios/roles y rol de sistema "Administrador" con todos ellos              | (ver arriba)                    |
| `establishments`                | tabla `establishments` (nombre unico sin distinguir mayusculas, checks de coordenadas)   | establecimientos: 2 en total    |
| `establishments-permissions`    | permisos `establishments.*` asignados al rol Administrador                               | (ver arriba)                    |
| `establishments-sync`           | columnas `version` y `change_xid` e indice del feed de cambios en `establishments`       | sincronizacion: 2 en total      |
| `idempotency-keys`              | tabla `idempotency_keys` (claves de idempotencia por usuario)                            | (ver arriba)                    |
| `catalog`                       | tablas `categories`, `products` y `product_price_history`                                | catalogo: 3 en total            |
| `inventories`                   | tablas `inventories`, `inventory_lines` e `inventory_line_history`                       | (ver arriba)                    |
| `catalog-inventory-permissions` | 12 permisos `categories.*`, `products.*` e `inventories.*` asignados al Administrador    | (ver arriba)                    |
| `establishment-users`           | tabla `establishment_users` (asignaciones usuario-local con retiro logico)               | alcance por local: 2 en total   |
| `scope-permissions`             | permisos `establishments.assign`, `establishments.all` y `stock.search` al Administrador | (ver arriba)                    |

`migrate:down` revierte de una en una, en orden inverso. Cuantas hacen falta por modulo: sincronizacion 2
(`idempotency-keys`, luego `establishments-sync`), establecimientos 2 (`establishments-permissions`, luego
`establishments`) e identity 2 (`identity-seed`, luego `identity-tables`); el catalogo y los inventarios 3 (`catalog-inventory-permissions`, `inventories`, luego `catalog`); el alcance por local 2 (`scope-permissions`, luego `establishment-users`); para volver a
la BD vacia hacen falta 11. Revertir la semilla de identity falla si ya hay usuarios con el rol Administrador (la FK lo impide).

Las migraciones cuyo `down` contiene `DROP` (todas las que eliminan tablas, columnas o indices) las aplica
una persona, no los agentes: el hook de politica del proyecto bloquea esos comandos.

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
| `GET /establishments/changes` (`cursor`, `limit` 1-500, def. 100)              | `establishments.read`       |

Campos: `name` (max 150, unico sin distinguir mayusculas), `address` (255), `city` (100), `department` (100),
`phone` (opcional, max 30, solo `0-9 + - ( )` y espacio), `latitude` [-90, 90] y `longitude` [-180, 180] como
numeros JSON (6 decimales). Toda respuesta incluye `mapsUrl` (enlace de Google Maps). No hay borrado:
las sedes se desactivan. Errores: 400 `VALIDATION_ERROR`, 401, 403, 404, 409 `ESTABLISHMENT_NAME_TAKEN`. Con el protocolo de sincronizacion tambien: 409 `VERSION_CONFLICT`,
`ESTABLISHMENT_ID_TAKEN`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_IN_PROGRESS` (ver la seccion siguiente).

### Sincronizacion offline (ADR-0002) para el frontend

Aplica a Establecimientos en core; las piezas son genericas para modulos futuros. Todo es opcional: un
cliente que no envia `Idempotency-Key`, `If-Match` ni `id` se comporta como antes (la respuesta solo suma
`version`).

- **Id del cliente**: `POST /establishments` acepta `id` (UUID) para referenciar la sede creada offline.
  Un id ya usado responde 409 `ESTABLISHMENT_ID_TAKEN`; mal formado, 400.
- **`Idempotency-Key: <uuid>`** en `POST /establishments`, `PATCH /establishments/:id` y
  `PATCH /establishments/:id/status`. Un reenvio con la misma clave y el mismo contenido (metodo, ruta,
  cuerpo e `If-Match` normalizado a la version entera: `"3"` y `3` son lo mismo) devuelve el mismo status y cuerpo sin reaplicar (log `idempotency.replayed`).
  Misma clave con otro contenido: 409 `IDEMPOTENCY_KEY_REUSED`; peticion simultanea en curso: 409
  `IDEMPOTENCY_IN_PROGRESS` (reintentar). La clave es por usuario, dura 30 dias y solo se guardan
  respuestas 2xx: un 400/403/404/409 libera la clave y el reintento se evalua de nuevo. Genera una clave
  por operacion encolada y reutilizala en cada reintento.
- **`version` + `If-Match: "<version>"`** en los dos PATCH. `version` empieza en 1 y sube 1 con cada
  edicion o cambio de estado efectivo. Si `If-Match` no coincide: 409 `VERSION_CONFLICT` con
  `current` (la sede del servidor, el servidor gana; la PWA decide que mostrar al usuario). Sin `If-Match`
  gana la ultima escritura. `If-Match` mal formado o `*`: 400. Orden de errores al editar: 400, 404,
  `VERSION_CONFLICT`, `ESTABLISHMENT_NAME_TAKEN`.
- **Feed de cambios** `GET /establishments/changes?cursor=&limit=`: devuelve
  `{ items, nextCursor, hasMore }` con todas las sedes (activas e inactivas) creadas o modificadas despues
  del cursor. Sin cursor, desde el principio. Guarda el `nextCursor` (opaco) y usalo en la siguiente
  consulta; no pierde cambios de transacciones concurrentes (una transaccion larga solo retrasa el feed).
  Si no hay cambios devuelve `items` vacio y el mismo cursor (`null` si aun no habia cursor). Cursor
  invalido o `limit` fuera de 1-500: 400.
- Al sincronizar se aplican las validaciones, la unicidad de nombre y los permisos **vigentes**: permiso
  retirado, 403 y no se crea nada; nombre ocupado, 409 `ESTABLISHMENT_NAME_TAKEN`.
- **identity solo en linea**: login, refresh, logout, sesiones, usuarios, roles y permisos **no deben
  encolarse offline**. identity no adopta el protocolo (ignora `Idempotency-Key` e `If-Match`); solo
  habilita CORS con `CORS_ORIGINS`.

## Core: categorias, productos e inventarios

Mismos permisos en vivo (ADR-0001) y mismo protocolo offline (ADR-0002) que Establecimientos. Todos los
listados aceptan `limit` 1-200 (def. 50), `offset` y `status=active|inactive|all` (def. `all`) y responden
`{ items, total, limit, offset }`; los feeds responden `{ items, nextCursor, hasMore }`. No hay borrado fisico:
todo se activa/desactiva con `PATCH /<recurso>/:id/status` (`{"isActive": bool}`).

| Metodo y ruta                                                                  | Permiso                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `POST/GET /categories`, `GET /categories/changes`, `GET/PATCH /categories/:id` | `categories.create` / `read` / `read` / `read` / `update`        |
| `PATCH /categories/:id/status`                                                 | `categories.deactivate`                                          |
| `POST/GET /products` (`q`, `categoryId`), `GET /products/changes`              | `products.create` / `read`                                       |
| `GET/PATCH /products/:id`, `PATCH /products/:id/status`                        | `products.read` / `update` / `deactivate`                        |
| `GET /products/:id/price-history`                                              | `products.read`                                                  |
| `POST/GET /inventories` (`establishmentId`, `q`), `GET /inventories/changes`   | `inventories.create` / `read`                                    |
| `GET/PATCH /inventories/:id`, `PATCH /inventories/:id/status`                  | `inventories.read` / `update` / `deactivate`                     |
| `POST /inventories/:id/lines`, `GET /inventories/:id/lines`                    | `inventories.update` / `read` (`productId`, `barcode`, `status`) |
| `GET /inventory-lines/changes`, `GET /inventory-lines/:id`                     | `inventories.read`                                               |
| `PATCH /inventory-lines/:id`, `PATCH /inventory-lines/:id/status`              | `inventories.update` / `deactivate`                              |
| `GET /inventory-lines/:id/history`                                             | `inventories.read`                                               |

Campos:

- Categoria: `code` (max 30, `A-Z 0-9 -`, se guarda en mayusculas, unico), `name` (100, unico sin distinguir
  mayusculas), `description` (opcional, 500).
- Producto: `sku` (50, en mayusculas, unico sin distinguir mayusculas), `name` (150), `description` (1000),
  `brand` (100), `unit` (`unit`, `meter`, `kilogram`, `liter`, `box`, `package`), `categoryId` (activa) y
  `price`.
- Inventario: `establishmentId` (activo), `name` (150), `startDate`/`endDate` (`YYYY-MM-DD`, final >= inicial,
  se permiten periodos superpuestos), `origin` (255), `notes` (opcional, 1000).
- Linea: `productId` (activo, fijo al crear), `barcode` (64), `expiresOn` (opcional), `quantityInitial`,
  `quantityAlert` y `quantityCurrent` (calculada; enviarla es 400). Unico por inventario:
  `barcode` + `expiresOn` (el vencimiento nulo cuenta como un valor).

**Decimales (ADR-0003)**: `price` (maximo 12 enteros y 2 decimales) y las cantidades (11 enteros y 3 decimales)
viajan como **texto** (`"12500.00"`, `"10.500"`); se rechazan numeros JSON, negativos, exponentes y separadores
de miles. La respuesta siempre trae la escala fija. En el cliente no los conviertas a `number` al calcular.

**Cantidades**: al crear, `quantityCurrent = quantityInitial`. Editar `quantityInitial` mueve la actual en la
misma diferencia; si quedaria negativa, 409 `QUANTITY_BELOW_ZERO` y no cambia nada.

**Historicos** (solo lectura, mas reciente primero, `limit`/`offset`, sin feed): precios en
`GET /products/:id/price-history` (`oldPrice` null en el precio inicial, `newPrice`, `actorId`, `changedAt`) y
cantidades en `GET /inventory-lines/:id/history` (`reason` `created` o `initial_adjusted`, `initialBefore/After`,
`currentBefore/After`, `delta`, `actorId`, `changedAt`). Se escriben en la misma transaccion que el cambio.

**Dependencias activas (409)**: `CATEGORY_HAS_ACTIVE_PRODUCTS` (desactivar categoria con productos activos),
`PRODUCT_IN_ACTIVE_INVENTORY` (desactivar producto en una linea activa de un inventario activo),
`CATEGORY_INACTIVE`, `PRODUCT_INACTIVE`, `INVENTORY_INACTIVE` y `ESTABLISHMENT_INACTIVE` (crear, editar o activar
con un padre inactivo; desactivar una linea siempre se permite). Referencia inexistente: 404.

Activar un inventario (`PATCH /inventories/:id/status` con `isActive: true`) se bloquea con 409 si su establecimiento
esta inactivo (`ESTABLISHMENT_INACTIVE`) y, despues, si tiene lineas activas con productos inactivos
(`INVENTORY_HAS_INACTIVE_PRODUCTS`; `details` lista `{lineId, productId}`). No cambia nada: reactiva el establecimiento
o los productos, o desactiva esas lineas, y reintenta.

Otros 409: `CATEGORY_CODE_TAKEN`, `CATEGORY_NAME_TAKEN`, `PRODUCT_SKU_TAKEN`, `INVENTORY_LINE_DUPLICATE`,
`CATEGORY_ID_TAKEN`, `PRODUCT_ID_TAKEN`, `INVENTORY_ID_TAKEN`, `INVENTORY_LINE_ID_TAKEN` y `VERSION_CONFLICT`.
Orden de errores al editar: 400, 404, `VERSION_CONFLICT`, reglas de negocio, unicidad (en `PATCH /inventories/:id`, el
400 por orden de fechas cuando solo llega una de ellas se evalua contra la fecha guardada, por eso va despues del 404 y
del `VERSION_CONFLICT`). Los POST y PATCH aceptan
`Idempotency-Key`, los PATCH `If-Match` y los POST un `id` de cliente, como en Establecimientos.

## Core: usuarios por local y busqueda de existencias (ADR-0004)

Las asignaciones usuario-local viven en core (`establishment_users`, retiro logico, sin FK a `users`). Son
administracion: **solo en linea**, sin `Idempotency-Key` ni `If-Match`. El **alcance** de un usuario se calcula en
vivo en cada peticion: con `establishments.all`, todos los locales activos (`access: "all"`); sin el, solo los
locales activos donde tiene una asignacion vigente (`access: "assigned"`). Desactivar un usuario o un local conserva
las asignaciones pero no dan acceso mientras esten inactivos. Los permisos y endpoints de gestion (inventarios,
productos, ...) siguen siendo globales: el alcance solo limita la busqueda y los feeds `/stock/...`.

Permisos nuevos (en `GET /permissions` de identity; el Administrador los tiene): `establishments.assign`
("Asignar y retirar usuarios de locales"), `establishments.all` ("Acceso a todos los locales") y `stock.search`
("Buscar existencias en sus locales").

| Metodo y ruta                                               | Permiso                  | Respuesta                                                    |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `PUT /establishments/:id/users/:userId`                     | `establishments.assign`  | 201 asignada / 200 ya estaba asignada (misma asignacion)     |
| `DELETE /establishments/:id/users/:userId`                  | `establishments.assign`  | 204                                                          |
| `GET /establishments/:id/users` (`includeRemoved`)          | `establishments.assign`  | `{ items, total, limit, offset }`; solo vigentes por defecto |
| `GET /establishment-assignments?userId=` (`includeRemoved`) | `establishments.assign`  | igual, los locales de un usuario                             |
| `GET /me/establishments`                                    | solo autenticado         | `{ items: [ {...establecimiento, access} ] }`                |
| `GET /stock/search`                                         | `stock.search` + alcance | `{ items, total, limit, offset }`                            |
| `GET /stock/inventories/changes`, `/stock/lines/changes`    | `stock.search`           | feed ADR-0002 con alcance                                    |
| `GET /stock/products/changes`                               | `stock.search`           | feed ADR-0002 (catalogo completo, es global)                 |

Asignacion: `{ id, establishmentId, user: { id, fullName, email, isActive }, assignedBy, assignedAt, removedBy,
removedAt }`. Listados: `limit` 1-200 (def. 50), `offset`, `includeRemoved=true|false`, mas recientes primero.
Reglas: solo usuarios y locales **activos** (409 `USER_INACTIVE` / `ESTABLISHMENT_INACTIVE`); repetir una asignacion
vigente no duplica; retirar no borra (queda quien y cuando) y se puede volver a asignar; nadie se asigna ni se retira
a si mismo (403 `SELF_ASSIGNMENT`); retirar sin asignacion vigente, 404. Orden de errores al asignar: 400, local
(404, 409), usuario (404, 409), propio usuario (403). Auditoria: `establishment.user_assigned` y
`establishment.user_removed` (`establishmentId`, `userId`, `actorId`); las busquedas no se auditan.

**Busqueda** `GET /stock/search?establishmentId=<uuid>&barcode=<texto>` **o** `&q=<texto>` (exactamente uno, si no
400): `barcode` es igualdad exacta (max 64); `q` busca sin distinguir mayusculas en nombre o SKU del producto (1-100
tras recortar; `%` y `_` son literales). Recorre todos los inventarios **activos** del local (sin mirar fechas),
lineas activas y productos activos; las lineas con cantidad `"0.000"` aparecen. Orden: nombre del producto,
vencimiento (nulos al final), id de la linea; `limit` 1-100 (def. 50) y `offset`. Cada resultado:
`{ lineId, inventoryId, inventoryName, barcode, expiresOn, quantityCurrent, product: { id, sku, name, unit, price } }`
(decimales como texto, ADR-0003). Errores de alcance: local inexistente 404, inactivo 409 `ESTABLISHMENT_INACTIVE`,
fuera del alcance 403 `ESTABLISHMENT_NOT_IN_SCOPE`.

### Uso sin conexion con alcance (para el frontend)

Los tres feeds `/stock/.../changes` usan los mismos parametros y la misma respuesta del ADR-0002 (`cursor`, `limit`
1-500, `{ items, nextCursor, hasMore }`) pero **filtrados por alcance**:

- Inventarios y lineas **dentro** del alcance llegan completos (misma representacion que `/inventories/changes` y
  `/inventory-lines/changes`, sin campo extra). Los que estan **fuera** llegan solo como `{ "id": "...", "inScope": false }`:
  nunca traen otros datos. Una linea esta en el alcance si su inventario pertenece a un local del alcance.
- Los productos son el catalogo global: llegan completos, como en `/products/changes`.
- El alcance se evalua al momento de cada consulta. Contrato del cliente: (a) al conectar, consultar
  `GET /me/establishments`; (b) si su alcance cambio (local nuevo o retirado) o un inventario paso de fuera a dentro
  del alcance, **reiniciar** (sin `cursor`) los feeds `/stock/inventories/changes` y `/stock/lines/changes`, porque ni
  los inventarios ni las lineas cambian de posicion cuando cambia el alcance; (c) purgar localmente lo marcado `inScope: false` y las lineas de inventarios fuera del
  alcance o inactivos (los inventarios y lineas inactivos llegan completos con `isActive: false`).

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
