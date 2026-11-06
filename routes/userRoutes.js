const express = require('express');
const router = express.Router();
const CadastroController = require('../controllers/CadastroController');
const LoginController = require('../controllers/LoginController');
const servicoRoutes = require('./servicoRoutes');
const AgendamentoController = require('../controllers/agendamentoController');
const AvaliacaoController = require('../controllers/avaliacaoController');
const PedidoController = require('../controllers/pedidoController');
const PropostaController = require('../controllers/propostaController');
const notificacaoRoutes = require('./notificacaoRoutes');
const favoritoRoutes = require('./favoritoRoutes');
const faqRoutes = require('./faqRoutes');
const usuarioRoutes = require('./usuarioRoutes');
const { auth, verificarPrestador, verificarCliente } = require('../middleware/auth');

router.post('/cadastro', CadastroController.cadastrar);
router.post('/login', LoginController.login);

router.use('/servicos', servicoRoutes);

router.post('/agendamentos', auth, verificarCliente, AgendamentoController.agendarServico);
router.get('/agendamentos/cliente', auth, verificarCliente, AgendamentoController.listarAgendamentosCliente);
router.get('/agendamentos/prestador', auth, verificarPrestador, AgendamentoController.listarAgendamentosPrestador);
router.put('/agendamentos/:id/status', auth, verificarPrestador, AgendamentoController.atualizarStatusAgendamento);
router.put('/agendamentos/:id/cancelar', auth, verificarCliente, AgendamentoController.cancelarAgendamento);

router.post('/avaliacoes', auth, verificarCliente, AvaliacaoController.criarAvaliacao);
router.get('/avaliacoes/cliente', auth, verificarCliente, AvaliacaoController.listarAvaliacoesCliente);
router.get('/avaliacoes/prestador/:id', AvaliacaoController.listarAvaliacoesPorPrestador);
router.get('/avaliacoes/prestador/:id/media', AvaliacaoController.calcularMedia);

router.post('/pedidos', auth, verificarCliente, PedidoController.criarPedido);
router.get('/pedidos/cliente', auth, verificarCliente, PedidoController.listarPedidosCliente);
router.get('/pedidos/abertos', auth, verificarPrestador, PedidoController.listarPedidosAbertos);
router.put('/pedidos/:id/cancelar', auth, verificarCliente, PedidoController.cancelarPedido);

router.post('/propostas', auth, verificarPrestador, PropostaController.criarProposta);
router.get('/propostas/pedido/:id', auth, verificarCliente, PropostaController.listarPropostas);
router.get('/propostas/prestador', auth, verificarPrestador, PropostaController.listarPropostasPrestador);
router.put('/propostas/:id/aceitar', auth, verificarCliente, PropostaController.aceitarProposta);

router.use('/notificacoes', notificacaoRoutes);

router.use('/favoritos', favoritoRoutes);

router.use('/faq', faqRoutes);

router.use('/usuario', usuarioRoutes);

module.exports = router;
