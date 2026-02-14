const express = require('express');
const router = express.Router();

module.exports = function(waManager) {
    // GET /api/contacts/:id/picture
    router.get('/:id/picture', async (req, res) => {
        try {
            const contactId = req.params.id;
            const url = await waManager.getProfilePic(contactId);
            if (url) {
                res.json({ url });
            } else {
                res.json({ url: null });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
