# WPBB Server

Servidor bridge entre WhatsApp Web y la app Android WPBB. Usa [whatsapp-web.js](https://github.com/nicoh3/whatsapp-web.js) con Puppeteer/Chromium headless.

## Requisitos

- Node.js 18+
- Chromium/Chrome (lo descarga Puppeteer automaticamente, o se instala manual en Linux)
- ffmpeg (para convertir audios OGG/Opus a MP3)

## Instalacion local (Mac/Linux)

```bash
cd server
npm install
node index.js
```

El server arranca en `http://localhost:3000`.

## Instalacion en Amazon Linux (EC2)

### 1. Instalar Node.js

```bash
# Amazon Linux 2023
sudo yum install -y nodejs npm

# Amazon Linux 2 (si no tiene nodejs 18)
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

### 2. Instalar dependencias de Chromium

```bash
sudo yum install -y \
  alsa-lib atk at-spi2-atk cups-libs libdrm libXcomposite \
  libXdamage libXrandr mesa-libgbm pango nss \
  libXScrnSaver gtk3 ipa-gothic-fonts
```

### 3. Instalar ffmpeg (para audios)

```bash
# Amazon Linux 2023
sudo yum install -y ffmpeg

# Amazon Linux 2
sudo amazon-linux-extras install epel -y
sudo yum install -y ffmpeg
```

### 4. Subir el server desde tu Mac

```bash
rsync -avz --exclude node_modules --exclude .wwebjs_auth --exclude .tmp \
  -e "ssh -i wp.pem" \
  ./server/ \
  ec2-user@TU_IP:~/server/
```

### 5. Instalar dependencias en el EC2

```bash
ssh -i wp.pem ec2-user@TU_IP
cd ~/server
npm install
```

### 6. Correr el server

```bash
# Modo simple (se cierra al salir de SSH)
node index.js

# Modo background (sobrevive al cerrar SSH)
nohup node index.js > server.log 2>&1 &

# Ver logs
tail -f server.log
```

### 7. (Recomendado) Configurar como servicio systemd

```bash
sudo tee /etc/systemd/system/wpbb.service << 'EOF'
[Unit]
Description=WPBB WhatsApp Server
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/server
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable wpbb
sudo systemctl start wpbb
```

Comandos utiles:

```bash
sudo systemctl status wpbb     # Ver estado
sudo systemctl restart wpbb    # Reiniciar
sudo systemctl stop wpbb       # Parar
sudo journalctl -u wpbb -f     # Ver logs en vivo
```

## Uso con ngrok (opcional)

Si necesitas acceso HTTPS desde fuera de la red local:

1. Crear cuenta en [ngrok.com](https://ngrok.com) y obtener un authtoken
2. Configurar el token:
   ```bash
   export NGROK_AUTHTOKEN=tu_token_aqui
   ```
3. Correr con ngrok:
   ```bash
   node index.js --ngrok
   ```

## API Endpoints

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/` | Health check y estado |
| GET | `/api/status` | Estado de WhatsApp (initializing/qr_needed/ready/disconnected) |
| GET | `/api/qr` | Obtener QR code para autenticar |
| GET | `/api/chats?limit=20` | Lista de chats |
| GET | `/api/chats/:id/messages?limit=50` | Mensajes de un chat |
| POST | `/api/chats/:id/messages` | Enviar mensaje `{ "body": "texto" }` |
| POST | `/api/chats/:id/messages/media` | Enviar media `{ "data": "base64", "mimetype": "...", "filename": "..." }` |
| POST | `/api/chats/:id/messages/:msgId/react` | Reaccionar `{ "emoji": "..." }` |
| POST | `/api/chats/:id/read` | Marcar chat como leido |
| GET | `/api/chats/:id/profile-pic` | Foto de perfil del chat |
| GET | `/api/media/:id` | Descargar media (convierte audio a MP3) |
| GET | `/api/contacts/search?q=nombre` | Buscar contactos |
| GET | `/api/tunnel` | URL publica (ngrok) |

## WebSocket

Conectar a `ws://TU_IP:3000`. Eventos:

- `new_message` - Mensaje nuevo
- `message_ack` - Cambio de estado de entrega (enviado/recibido/leido)
- `status_change` - Cambio de estado de WhatsApp
- `reaction` - Reaccion a un mensaje

## Notas

- La sesion de WhatsApp se guarda en `.wwebjs_auth/`. Si se borra, hay que escanear el QR de nuevo.
- Los audios se convierten automaticamente de OGG/Opus a MP3 para compatibilidad con Android 4.3+.
- El servidor se reconecta automaticamente si WhatsApp Web pierde la conexion.
- Puerto por defecto: 3000. Cambiar con `PORT=8080 node index.js`.
