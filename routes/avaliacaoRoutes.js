const express = require('express');
const router = express.Router();
const AvaliacaoController = require('../controllers/avaliacaoController');
const { auth, verificarCliente } = require('../middleware/auth');

router.post('/', auth, verificarCliente, AvaliacaoController.criarAvaliacao);
router.get('/cliente', auth, verificarCliente, AvaliacaoController.listarAvaliacoesCliente);
router.get('/prestador/:id', AvaliacaoController.listarAvaliacoesPorPrestador);
router.get('/prestador/:id/media', AvaliacaoController.calcularMedia);

module.exports = router;
