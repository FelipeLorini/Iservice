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
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao iniciar chat' });
  }
};

exports.sendMessage = async (req, res) => {
  try {

    const { chat_id, content } = req.body;
    const sender = req.usuarioId;

    if (!chat_id || !content) {
      return res.status(400).json({ mensagem: 'chat_id e content sao obrigatorios' });
    }

    const chat = await Chat.findById(chat_id);

    if (!chat) {
      return res.status(404).json({ mensagem: 'Chat nao encontrado' });
    }


    if (!chat.participants.includes(sender)) {
      return res.status(403).json({ mensagem: 'Voce nao participa deste chat' });
    }

    const receiver = chat.participants.find(p => p.toString() !== sender);

    if (!receiver) {
      return res.status(400).json({ mensagem: 'Destinatario nao encontrado' });
    }

    const message = {
      sender,
      receiver,
      content,
      read: false
    };

    chat.messages.push(message);
    chat.lastMessage = Date.now();
    await chat.save();

    res.status(201).json({
      mensagem: 'Mensagem enviada com sucesso',
      message: chat.messages[chat.messages.length - 1]
    });

  } catch (error) {
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao enviar mensagem' });
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
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao buscar mensagens' });
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
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao buscar chats' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { chatId } = req.params;
    const usuarioId = req.usuarioId;

    if (typeof chatId !== 'string' || !/^[a-f\d]{24}$/i.test(chatId)) {
      return res.status(400).json({ mensagem: 'Informe um chat valido' });
    }

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ mensagem: 'Chat nao encontrado' });
    }

    if (!chat.participants.some(participante => participante && participante.toString() === usuarioId)) {
      return res.status(403).json({ mensagem: 'Voce nao participa deste chat' });
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
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao marcar mensagens' });
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
    console.error('Falha interna na operacao de chat');
    res.status(500).json({ mensagem: 'Erro ao buscar nao lidas' });
  }
};
