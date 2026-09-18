const mongoose = require('mongoose');

const PropostaSchema = new mongoose.Schema({
  pedido_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pedido',
    required: true
  },
  prestador_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  valor: {
    type: Number,
    required: true
  },
  prazo: {
    type: String,
    required: true
  },
  descricao: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['enviada', 'aceita', 'recusada'],
    default: 'enviada'
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

PropostaSchema.index({ pedido_id: 1, prestador_id: 1 }, { unique: true });

module.exports = mongoose.model('Proposta', PropostaSchema);