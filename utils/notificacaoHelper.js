const Notificacao = require('../Models/notificacaoModel');

const criarNotificacao = async (usuario_id, mensagem, tipo, link = '') => {
  try {
    await Notificacao.create({ usuario_id, mensagem, tipo, link });
  } catch (error) {
    console.error('Erro ao criar notificacao:', error.message);
  }
};

module.exports = { criarNotificacao };