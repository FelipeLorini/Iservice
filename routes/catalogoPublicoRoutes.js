const express = require('express');
const router = express.Router();
const ServicoController = require('../controllers/ServicoController');

router.get('/', ServicoController.listarServicos);
router.get('/categoria/:categoria', ServicoController.listarServicosPorCategoria);

module.exports = router;
