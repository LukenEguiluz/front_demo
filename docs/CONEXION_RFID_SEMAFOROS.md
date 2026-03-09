# Conexión RFID – Cómo recibe el front los tags y el match con semáforos

## Resumen

- Los **RFID leídos** se reciben por **SSE** y/o **WebSocket** (o, opcionalmente, por **polling REST**).
- Esos IDs se guardan en **tagCounts** (Map: tagId → { count, lastSeen }).
- Cuando **no** estás en “simulación”, **effectiveReadTags** = lista de keys de **tagCounts**.
- El **match** con las maletas es: para cada maleta se compara **effectiveReadTags** con `masterRfid` y `productRfids`; así se calculan semáforos (verde/azul/rojo/amarillo).

---

## 1. Cómo recibe el front los RFID desde la API

### 1.1 Eventos en tiempo real (SSE y WebSocket)

Al hacer **“Iniciar lectura”** en la vista Maleta/Maleta DB:

1. Se llama a **POST** `{baseUrl}/api/readers/{readerId}/start`.
2. Se abre **SSE** a:
   - `GET {baseUrl}/api/realtime/events?readerId={readerId}`
3. Se abre **WebSocket** a:
   - `ws://.../ws/events?readerId={readerId}` (misma base que la API, cambiando `http` por `ws`).

Cada **mensaje** que llegue por SSE (eventos `message`, `tag`, `detection`, `event`) o por WebSocket se trata como JSON y se pasa a **processEvent(ev.data)**. Ahí se extraen los **tag IDs** y se actualiza **tagCounts**.

### 1.2 Formato esperado del payload (para el match)

El front acepta varios formatos. Se busca el ID del tag en este orden (y equivalentes en minúscula):

- En el objeto raíz: **epc**, **tagId**, **tag_id**, **id**, **tagEPC**, **EPC**.
- En **tag** (objeto): mismo criterio.
- En **tags** (array): cada elemento puede ser string o objeto con los campos anteriores.
- En **data**: se busca recursivamente.

Ejemplos que el front puede interpretar:

```json
{ "tagId": "E28011606000000000000001" }
```

```json
{ "epc": "E28011606000000000000001" }
```

```json
{ "tags": ["E28011606000000000000001", "E28011606000000000000002"] }
```

```json
{ "tags": [ { "id": "E28011606000000000000001" }, { "epc": "E28011606000000000000002" } ] }
```

El **match** con las maletas usa solo la **lista de IDs** (strings). No importa el nombre del campo mientras el backend envíe uno de los formatos anteriores.

### 1.3 Polling REST (opcional, ya implementado)

Si la API expone **GET** `{baseUrl}/api/readers/{readerId}/tags`, el front **ya** lo usa en paralelo:

- Al hacer **“Iniciar lectura”** se abre SSE, WebSocket y además un **polling cada 2 s** a ese endpoint.
- La respuesta debe ser: `{ "tags": ["E28011606000000000000001", "E28011606000000000000002"] }`.
- Los IDs se mezclan en **tagCounts** con los que lleguen por SSE/WS. Si el gateway **solo** tiene este GET (sin SSE/WS), los semáforos se actualizan igual gracias al polling.

---

## 2. Cómo se hace el match con las maletas (semáforos)

- **effectiveReadTags** = si está en simulación → tags del cuadro de texto; si no → **todas las keys de tagCounts** (IDs recibidos por API o polling).
- Para **cada maleta**:
  - **Esperados:** `masterRfid` + `productRfids` (sin duplicados, sin vacíos).
  - **Leídos:** los que estén en **effectiveReadTags**.
- Con eso se calcula:
  - **Verde:** todos los esperados de esa maleta están en effectiveReadTags (y no hay productos marcados caducados).
  - **Azul:** falta al menos un esperado.
  - **Rojo:** algún producto de la maleta marcado como caducado.
  - **Amarillo:** hay tags leídos que no pertenecen a ninguna maleta (“extras”).

El match es por **igualdad de string** del ID (trim, sin cambios de mayúsculas). Conviene que el backend envíe el mismo formato de ID que el que se guarda en **masterRfid** y **productRfids** (por ejemplo EPC en hex).

---

## 3. Pasos para conectar tu API

1. **Configurar URL** del túnel RFID en la vista (ej. `http://rfid.leyluz.com`).
2. **O bien** enviar eventos en tiempo real:
   - SSE en `GET /api/realtime/events?readerId=...` con payloads como los de arriba.
   - O WebSocket en `/ws/events?readerId=...` con el mismo formato de mensaje.
3. **O bien** exponer **GET /api/readers/:id/tags** con `{ "tags": ["id1", "id2", ...] }` y usar el modo polling en la vista.
4. En la vista, poner **“Ocultar (usar lectura del túnel)”** para dejar de usar simulación; entonces **effectiveReadTags** = tags recibidos por API y los semáforos reflejarán la lectura real.

El front ya incluye **polling** a `GET /api/readers/:id/tags` cada 2 s mientras la lectura está activa; si ese endpoint no existe, las peticiones fallan en silencio y solo se usan SSE/WS.
