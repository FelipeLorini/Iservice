const express = require('express');
const router = express.Router();
const CadastroController = require('../controllers/CadastroController');
const LoginController = require('../controllers/LoginController');
const ServicoController = require('../controllers/ServicoController');
const AgendamentoController = require('../controllers/AgendamentoController');
const { auth, verificarPrestador, verificarCliente } = require('../middleware/auth');

router.post('/cadastro', CadastroController.cadastrar);
router.post('/login', LoginController.login);

router.get('/servicos', ServicoController.listarServicos);
router.get('/servicos/categoria/:categoria', ServicoController.listarServicosPorCategoria);
router.post('/servicos', auth, verificarPrestador, ServicoController.cadastrarServico);
router.get('/servicos/prestador', auth, verificarPrestador, ServicoController.listarServicosPorPrestador);
router.delete('/servicos/:id', auth, verificarPrestador, ServicoController.deletarServico);

router.post('/agendamentos', auth, verificarCliente, AgendamentoController.agendarServico);
router.get('/agendamentos/cliente', auth, verificarCliente, AgendamentoController.listarAgendamentosCliente);
router.get('/agendamentos/prestador', auth, verificarPrestador, AgendamentoController.listarAgendamentosPrestador);
router.put('/agendamentos/:id/status', auth, verificarPrestador, AgendamentoController.atualizarStatusAgendamento);
router.put('/agendamentos/:id/cancelar', auth, verificarCliente, AgendamentoController.cancelarAgendamento);

module.exports = router;
