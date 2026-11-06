const express = require('express');
const router = express.Router();
const catalogoPublicoRoutes = require('./catalogoPublicoRoutes');
const ServicoController = require('../controllers/ServicoController');
const { auth, verificarPrestador } = require('../middleware/auth');

router.use('/', catalogoPublicoRoutes);
router.post('/', auth, verificarPrestador, ServicoController.cadastrarServico);
router.get('/prestador', auth, verificarPrestador, ServicoController.listarServicosPorPrestador);
router.delete('/:id', auth, verificarPrestador, ServicoController.deletarServico);

module.exports = router;
