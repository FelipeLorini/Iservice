const mongoose = require('mongoose');

const AvaliacaoSchema = new mongoose.Schema({
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
  agendamento_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agendamento',
    // Exige vinculo nas novas avaliacoes sem invalidar documentos antigos.
    required: function () { return this.isNew; }
  },
  nota: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  comentario: {
    type: String,
    default: ''
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

AvaliacaoSchema.index({ agendamento_id: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Avaliacao', AvaliacaoSchema);
