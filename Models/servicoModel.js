
const mongoose = require('mongoose');

const ServicoSchema = new mongoose.Schema({
  nome: {
    type: String,
    required: true
  },
  descricao: {
    type: String,
    required: true
  },
  preco: {
    type: Number,
    required: true
  },
  categoria: {
    type: String,
    enum: ['eletrica', 'encanamento', 'faxina', 'jardinagem', 'pintura', 'reparos'],
    required: true
  },
  prestador_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Servico', ServicoSchema);