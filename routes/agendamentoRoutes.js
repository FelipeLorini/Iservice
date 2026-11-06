const express = require('express');
const router = express.Router();
const AgendamentoController = require('../controllers/agendamentoController');
const { auth, verificarCliente, verificarPrestador } = require('../middleware/auth');

router.post('/', auth, verificarCliente, AgendamentoController.agendarServico);
router.get('/cliente', auth, verificarCliente, AgendamentoController.listarAgendamentosCliente);
router.get('/prestador', auth, verificarPrestador, AgendamentoController.listarAgendamentosPrestador);
router.put('/:id/status', auth, verificarPrestador, AgendamentoController.atualizarStatusAgendamento);
router.put('/:id/cancelar', auth, verificarCliente, AgendamentoController.cancelarAgendamento);

module.exports = router;
