const express = require('express');
const router = express.Router();
const PropostaController = require('../controllers/propostaController');
const { auth, verificarCliente, verificarPrestador } = require('../middleware/auth');

router.post('/', auth, verificarPrestador, PropostaController.criarProposta);
router.get('/pedido/:id', auth, verificarCliente, PropostaController.listarPropostas);
router.get('/prestador', auth, verificarPrestador, PropostaController.listarPropostasPrestador);
router.put('/:id/aceitar', auth, verificarCliente, PropostaController.aceitarProposta);

module.exports = router;
