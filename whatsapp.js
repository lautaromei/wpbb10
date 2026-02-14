const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

class WhatsAppManager {
    constructor() {
        this.client = null;
        this.qrCode = null;
        this.state = 'initializing'; // initializing, qr_needed, authenticated, ready, disconnected
        this.onMessageCallback = null;
        this.onMessageAckCallback = null;
        this.onStatusChangeCallback = null;
        this.onReactionCallback = null;
        this.mediaCache = new Map(); // messageId -> base64 data URL
        this._reconnecting = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
    }

    async initialize() {
        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        this.client.on('qr', async (qr) => {
            console.log('[WA] QR code received');
            this.state = 'qr_needed';
            try {
                this.qrCode = await QRCode.toDataURL(qr, { width: 256, margin: 1 });
            } catch (err) {
                console.error('[WA] QR generation error:', err);
            }
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }
        });

        this.client.on('authenticated', () => {
            console.log('[WA] Authenticated');
            this.state = 'authenticated';
            this.qrCode = null;
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }
        });

        this.client.on('ready', () => {
            console.log('[WA] Client is ready');
            this.state = 'ready';
            this._reconnectAttempts = 0;
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }
        });

        this.client.on('disconnected', async (reason) => {
            console.log('[WA] Disconnected:', reason);
            this.state = 'disconnected';
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }
            // Auto-reconnect on disconnect
            await this._reconnect();
        });

        this.client.on('auth_failure', async (msg) => {
            console.error('[WA] Auth failure:', msg);
            this.state = 'disconnected';
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }
        });

        this.client.on('message', (message) => {
            if (this.onMessageCallback) {
                this.onMessageCallback(message, false);
            }
        });

        this.client.on('message_create', (message) => {
            if (message.fromMe && this.onMessageCallback) {
                this.onMessageCallback(message, true);
            }
        });

        this.client.on('message_ack', (message, ack) => {
            if (this.onMessageAckCallback) {
                this.onMessageAckCallback(message, ack);
            }
        });

        this.client.on('message_reaction', (reaction) => {
            if (this.onReactionCallback) {
                this.onReactionCallback(reaction);
            }
        });

        console.log('[WA] Initializing client...');
        await this.client.initialize();
    }

    _isDetachedFrameError(err) {
        return err && (
            err.message.includes('detached Frame') ||
            err.message.includes('Execution context was destroyed') ||
            err.message.includes('Session closed') ||
            err.message.includes('Protocol error')
        );
    }

    async _reconnect() {
        if (this._reconnecting) return;
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            console.error('[WA] Max reconnect attempts reached. Manual restart required.');
            return;
        }
        this._reconnecting = true;
        this._reconnectAttempts++;
        this.state = 'disconnected';
        if (this.onStatusChangeCallback) {
            this.onStatusChangeCallback(this.state);
        }

        const delay = Math.min(5000 * this._reconnectAttempts, 30000);
        console.log(`[WA] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            // Destroy old client gracefully
            try {
                await this.client.destroy();
            } catch (e) {
                console.log('[WA] Error destroying old client (expected):', e.message);
            }

            this.state = 'initializing';
            if (this.onStatusChangeCallback) {
                this.onStatusChangeCallback(this.state);
            }

            // Re-initialize
            await this.initialize();
            this._reconnectAttempts = 0;
            console.log('[WA] Reconnected successfully');
        } catch (err) {
            console.error('[WA] Reconnect failed:', err.message);
        } finally {
            this._reconnecting = false;
        }
    }

    async getChats(limit = 20) {
        if (this.state !== 'ready') return [];
        try {
            const chats = await this.client.getChats();
            const sorted = chats
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, limit);

            const result = [];
            for (const chat of sorted) {
                const lastMsg = chat.lastMessage;
                result.push({
                    id: chat.id._serialized,
                    name: chat.name || chat.id.user,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount || 0,
                    timestamp: chat.timestamp || 0,
                    lastMessage: lastMsg ? {
                        body: lastMsg.body || '',
                        fromMe: lastMsg.fromMe || false,
                        timestamp: lastMsg.timestamp || 0,
                        type: lastMsg.type || 'chat'
                    } : null
                });
            }
            return result;
        } catch (err) {
            console.error('[WA] Error getting chats:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
            return [];
        }
    }

    async resolveAuthorName(authorJid) {
        if (!authorJid) return null;
        try {
            const contact = await this.client.getContactById(authorJid);
            if (contact) {
                return contact.pushname || contact.name || contact.shortName || authorJid.split('@')[0];
            }
        } catch (err) {
            // Fallback to phone number
        }
        return authorJid.split('@')[0];
    }

    async getMessages(chatId, limit = 50, serverBaseUrl = '') {
        if (this.state !== 'ready') return [];
        try {
            const chat = await this.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: limit });
            const isGroup = chat.isGroup;

            // Build a cache of author names for group chats
            const authorNameCache = {};

            const result = [];
            for (const msg of messages) {
                let authorName = msg.author || null;
                // Resolve author JID to name in group chats
                if (isGroup && msg.author) {
                    if (authorNameCache[msg.author]) {
                        authorName = authorNameCache[msg.author];
                    } else {
                        const resolved = await this.resolveAuthorName(msg.author);
                        authorNameCache[msg.author] = resolved;
                        authorName = resolved;
                    }
                }

                // Get reactions for this message
                let reactions = [];
                try {
                    const reactionData = await msg.getReactions();
                    if (reactionData && reactionData.length > 0) {
                        for (const r of reactionData) {
                            for (const sender of (r.senders || [])) {
                                reactions.push({
                                    emoji: r.id,
                                    senderId: sender.senderId,
                                    fromMe: sender.senderId === msg.to || sender.senderId === msg.from
                                });
                            }
                        }
                    }
                } catch (reactErr) {
                    // getReactions may not be supported in all versions
                }

                const msgData = {
                    id: msg.id._serialized,
                    chatId: chatId,
                    body: msg.body || '',
                    fromMe: msg.fromMe,
                    timestamp: msg.timestamp,
                    ack: msg.ack,
                    type: msg.type || 'chat',
                    from: msg.from,
                    to: msg.to,
                    author: authorName,
                    hasMedia: msg.hasMedia || false,
                    mediaUrl: null,
                    reactions: reactions
                };

                // If message has media, try to download and cache it
                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker' || msg.type === 'audio' || msg.type === 'ptt')) {
                    try {
                        if (this.mediaCache.has(msg.id._serialized)) {
                            msgData.mediaUrl = `${serverBaseUrl}/api/media/${encodeURIComponent(msg.id._serialized)}`;
                        } else {
                            const media = await msg.downloadMedia();
                            if (media) {
                                this.mediaCache.set(msg.id._serialized, {
                                    data: media.data,
                                    mimetype: media.mimetype
                                });
                                msgData.mediaUrl = `${serverBaseUrl}/api/media/${encodeURIComponent(msg.id._serialized)}`;
                            }
                        }
                    } catch (mediaErr) {
                        console.error('[WA] Error downloading media for message:', msg.id._serialized, mediaErr.message);
                    }
                }

                result.push(msgData);
            }
            return result;
        } catch (err) {
            console.error('[WA] Error getting messages:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
            return [];
        }
    }

    async sendMessage(chatId, body) {
        if (this.state !== 'ready') throw new Error('Client not ready');
        try {
            const msg = await this.client.sendMessage(chatId, body);
            return {
                id: msg.id._serialized,
                chatId: chatId,
                body: msg.body,
                fromMe: true,
                timestamp: msg.timestamp,
                ack: msg.ack,
                type: 'chat'
            };
        } catch (err) {
            console.error('[WA] Error sending message:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
            throw err;
        }
    }

    async sendMedia(chatId, base64Data, mimetype, caption = '') {
        if (this.state !== 'ready') throw new Error('Client not ready');
        try {
            const isAudio = mimetype.startsWith('audio/');
            let finalMime = mimetype;
            let finalData = base64Data;
            const options = {};

            if (isAudio) {
                // Try to convert to ogg opus using ffmpeg if available
                let converted = false;
                try {
                    const { execSync } = require('child_process');
                    const fs = require('fs');
                    const path = require('path');
                    const tmpDir = path.join(__dirname, '.tmp');
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

                    const inputPath = path.join(tmpDir, `in_${Date.now()}.3gp`);
                    const outputPath = path.join(tmpDir, `out_${Date.now()}.ogg`);

                    // Write input audio
                    fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));

                    // Convert with ffmpeg
                    execSync(`ffmpeg -i "${inputPath}" -c:a libopus -b:a 64k -y "${outputPath}" 2>/dev/null`);

                    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        finalData = fs.readFileSync(outputPath).toString('base64');
                        finalMime = 'audio/ogg; codecs=opus';
                        converted = true;
                        console.log('[WA] Audio converted to OGG Opus via ffmpeg');
                    }

                    // Cleanup
                    try { fs.unlinkSync(inputPath); } catch(e) {}
                    try { fs.unlinkSync(outputPath); } catch(e) {}
                } catch (convErr) {
                    console.log('[WA] ffmpeg not available, sending audio as document:', convErr.message);
                }

                if (converted) {
                    options.sendAudioAsVoice = true;
                }
                // If not converted, send as regular audio document (no sendAudioAsVoice)
            } else if (caption) {
                options.caption = caption;
            }

            const media = new MessageMedia(finalMime, finalData);
            const msg = await this.client.sendMessage(chatId, media, options);

            // Cache the sent media so it can be played back
            this.mediaCache.set(msg.id._serialized, {
                data: finalData,
                mimetype: finalMime
            });

            return {
                id: msg.id._serialized,
                chatId: chatId,
                body: caption || '',
                fromMe: true,
                timestamp: msg.timestamp,
                ack: msg.ack,
                type: msg.type || (isAudio ? 'ptt' : 'chat'),
                hasMedia: true
            };
        } catch (err) {
            console.error('[WA] Error sending media:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
            throw err;
        }
    }

    async reactMessage(messageId, emoji) {
        if (this.state !== 'ready') throw new Error('Client not ready');
        try {
            // Find the message by serialized ID across all chats
            // whatsapp-web.js doesn't have a direct getMessageById, so we need to find it
            // The messageId contains the chatId info
            const parts = messageId.split('_');
            // Format: true/false_chatId_messageId or boolean_timestamp_chatId
            let chatId = null;
            if (parts.length >= 3) {
                chatId = parts[1];
            }
            if (!chatId) throw new Error('Could not extract chatId from messageId');

            const chat = await this.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 100 });
            const msg = messages.find(m => m.id._serialized === messageId);
            if (!msg) throw new Error('Message not found');

            await msg.react(emoji);
            return { success: true };
        } catch (err) {
            console.error('[WA] Error reacting to message:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
            throw err;
        }
    }

    getMediaFromCache(messageId) {
        return this.mediaCache.get(messageId) || null;
    }

    async markAsRead(chatId) {
        if (this.state !== 'ready') return;
        try {
            const chat = await this.client.getChatById(chatId);
            await chat.sendSeen();
        } catch (err) {
            console.error('[WA] Error marking as read:', err);
            if (this._isDetachedFrameError(err)) {
                this._reconnect();
            }
        }
    }

    async getProfilePic(contactId) {
        if (this.state !== 'ready') return null;
        try {
            const url = await this.client.getProfilePicUrl(contactId);
            return url || null;
        } catch (err) {
            return null;
        }
    }

    getQRCode() {
        return this.qrCode;
    }

    getState() {
        return this.state;
    }
}

module.exports = WhatsAppManager;
