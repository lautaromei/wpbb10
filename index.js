const express = require('express');
const http = require('http');
const WhatsAppManager = require('./whatsapp');
const WsManager = require('./ws');
const authRoutes = require('./routes/auth');
const chatsRoutes = require('./routes/chats');
const contactsRoutes = require('./routes/contacts');

const PORT = process.env.PORT || 3000;
const USE_NGROK = process.argv.includes('--ngrok') || process.env.USE_NGROK === 'true';

// Store the public URL (ngrok or local)
let publicUrl = null;

async function main() {
    const app = express();
    const server = http.createServer(app);

    // Increase body size limit for media uploads (50MB)
    app.use(express.json({ limit: '50mb' }));

    // CORS for Android client
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    // Initialize WhatsApp
    const waManager = new WhatsAppManager();
    const wsManager = new WsManager();

    // Attach WebSocket to HTTP server
    wsManager.attach(server);

    // Wire WhatsApp events to WebSocket broadcasts
    waManager.onMessageCallback = async (message, fromMe) => {
        const chatId = fromMe ? message.to : message.from;

        // Resolve author JID to contact name for group messages
        let authorName = message.author || null;
        if (authorName) {
            try {
                authorName = await waManager.resolveAuthorName(message.author);
            } catch (e) {
                authorName = message.author ? message.author.split('@')[0] : null;
            }
        }

        wsManager.broadcastNewMessage({
            id: message.id._serialized,
            chatId: chatId,
            body: message.body || '',
            from: message.from,
            to: message.to,
            timestamp: message.timestamp,
            fromMe: message.fromMe,
            ack: message.ack,
            type: message.type || 'chat',
            author: authorName,
            hasMedia: message.hasMedia || false
        });
    };

    waManager.onMessageAckCallback = (message, ack) => {
        const chatId = message.fromMe ? message.to : message.from;
        wsManager.broadcastMessageAck(message.id._serialized, chatId, ack);
    };

    waManager.onReactionCallback = (reaction) => {
        try {
            wsManager.broadcastReaction({
                messageId: reaction.msgId._serialized,
                emoji: reaction.reaction,
                senderId: reaction.senderId,
                timestamp: reaction.timestamp
            });
        } catch (e) {
            console.error('[Server] Error broadcasting reaction:', e.message);
        }
    };

    waManager.onStatusChangeCallback = (state) => {
        wsManager.broadcastStatus(state);
    };

    // Routes
    app.use('/api', authRoutes(waManager));
    app.use('/api/chats', chatsRoutes(waManager));
    app.use('/api/contacts', contactsRoutes(waManager));

    // Media endpoint - serve cached media (converts audio to MP3 for Android 4.3 compat)
    app.get('/api/media/:id', async (req, res) => {
        const messageId = decodeURIComponent(req.params.id);
        const media = waManager.getMediaFromCache(messageId);
        if (!media) {
            return res.status(404).json({ error: 'Media not found' });
        }

        const isAudio = media.mimetype && (
            media.mimetype.includes('ogg') || media.mimetype.includes('opus') ||
            media.mimetype.startsWith('audio/')
        );

        // Convert audio to MP3 for API 18 compatibility (no OGG Opus support)
        if (isAudio) {
            // Check if we already have an MP3 version cached
            const mp3Key = messageId + '_mp3';
            const cachedMp3 = waManager.getMediaFromCache(mp3Key);
            if (cachedMp3) {
                const buffer = Buffer.from(cachedMp3.data, 'base64');
                res.set('Content-Type', 'audio/mpeg');
                res.set('Content-Length', buffer.length);
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(buffer);
            }

            try {
                const { execSync } = require('child_process');
                const fs = require('fs');
                const path = require('path');
                const tmpDir = path.join(__dirname, '.tmp');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

                const ts = Date.now();
                const inputPath = path.join(tmpDir, `media_in_${ts}`);
                const outputPath = path.join(tmpDir, `media_out_${ts}.mp3`);

                fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));
                execSync(`ffmpeg -i "${inputPath}" -c:a libmp3lame -b:a 128k -y "${outputPath}" 2>/dev/null`);

                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                    const mp3Data = fs.readFileSync(outputPath);
                    // Cache the MP3 version
                    waManager.mediaCache.set(mp3Key, {
                        data: mp3Data.toString('base64'),
                        mimetype: 'audio/mpeg'
                    });
                    res.set('Content-Type', 'audio/mpeg');
                    res.set('Content-Length', mp3Data.length);
                    res.set('Cache-Control', 'public, max-age=86400');
                    try { fs.unlinkSync(inputPath); } catch(e) {}
                    try { fs.unlinkSync(outputPath); } catch(e) {}
                    return res.send(mp3Data);
                }

                try { fs.unlinkSync(inputPath); } catch(e) {}
                try { fs.unlinkSync(outputPath); } catch(e) {}
            } catch (convErr) {
                console.error('[Server] ffmpeg audio conversion error:', convErr.message);
            }
        }

        // Fallback: serve original media
        const buffer = Buffer.from(media.data, 'base64');
        res.set('Content-Type', media.mimetype);
        res.set('Content-Length', buffer.length);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    });

    // Ngrok/tunnel URL endpoint - returns the public URL for the Android app
    app.get('/api/tunnel', (req, res) => {
        res.json({ url: publicUrl });
    });

    // Health check
    app.get('/', (req, res) => {
        res.json({
            name: 'WPBB Server',
            state: waManager.getState(),
            publicUrl: publicUrl
        });
    });

    // Start server
    server.listen(PORT, '0.0.0.0', async () => {
        console.log(`[Server] Listening on port ${PORT}`);
        publicUrl = `http://0.0.0.0:${PORT}`;

        // Start ngrok tunnel if requested
        if (USE_NGROK) {
            try {
                const ngrok = require('@ngrok/ngrok');
                const listener = await ngrok.forward({
                    addr: PORT,
                    authtoken_from_env: true
                });
                publicUrl = listener.url();
                console.log(`\n${'='.repeat(60)}`);
                console.log(`  NGROK TUNNEL ACTIVO`);
                console.log(`  URL: ${publicUrl}`);
                console.log(`  Usa esta URL en la app Android`);
                console.log(`${'='.repeat(60)}\n`);
            } catch (err) {
                console.error('[Server] Error starting ngrok:', err.message);
                console.log('[Server] Tip: Set NGROK_AUTHTOKEN env variable or run:');
                console.log('  npx ngrok config add-authtoken <tu-token>');
                console.log('  Get token at: https://dashboard.ngrok.com/get-started/your-authtoken');
                console.log('[Server] Continuing without ngrok...');
            }
        }
    });

    // Initialize WhatsApp client
    try {
        await waManager.initialize();
    } catch (err) {
        console.error('[Server] Failed to initialize WhatsApp:', err);
    }
}

main().catch(console.error);
