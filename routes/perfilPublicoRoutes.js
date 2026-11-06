const express = require('express');
const router = express.Router();
const UsuarioController = require('../controllers/usuarioController');

router.get('/:id/perfil', UsuarioController.obterPerfilPublico);

module.exports = router;
