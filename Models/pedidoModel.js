const mongoose = require('mongoose');

const ContratacaoSchema = new mongoose.Schema({
  proposta_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Proposta' },
  servico_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Servico' },
  agendamento_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Agendamento' }
}, { _id: false });

const PedidoSchema = new mongoose.Schema({
  fluxo_contratacao: { type: Number, enum: [1] },
  contratacao: { type: ContratacaoSchema },
  cliente_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  titulo: {
    type: String,
    required: true
  },
  descricao: {
    type: String,
    required: true
  },
  categoria: {
    type: String,
    enum: ['eletrica', 'encanamento', 'faxina', 'jardinagem', 'pintura', 'reparos'],
    required: true
  },
  data_desejada: {
    type: Date
  },
  status: {
    type: String,
    enum: ['aberto', 'em andamento', 'finalizado', 'cancelado'],
    default: 'aberto'
  },
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Pedido', PedidoSchema);
