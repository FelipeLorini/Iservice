const express = require('express');
const router = express.Router();
const authRoutes = require('./authRoutes');
const servicoRoutes = require('./servicoRoutes');
const agendamentoRoutes = require('./agendamentoRoutes');
const avaliacaoRoutes = require('./avaliacaoRoutes');
const PedidoController = require('../controllers/pedidoController');
const PropostaController = require('../controllers/propostaController');
const notificacaoRoutes = require('./notificacaoRoutes');
const favoritoRoutes = require('./favoritoRoutes');
const faqRoutes = require('./faqRoutes');
const usuarioRoutes = require('./usuarioRoutes');
const { auth, verificarPrestador, verificarCliente } = require('../middleware/auth');

router.use('/', authRoutes);

router.use('/servicos', servicoRoutes);

router.use('/agendamentos', agendamentoRoutes);

router.use('/avaliacoes', avaliacaoRoutes);

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
