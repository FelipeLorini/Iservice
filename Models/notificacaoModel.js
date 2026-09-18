const mongoose = require('mongoose');

const NotificacaoSchema = new mongoose.Schema({
  usuario_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  mensagem: {
    type: String,
    required: true
  },
  tipo: {
    type: String,
    enum: ['nova_proposta', 'proposta_aceita', 'novo_agendamento', 'cancelamento', 'avaliacao'],
    required: true
  },
  lida: {
    type: Boolean,
    default: false
  },
  link: {
    type: String,
    default: ''
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Notificacao', NotificacaoSchema);