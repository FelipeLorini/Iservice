const express = require('express');
const router = express.Router();
const FavoritoController = require('../controllers/favoritoController');
const { auth, verificarCliente } = require('../middleware/auth');

router.post('/', auth, verificarCliente, FavoritoController.adicionarFavorito);
router.delete('/:id', auth, verificarCliente, FavoritoController.removerFavorito);
router.get('/', auth, verificarCliente, FavoritoController.listarFavoritos);
router.get('/verificar/:prestador_id', auth, verificarCliente, FavoritoController.verificarFavorito);

module.exports = router;
