const mongoose = require('mongoose');

const PedidoSchema = new mongoose.Schema({
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