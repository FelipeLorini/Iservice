const express = require('express');
const router = express.Router();
const CadastroController = require('../controllers/CadastroController');
const LoginController = require('../controllers/LoginController');
const ServicoController = require('../controllers/ServicoController');
const AgendamentoController = require('../controllers/agendamentoController');
const AvaliacaoController = require('../controllers/avaliacaoController');
const PedidoController = require('../controllers/pedidoController');
const PropostaController = require('../controllers/propostaController');
const NotificacaoController = require('../controllers/notificacaoController');
const FavoritoController = require('../controllers/favoritoController');
const FaqController = require('../controllers/faqController');
const UsuarioController = require('../controllers/usuarioController');
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

router.post('/avaliacoes', auth, verificarCliente, AvaliacaoController.criarAvaliacao);
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

router.get('/notificacoes', auth, NotificacaoController.listarNotificacoes);
router.put('/notificacoes/:id/lida', auth, NotificacaoController.marcarComoLida);
router.get('/notificacoes/nao-lidas', auth, NotificacaoController.contarNaoLidas);

router.post('/favoritos', auth, verificarCliente, FavoritoController.adicionarFavorito);
router.delete('/favoritos/:id', auth, verificarCliente, FavoritoController.removerFavorito);
router.get('/favoritos', auth, verificarCliente, FavoritoController.listarFavoritos);
router.get('/favoritos/verificar/:prestador_id', auth, verificarCliente, FavoritoController.verificarFavorito);

router.get('/faq', FaqController.listarFaqs);

router.get('/usuario/:id/perfil', UsuarioController.obterPerfilPublico);
router.put('/usuario/portifolio', auth, verificarPrestador, UsuarioController.atualizarPortifolio);

module.exports = router;