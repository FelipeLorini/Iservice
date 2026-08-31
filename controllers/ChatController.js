const Chat = require('../Models/chatModel');

exports.startChat = async (req, res) => {
  try {
    const { prestador_id } = req.body;
    const cliente_id = req.usuarioId;

    let chat = await Chat.findOne({
      participants: { $all: [cliente_id, prestador_id] },
      isActive: true
    });

    if (!chat) {
      chat = await Chat.create({
        participants: [cliente_id, prestador_id]
      });
    }

    res.status(201).json({
      mensagem: 'Chat iniciado com sucesso',
      chat
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao iniciar chat', erro: error.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    console.log('1 - sendMessage chamado');
    console.log('2 - Body:', req.body);
    console.log('3 - Usuario ID:', req.usuarioId);

    const { chat_id, content } = req.body;
    const sender = req.usuarioId;

    if (!chat_id || !content) {
      console.log('4 - chat_id ou content faltando');
      return res.status(400).json({ mensagem: 'chat_id e content sao obrigatorios' });
    }

    console.log('5 - Buscando chat...');
    const chat = await Chat.findById(chat_id);
    console.log('6 - Chat encontrado:', chat ? 'Sim' : 'Nao');

    if (!chat) {
      console.log('7 - Chat nao encontrado');
      return res.status(404).json({ mensagem: 'Chat nao encontrado' });
    }

    console.log('8 - Participants:', chat.participants);
    console.log('9 - Sender:', sender);

    if (!chat.participants.includes(sender)) {
      console.log('10 - Usuario nao participa do chat');
      return res.status(403).json({ mensagem: 'Voce nao participa deste chat' });
    }

    const receiver = chat.participants.find(p => p.toString() !== sender);
    console.log('11 - Receiver:', receiver);

    if (!receiver) {
      console.log('12 - Receiver nao encontrado');
      return res.status(400).json({ mensagem: 'Destinatario nao encontrado' });
    }

    const message = {
      sender,
      receiver,
      content,
      read: false
    };

    console.log('13 - Adicionando mensagem...');
    chat.messages.push(message);
    chat.lastMessage = Date.now();
    await chat.save();

    console.log('14 - Mensagem enviada com sucesso');
    res.status(201).json({
      mensagem: 'Mensagem enviada com sucesso',
      message: chat.messages[chat.messages.length - 1]
    });

  } catch (error) {
    console.log('15 - ERRO CAPTURADO:', error.message);
    console.log('16 - Stack:', error.stack);
    res.status(500).json({ mensagem: 'Erro ao enviar mensagem', erro: error.message });
  }
};

exports.getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const usuarioId = req.usuarioId;

    const chat = await Chat.findById(chatId).populate('participants', 'nome');
    if (!chat) {
      return res.status(404).json({ mensagem: 'Chat nao encontrado' });
    }

    if (!chat.participants.some(p => p._id.toString() === usuarioId)) {
      return res.status(403).json({ mensagem: 'Acesso negado' });
    }

    const messages = chat.messages || [];

    chat.messages.forEach(msg => {
      if (msg.receiver.toString() === usuarioId && !msg.read) {
        msg.read = true;
        msg.readAt = Date.now();
      }
    });
    await chat.save();

    res.json({
      chat: {
        id: chat._id,
        participants: chat.participants
      },
      messages
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao buscar mensagens', erro: error.message });
  }
};

exports.getUserChats = async (req, res) => {
  try {
    const usuarioId = req.usuarioId;

    const chats = await Chat.find({
      participants: usuarioId,
      isActive: true
    })
    .populate('participants', 'nome')
    .sort({ lastMessage: -1 });

    const chatsComInfo = chats.map(chat => {
      const outroParticipante = chat.participants.find(
        p => p._id.toString() !== usuarioId
      );

      const naoLidas = chat.messages.filter(
        msg => msg.receiver.toString() === usuarioId && !msg.read
      ).length;

      const ultimaMsg = chat.messages.length > 0
        ? chat.messages[chat.messages.length - 1]
        : null;

      return {
        id: chat._id,
        outro_participante: outroParticipante || null,
        ultima_mensagem: ultimaMsg ? ultimaMsg.content : null,
        ultima_mensagem_data: chat.lastMessage,
        nao_lidas: naoLidas,
        total_mensagens: chat.messages.length
      };
    });

    res.json(chatsComInfo);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao buscar chats', erro: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { chatId } = req.params;
    const usuarioId = req.usuarioId;

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ mensagem: 'Chat nao encontrado' });
    }

    let marcadas = 0;
    chat.messages.forEach(msg => {
      if (msg.receiver.toString() === usuarioId && !msg.read) {
        msg.read = true;
        msg.readAt = Date.now();
        marcadas++;
      }
    });

    await chat.save();

    res.json({
      mensagem: 'Mensagens marcadas como lidas',
      marcadas
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao marcar mensagens', erro: error.message });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const usuarioId = req.usuarioId;

    const chats = await Chat.find({
      participants: usuarioId,
      isActive: true
    });

    let totalNaoLidas = 0;

    chats.forEach(chat => {
      const naoLidas = chat.messages.filter(
        msg => msg.receiver.toString() === usuarioId && !msg.read
      ).length;
      totalNaoLidas += naoLidas;
    });

    res.json({ total_nao_lidas: totalNaoLidas });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao buscar nao lidas', erro: error.message });
  }
};

