const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/start', chatController.startChat);
router.post('/message', chatController.sendMessage);
router.get('/unread/count', chatController.getUnreadCount);
router.get('/', chatController.getUserChats);
router.put('/:chatId/read', chatController.markAsRead);
router.get('/:chatId', chatController.getChatMessages);

module.exports = router;
