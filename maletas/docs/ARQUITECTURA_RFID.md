# Arquitectura RFID – Leyluz

## 1. Diagrama de flujo

```
[Navegador] → rfid.leyluz.com (DNS → IP VM)
                   ↓
            [Nginx en VM]
                   ↓ (ZeroTier)
            [Gateway on-prem] 10.147.20.20:8080
                   ↓
            [Lectores RFID]
```

## 2. Configuración Nginx (VM)

Archivo en el proyecto: `nginx/rfid-gateway.conf`

```bash
# Copiar a la VM
sudo cp nginx/rfid-gateway.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/rfid-gateway.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 3. Webapp (Angular)

- **Desarrollo:** `environment.ts` → `http://localhost:8080`
- **Producción:** `environment.production.ts` → `http://rfid.leyluz.com`

La webapp usa:
- REST: `GET/POST http://rfid.leyluz.com/api/...`
- SSE: `EventSource(http://rfid.leyluz.com/api/realtime/events)`
- WebSocket (si aplica): `ws://rfid.leyluz.com/ws/events`

El usuario puede cambiar la URL base en la pantalla Lectura (se guarda en localStorage).

## 4. DNS

- Nombre: `rfid`
- Tipo: `A`
- Valor: IP pública de la VM
- Resultado: `rfid.leyluz.com` → VM
