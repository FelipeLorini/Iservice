const mongoose = require('mongoose');
const { participantIds, pairKey, validMessages, PAIR_INDEX } = require('../utils/chatIntegrity');

const messageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  read: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date
  }
}, {
  timestamps: true
});

const chatSchema = new mongoose.Schema({
  participants: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true }],
    immutable: true,
    validate: { validator: value => !!participantIds(value), message: 'Exatamente dois participantes distintos sao obrigatorios' }
  },
  pairKey: {
    type: String,
    immutable: true,
    validate: {
      validator(value) {
        const participants = this instanceof mongoose.Query ? this.getUpdate().$setOnInsert?.participants : this.participants;
        return value === undefined || value === pairKey(participants);
      },
      message: 'Chave de participantes inconsistente'
    }
  },
  messages: {
    type: [messageSchema],
    validate: {
      validator(value) { return Array.isArray(value) && (value.length === 0 || validMessages(value, participantIds(this.participants) || [])); },
      message: 'Remetente e destinatario devem pertencer a conversa'
    }
  },
  lastMessage: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  optimisticConcurrency: true,
  // Nenhum indice/colecao e criado automaticamente na inicializacao.
  autoIndex: false,
  autoCreate: false
});

chatSchema.pre('validate', function () {
  if (this.isNew && this.pairKey === undefined) this.pairKey = pairKey(this.participants) || undefined;
});

chatSchema.index({ pairKey: 1 }, {
  name: PAIR_INDEX, unique: true, partialFilterExpression: { pairKey: { $type: 'string' } }
});
chatSchema.index({ participants: 1 });
chatSchema.index({ 'messages.sender': 1 });
chatSchema.index({ lastMessage: -1 });

module.exports = mongoose.model('Chat', chatSchema);
