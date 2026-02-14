const WebSocket = require('ws');

class WsManager {
    constructor() {
        this.wss = null;
        this.clients = new Set();
    }

    attach(server) {
        this.wss = new WebSocket.Server({ server, path: '/ws' });

        this.wss.on('connection', (ws) => {
            console.log('[WS] Client connected');
            this.clients.add(ws);

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong' }));
                    }
                } catch (e) {
                    // ignore invalid messages
                }
            });

            ws.on('close', () => {
                console.log('[WS] Client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (err) => {
                console.error('[WS] Error:', err.message);
                this.clients.delete(ws);
            });
        });

        console.log('[WS] WebSocket server attached');
    }

    broadcast(type, data) {
        const payload = JSON.stringify({ type, data });
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(payload);
                } catch (e) {
                    // ignore send errors
                }
            }
        }
    }

    broadcastNewMessage(message) {
        this.broadcast('new_message', {
            chatId: message.chatId || (message.fromMe ? message.to : message.from),
            message: {
                id: message.id,
                body: message.body,
                from: message.from,
                to: message.to,
                timestamp: message.timestamp,
                fromMe: message.fromMe,
                ack: message.ack,
                type: message.type,
                author: message.author || null
            }
        });
    }

    broadcastMessageAck(messageId, chatId, ack) {
        this.broadcast('message_ack', { messageId, chatId, ack });
    }

    broadcastReaction(reaction) {
        this.broadcast('message_reaction', reaction);
    }

    broadcastStatus(state) {
        this.broadcast('status', { state });
    }
}

module.exports = WsManager;
