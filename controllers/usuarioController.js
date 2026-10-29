const Usuario = require('../Models/usuarioModel');

const estaOnline = (ultimo_login) => {
  if (!ultimo_login) return false;
  const cincoMinutos = 5 * 60 * 1000;
  return (Date.now() - new Date(ultimo_login).getTime()) < cincoMinutos;
};

exports.obterPerfilPublico = async (req, res) => {
  try {
    const { id } = req.params;
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ mensagem: 'Informe um usuario valido' });
    }

    const usuario = await Usuario.findById(id).select('nome tipo descricao_detalhada portifolio ultimo_login');

    if (!usuario || usuario.tipo !== 'prestador') {
      return res.status(404).json({ mensagem: 'Usuario nao encontrado' });
    }

    res.json({
      id: usuario._id,
      nome: usuario.nome,
      tipo: usuario.tipo,
      descricao_detalhada: usuario.descricao_detalhada || '',
      portifolio: usuario.portifolio || [],
      online: estaOnline(usuario.ultimo_login)
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao obter perfil' });
  }
};

exports.atualizarPortifolio = async (req, res) => {
  try {
    const { portifolio, descricao_detalhada } = req.body;
    const usuario = await Usuario.findById(req.usuarioId);

    if (!usuario) {
      return res.status(404).json({ mensagem: 'Usuario nao encontrado' });
    }

    if (Array.isArray(portifolio)) {
      usuario.portifolio = portifolio;
    }
    if (descricao_detalhada !== undefined) {
      usuario.descricao_detalhada = descricao_detalhada;
    }

    await usuario.save();

    res.json({ mensagem: 'Portifolio atualizado com sucesso', portifolio: usuario.portifolio, descricao_detalhada: usuario.descricao_detalhada });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao atualizar portifolio', erro: error.message });
  }
};
