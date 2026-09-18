const mongoose = require('mongoose');

const FaqSchema = new mongoose.Schema({
  pergunta: {
    type: String,
    required: true
  },
  resposta: {
    type: String,
    required: true
  },
  categoria: {
    type: String,
    default: 'geral'
  },
  ordem: {
    type: Number,
    default: 0
  }
});

module.exports = mongoose.model('Faq', FaqSchema);