const express = require('express');
const router = express.Router();
const CadastroController = require('../controllers/CadastroController');
const LoginController = require('../controllers/LoginController');

router.post('/cadastro', CadastroController.cadastrar);
router.post('/login', LoginController.login);

module.exports = router;
