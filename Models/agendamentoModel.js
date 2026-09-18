const mongoose = require('mongoose');

const AgendamentoSchema = new mongoose.Schema({
  cliente_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  prestador_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  servico_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Servico',
    required: true
  },
  data: {
    type: Date,
    required: true
  },
  hora: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pendente', 'confirmado', 'cancelado', 'finalizado'],
    default: 'pendente'
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Agendamento', AgendamentoSchema);