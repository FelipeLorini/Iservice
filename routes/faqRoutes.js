const express = require('express');
const router = express.Router();
const FaqController = require('../controllers/faqController');

router.get('/', FaqController.listarFaqs);

module.exports = router;
