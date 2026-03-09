# Backend Maletas y Productos RFID

API REST para guardar maletas (nombre, RFID maestro) y su relación con productos (RFID, referencia, descripción, lote, caducidad).

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
cd backend
npm install
```

## Uso

```bash
npm start
```

Escucha en `http://localhost:3000`. La base SQLite se crea en `data/maletas.db` al arrancar.

## Modelo de datos

- **Maletas**: `id`, `nombre`, `master_rfid`, `parent_maleta_id`, `created_at`
- **Productos**: `id`, `rfid` (único), `referencia`, `descripcion`, `lote`, `caducidad`, `created_at`
- **Relación**: tabla `maleta_productos` (maleta_id, producto_id)

## Endpoints

- `GET/POST /api/maletas` – Listar / crear maleta
- `GET/PUT/DELETE /api/maletas/:id` – Obtener / actualizar / eliminar maleta
- `GET/POST /api/maletas/:id/productos` – Productos de una maleta
- `POST /api/maletas/:id/productos/nuevo` – Crear producto y asociarlo a la maleta
- `GET/POST /api/productos` – Listar / crear producto
- `GET/PUT/DELETE /api/productos/:id` – CRUD producto
- `GET /api/productos/by-rfid/:rfid` – Buscar producto por RFID
- `GET /api/health` – Estado del servicio

En el front (vista Maleta), configura la URL del API de maletas (ej. `http://localhost:3000`) en “Configuración API” para guardar y cargar desde este backend.
