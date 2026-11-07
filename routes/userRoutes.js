const express = require('express');
const router = express.Router();
const authRoutes = require('./authRoutes');
const servicoRoutes = require('./servicoRoutes');
const agendamentoRoutes = require('./agendamentoRoutes');
const avaliacaoRoutes = require('./avaliacaoRoutes');
const pedidoRoutes = require('./pedidoRoutes');
const propostaRoutes = require('./propostaRoutes');
const notificacaoRoutes = require('./notificacaoRoutes');
const favoritoRoutes = require('./favoritoRoutes');
const faqRoutes = require('./faqRoutes');
const usuarioRoutes = require('./usuarioRoutes');

router.use('/', authRoutes);

router.use('/servicos', servicoRoutes);

router.use('/agendamentos', agendamentoRoutes);

router.use('/avaliacoes', avaliacaoRoutes);

router.use('/pedidos', pedidoRoutes);

router.use('/propostas', propostaRoutes);

router.use('/notificacoes', notificacaoRoutes);

router.use('/favoritos', favoritoRoutes);

router.use('/faq', faqRoutes);

router.use('/usuario', usuarioRoutes);

module.exports = router;
