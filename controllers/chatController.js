const Chat = require('../Models/chatModel');
const Usuario = require('../Models/usuarioModel');
const { normalizeId, referenceId, pairKey, validChat, hasPairIndex } = require('../utils/chatIntegrity');

function sessionId(req, res) {
  const id = normalizeId(req.usuarioId);
  if (!id) res.status(401).json({ mensagem: 'Sessao invalida' });
  return id;
}

function authorize(chat, usuarioId, res) {
  if (!chat) {
    res.status(404).json({ mensagem: 'Chat nao encontrado' });
    return false;
  }
  if (!chat.participants?.some(p => referenceId(p) === usuarioId)) {
    res.status(403).json({ mensagem: 'Voce nao participa deste chat' });
    return false;
  }
  if (!validChat(chat) || chat.isActive === false) {
    res.status(409).json({ mensagem: 'Conversa indisponivel: requer revisao de integridade' });
    return false;
  }
  return true;
}

async function loadChat(req, res, id) {
  const usuarioId = sessionId(req, res);
  if (!usuarioId) return null;
  const chatId = normalizeId(id);
  if (!chatId) {
    res.status(400).json({ mensagem: 'Informe um chat valido' });
    return null;
  }
  const chat = await Chat.findById(chatId);
  if (!authorize(chat, usuarioId, res)) return null;
  const ids = chat.participants.map(referenceId);
  const users = await Usuario.find({ _id: { $in: ids } }).select('_id');
  if (!users.some(user => referenceId(user) === usuarioId)) {
    res.status(401).json({ mensagem: 'Sessao invalida' });
    return null;
  }
  if (users.length !== 2 || !ids.every(id => users.some(user => referenceId(user) === id))) {
    res.status(409).json({ mensagem: 'Participantes indisponiveis; requer revisao' });
    return null;
  }
  return { chat, usuarioId };
}

function failure(res, mensagem, error) {
  if (error?.name === 'VersionError') return res.status(409).json({ mensagem: 'Conversa atualizada durante a operacao; tente novamente' });
  console.error('Falha interna na operacao de chat');
  return res.status(500).json({ mensagem });
}

function started(res, chat) {
  // A abertura nao precisa devolver o historico privado.
  return res.status(201).json({ mensagem: 'Chat iniciado com sucesso', chat: {
    _id: chat._id, participants: chat.participants.map(referenceId), pairKey: pairKey(chat.participants)
  } });
}

exports.startChat = async (req, res) => {
  try {
    const sender = sessionId(req, res);
    if (!sender) return;
    const receiver = normalizeId(req.body?.prestador_id);
    if (!receiver) return res.status(400).json({ mensagem: 'Informe um destinatario valido' });
    if (sender === receiver) return res.status(400).json({ mensagem: 'Nao e possivel conversar consigo mesmo' });
    const users = await Usuario.find({ _id: { $in: [sender, receiver] } }).select('_id');
    if (!users.some(user => referenceId(user) === sender)) return res.status(401).json({ mensagem: 'Sessao invalida' });
    if (!users.some(user => referenceId(user) === receiver)) return res.status(404).json({ mensagem: 'Destinatario nao encontrado' });
    const key = pairKey([sender, receiver]);
    // Inclui inconsistentes/inativos para nao ocultar conflitos historicos.
    const candidates = await Chat.find({ $or: [
      { participants: { $all: [sender, receiver] } }, { pairKey: key }
    ] }).limit(2);
    if (candidates.length > 1) return res.status(409).json({ mensagem: 'Par de usuarios com conversas duplicadas; requer revisao' });
    if (candidates.length === 1) {
      const chat = candidates[0];
      if (!authorize(chat, sender, res)) return;
      if (pairKey(chat.participants) !== key) return res.status(409).json({ mensagem: 'Par de usuarios inconsistente' });
      return started(res, chat);
    }
    // Upsert sem indice unico real nao garante unicidade entre instancias.
    let indexes;
    try { indexes = await Chat.collection.indexes(); }
    catch (error) { if (error.code !== 26) throw error; indexes = []; }
    if (!hasPairIndex(indexes)) return res.status(503).json({
      mensagem: 'Criacao de conversas indisponivel ate preparacao do indice de pares', codigo: 'CHAT_PAIR_INDEX_REQUIRED'
    });
    let chat;
    try {
      chat = await Chat.findOneAndUpdate({ pairKey: key }, { $setOnInsert: {
        pairKey: key, participants: [sender, receiver].sort(), messages: [], isActive: true
      } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.pairKey) throw error;
      chat = await Chat.findOne({ pairKey: key });
    }
    if (!authorize(chat, sender, res)) return;
    if (pairKey(chat.participants) !== key) return res.status(409).json({ mensagem: 'Par de usuarios inconsistente' });
    return started(res, chat);
  } catch (error) { return failure(res, 'Erro ao iniciar chat', error); }
};

exports.sendMessage = async (req, res) => {
  try {
    const { chat_id, content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ mensagem: 'Informe uma mensagem valida' });
    const loaded = await loadChat(req, res, chat_id);
    if (!loaded) return;
    const { chat, usuarioId: sender } = loaded;
    const receiver = chat.participants.map(referenceId).find(id => id !== sender);
    chat.messages.push({ sender, receiver, content: content.trim(), read: false });
    chat.lastMessage = Date.now();
    await chat.save();
    return res.status(201).json({ mensagem: 'Mensagem enviada com sucesso', message: chat.messages[chat.messages.length - 1] });
  } catch (error) { return failure(res, 'Erro ao enviar mensagem', error); }
};

