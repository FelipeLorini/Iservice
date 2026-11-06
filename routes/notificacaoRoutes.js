const express = require('express');
const router = express.Router();
const NotificacaoController = require('../controllers/notificacaoController');
const { auth } = require('../middleware/auth');

router.get('/', auth, NotificacaoController.listarNotificacoes);
router.put('/:id/lida', auth, NotificacaoController.marcarComoLida);
router.get('/nao-lidas', auth, NotificacaoController.contarNaoLidas);

module.exports = router;
