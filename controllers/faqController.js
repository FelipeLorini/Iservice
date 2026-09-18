const Faq = require('../Models/faqModel');

exports.listarFaqs = async (req, res) => {
  try {
    const faqs = await Faq.find().sort({ categoria: 1, ordem: 1 });
    res.json(faqs);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar faqs', erro: error.message });
  }
};