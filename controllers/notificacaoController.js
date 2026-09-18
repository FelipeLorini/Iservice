const Notificacao = require('../Models/notificacaoModel');

exports.listarNotificacoes = async (req, res) => {
  try {
    const usuario_id = req.usuarioId;
    const notificacoes = await Notificacao.find({ usuario_id })
      .sort({ data_criacao: -1 })
      .limit(30);
    res.json(notificacoes);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar notificacoes', erro: error.message });
  }
};

exports.marcarComoLida = async (req, res) => {
  try {
    const { id } = req.params;
    const notificacao = await Notificacao.findById(id);

    if (!notificacao) {
      return res.status(404).json({ mensagem: 'Notificacao nao encontrada' });
    }
    if (notificacao.usuario_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para alterar esta notificacao' });
    }

    notificacao.lida = true;
    await notificacao.save();

    res.json({ mensagem: 'Notificacao marcada como lida', notificacao });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao marcar notificacao', erro: error.message });
  }
};

exports.contarNaoLidas = async (req, res) => {
  try {
    const usuario_id = req.usuarioId;
    const total = await Notificacao.countDocuments({ usuario_id, lida: false });
    res.json({ total });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao contar notificacoes', erro: error.message });
  }
};