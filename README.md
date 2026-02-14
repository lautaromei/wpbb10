# WPBB Server

Bridge server between WhatsApp Web and the WPBB Android app. Uses [whatsapp-web.js](https://github.com/nicoh3/whatsapp-web.js) with headless Puppeteer/Chromium.

## Requirements

- Node.js 18+
- Chromium/Chrome (Puppeteer downloads it automatically, or install manually on Linux)
- ffmpeg (to convert OGG/Opus audio to MP3)

## Local Setup (Mac/Linux)

```bash
cd server
npm install
node index.js
```

Server starts at `http://localhost:3000`.

## Amazon Linux (EC2) Setup

### 1. Install Node.js

```bash
# Amazon Linux 2023
sudo yum install -y nodejs npm

# Amazon Linux 2 (if nodejs 18 is not available)
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

### 2. Install Chromium dependencies

```bash
sudo yum install -y \
  alsa-lib atk at-spi2-atk cups-libs libdrm libXcomposite \
  libXdamage libXrandr mesa-libgbm pango nss \
  libXScrnSaver gtk3 ipa-gothic-fonts
```

### 3. Install ffmpeg (for audio conversion)

```bash
# Amazon Linux 2023
sudo yum install -y ffmpeg

# Amazon Linux 2
sudo amazon-linux-extras install epel -y
sudo yum install -y ffmpeg
```

### 4. Upload the server from your Mac

```bash
rsync -avz --exclude node_modules --exclude .wwebjs_auth --exclude .tmp \
  -e "ssh -i wp.pem" \
  ./server/ \
  ec2-user@YOUR_IP:~/server/
```

### 5. Install dependencies on the EC2 instance

```bash
ssh -i wp.pem ec2-user@YOUR_IP
cd ~/server
npm install
```

### 6. Run the server

```bash
# Simple mode (stops when you close SSH)
node index.js

# Background mode (survives SSH disconnect)
nohup node index.js > server.log 2>&1 &

# View logs
tail -f server.log
```

### 7. (Recommended) Set up as a systemd service

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

Useful commands:

```bash
sudo systemctl status wpbb     # Check status
sudo systemctl restart wpbb    # Restart
sudo systemctl stop wpbb       # Stop
sudo journalctl -u wpbb -f     # View live logs
```

## Using ngrok (optional)

If you need HTTPS access from outside the local network:

1. Create an account at [ngrok.com](https://ngrok.com) and get an authtoken
2. Set the token:
   ```bash
   export NGROK_AUTHTOKEN=your_token_here
   ```
3. Run with ngrok:
   ```bash
   node index.js --ngrok
   ```

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Health check and status |
| GET | `/api/status` | WhatsApp state (initializing/qr_needed/ready/disconnected) |
| GET | `/api/qr` | Get QR code for authentication |
| GET | `/api/chats?limit=20` | List chats |
| GET | `/api/chats/:id/messages?limit=50` | Get messages from a chat |
| POST | `/api/chats/:id/messages` | Send message `{ "body": "text" }` |
| POST | `/api/chats/:id/messages/media` | Send media `{ "data": "base64", "mimetype": "...", "filename": "..." }` |
| POST | `/api/chats/:id/messages/:msgId/react` | React to message `{ "emoji": "..." }` |
| POST | `/api/chats/:id/read` | Mark chat as read |
| GET | `/api/chats/:id/profile-pic` | Get chat profile picture |
| GET | `/api/media/:id` | Download media (converts audio to MP3) |
| GET | `/api/contacts/search?q=name` | Search contacts |
| GET | `/api/tunnel` | Get public URL (ngrok) |

## WebSocket

Connect to `ws://YOUR_IP:3000`. Events:

- `new_message` - New incoming/outgoing message
- `message_ack` - Delivery status change (sent/delivered/read)
- `status_change` - WhatsApp connection state change
- `reaction` - Reaction to a message

## Notes

- The WhatsApp session is saved in `.wwebjs_auth/`. If deleted, you'll need to scan the QR code again.
- Audio messages are automatically converted from OGG/Opus to MP3 for Android 4.3+ compatibility.
- The server automatically reconnects if WhatsApp Web loses the connection.
- Default port: 3000. Change with `PORT=8080 node index.js`.
