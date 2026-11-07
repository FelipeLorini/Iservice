const express = require('express');
const router = express.Router();
const PedidoController = require('../controllers/pedidoController');
const { auth, verificarCliente, verificarPrestador } = require('../middleware/auth');

router.post('/', auth, verificarCliente, PedidoController.criarPedido);
router.get('/cliente', auth, verificarCliente, PedidoController.listarPedidosCliente);
router.get('/abertos', auth, verificarPrestador, PedidoController.listarPedidosAbertos);
router.put('/:id/cancelar', auth, verificarCliente, PedidoController.cancelarPedido);

module.exports = router;
