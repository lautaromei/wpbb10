const express = require('express');
const router = express.Router();

module.exports = function(waManager) {
    // GET /api/status
    router.get('/status', (req, res) => {
        res.json({
            state: waManager.getState()
        });
    });

    // GET /api/qr
    router.get('/qr', (req, res) => {
        const qr = waManager.getQRCode();
        if (qr) {
            // qr is a data URI: "data:image/png;base64,..."
            res.json({ qr: qr });
        } else {
            const state = waManager.getState();
            if (state === 'ready' || state === 'authenticated') {
                res.json({ qr: null, message: 'Already authenticated' });
            } else {
                res.json({ qr: null, message: 'QR not yet available, state: ' + state });
            }
        }
    });

    return router;
};