exports.getChatMessages = async (req, res) => {
  try {
    const loaded = await loadChat(req, res, req.params.chatId);
    if (!loaded) return;
    const { chat } = loaded;
    await chat.populate({ path: 'participants', select: 'nome', retainNullValues: true });
    if (!validChat(chat)) return res.status(409).json({ mensagem: 'Participantes indisponiveis; requer revisao' });
    // GET nao modifica historico. A leitura e registrada pelo PUT /read.
    return res.json({ chat: { id: chat._id, participants: chat.participants.map(p => ({ _id: referenceId(p), nome: p.nome })) }, messages: chat.messages });
  } catch (error) { return failure(res, 'Erro ao buscar mensagens', error); }
};

exports.getUserChats = async (req, res) => {
  try {
    const usuarioId = sessionId(req, res);
    if (!usuarioId) return;
    const chats = await Chat.find({ participants: usuarioId, isActive: true })
      .populate({ path: 'participants', select: 'nome', retainNullValues: true }).sort({ lastMessage: -1 });
    return res.json(chats.filter(chat => validChat(chat) && chat.isActive !== false &&
      chat.participants.some(p => referenceId(p) === usuarioId)).map(chat => {
      const other = chat.participants.find(p => referenceId(p) !== usuarioId);
      const last = chat.messages[chat.messages.length - 1];
      return { id: chat._id, outro_participante: { _id: referenceId(other), nome: other.nome },
        ultima_mensagem: last ? last.content : null, ultima_mensagem_data: chat.lastMessage,
        nao_lidas: chat.messages.filter(m => referenceId(m.receiver) === usuarioId && !m.read).length,
        total_mensagens: chat.messages.length };
    }));
  } catch (error) { return failure(res, 'Erro ao buscar chats', error); }
};

exports.markAsRead = async (req, res) => {
  try {
    const loaded = await loadChat(req, res, req.params.chatId);
    if (!loaded) return;
    const { chat, usuarioId } = loaded;
    let marcadas = 0;
    chat.messages.forEach(message => {
      if (referenceId(message.receiver) === usuarioId && !message.read) {
        message.read = true;
        message.readAt = Date.now();
        marcadas++;
      }
    });
    await chat.save();
    return res.json({ mensagem: 'Mensagens marcadas como lidas', marcadas });
  } catch (error) { return failure(res, 'Erro ao marcar mensagens', error); }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const usuarioId = sessionId(req, res);
    if (!usuarioId) return;
    const chats = await Chat.find({ participants: usuarioId, isActive: true })
      .populate({ path: 'participants', select: 'nome', retainNullValues: true });
    const total = chats.filter(chat => validChat(chat) && chat.isActive !== false &&
      chat.participants.some(p => referenceId(p) === usuarioId)).reduce((count, chat) =>
      count + chat.messages.filter(m => referenceId(m.receiver) === usuarioId && !m.read).length, 0);
    return res.json({ total_nao_lidas: total });
  } catch (error) { return failure(res, 'Erro ao buscar nao lidas', error); }
};
