const Servico = require('../Models/servicoModel');

const servicoPublico = (servico) => ({
  _id: servico._id,
  nome: servico.nome,
  descricao: servico.descricao,
  preco: servico.preco,
  categoria: servico.categoria,
  data_criacao: servico.data_criacao,
  prestador_id: servico.prestador_id ? {
    _id: servico.prestador_id._id,
    nome: servico.prestador_id.nome
  } : null
});

exports.listarServicos = async (req, res) => {
  try {
    const servicos = await Servico.find().populate('prestador_id', 'nome');
    res.json(servicos.map(servicoPublico));
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar servicos' });
  }
};

exports.listarServicosPorCategoria = async (req, res) => {
  try {
    const { categoria } = req.params;
    const servicos = await Servico.find({ categoria }).populate('prestador_id', 'nome');
    res.json(servicos.map(servicoPublico));
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar servicos' });
  }
};

exports.cadastrarServico = async (req, res) => {
  try {
    const { nome, descricao, preco, categoria } = req.body;
    const prestador_id = req.usuarioId;

    const servico = await Servico.create({
      nome,
      descricao,
      preco,
      categoria,
      prestador_id
    });

    res.status(201).json({
      mensagem: 'Servico cadastrado com sucesso',
      servico
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao cadastrar servico', erro: error.message });
  }
};

exports.listarServicosPorPrestador = async (req, res) => {
  try {
    const prestador_id = req.usuarioId;
    const servicos = await Servico.find({ prestador_id });
    res.json(servicos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar servicos', erro: error.message });
  }
};

exports.deletarServico = async (req, res) => {
  try {
    const { id } = req.params;
    const servico = await Servico.findById(id);

    if (!servico) {
      return res.status(404).json({ mensagem: 'Servico nao encontrado' });
    }

    if (servico.prestador_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para deletar este servico' });
    }

    await servico.deleteOne();
    res.json({ mensagem: 'Servico deletado com sucesso' });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao deletar servico', erro: error.message });
  }
};
