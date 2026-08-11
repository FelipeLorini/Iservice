const express = require('express');
const router = express.Router();
const CadastroController = require('../Controllers/CadastroController');
const LoginController = require('../Controllers/LoginController');
const ServicoController = require('../Controllers/ServicoController');
const AgendamentoController = require('../Controllers/AgendamentoController');
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