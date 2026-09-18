const mongoose = require('mongoose');

const FavoritoSchema = new mongoose.Schema({
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
  data_criacao: {
    type: Date,
    default: Date.now
  }
});

FavoritoSchema.index({ cliente_id: 1, prestador_id: 1 }, { unique: true });

module.exports = mongoose.model('Favorito', FavoritoSchema);