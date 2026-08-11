const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/start', chatController.startChat);
router.post('/message', chatController.sendMessage);
router.get('/:chatId', chatController.getChatMessages);
router.get('/', chatController.getUserChats);
router.put('/:chatId/read', chatController.markAsRead);
router.get('/unread/count', chatController.getUnreadCount);

module.exports = router;
