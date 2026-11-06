const express = require('express');
const router = express.Router();
const perfilPublicoRoutes = require('./perfilPublicoRoutes');
const UsuarioController = require('../controllers/usuarioController');
const { auth, verificarPrestador } = require('../middleware/auth');

router.use('/', perfilPublicoRoutes);
router.put('/portifolio', auth, verificarPrestador, UsuarioController.atualizarPortifolio);

module.exports = router;
