const express = require('express');
const router = express.Router();

module.exports = function(waManager) {
    // GET /api/chats
    router.get('/', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 20;
            const chats = await waManager.getChats(limit);
            res.json({ chats });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/chats/:id/messages
    router.get('/:id/messages', async (req, res) => {
        try {
            const chatId = req.params.id;
            const limit = parseInt(req.query.limit) || 50;
            const serverBaseUrl = `${req.protocol}://${req.get('host')}`;
            const messages = await waManager.getMessages(chatId, limit, serverBaseUrl);
            res.json({ messages });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/chats/:id/messages
    router.post('/:id/messages', async (req, res) => {
        try {
            const chatId = req.params.id;
            const { body } = req.body;
            if (!body) {
                return res.status(400).json({ error: 'Message body is required' });
            }
            const message = await waManager.sendMessage(chatId, body);
            res.json({ message });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/chats/:id/media - Send media message
    router.post('/:id/media', async (req, res) => {
        try {
            const chatId = req.params.id;
            const { data, mimetype, caption } = req.body;
            if (!data || !mimetype) {
                return res.status(400).json({ error: 'Media data and mimetype are required' });
            }
            const message = await waManager.sendMedia(chatId, data, mimetype, caption || '');
            // Add mediaUrl so client can play it back
            const serverBaseUrl = `${req.protocol}://${req.get('host')}`;
            message.mediaUrl = `${serverBaseUrl}/api/media/${encodeURIComponent(message.id)}`;
            res.json({ message });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/chats/:id/messages/:msgId/react - React to a message
    router.post('/:id/messages/:msgId/react', async (req, res) => {
        try {
            const { emoji } = req.body;
            const messageId = req.params.msgId;
            if (!emoji) {
                return res.status(400).json({ error: 'Emoji is required' });
            }
            const result = await waManager.reactMessage(messageId, emoji);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/chats/:id/seen
    router.post('/:id/seen', async (req, res) => {
        try {
            const chatId = req.params.id;
            await waManager.markAsRead(chatId);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
