const Favorito = require('../Models/favoritoModel');
const Usuario = require('../Models/usuarioModel');

const idValido = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

exports.adicionarFavorito = async (req, res) => {
  try {
    const { prestador_id } = req.body;
    const cliente_id = req.usuarioId;

    if (!idValido(prestador_id)) {
      return res.status(400).json({ mensagem: 'Informe um prestador valido' });
    }

    const prestador = await Usuario.findOne({ _id: prestador_id, tipo: 'prestador' }).select('_id');
    if (!prestador) {
      return res.status(404).json({ mensagem: 'Prestador nao encontrado' });
    }

    const jaExiste = await Favorito.findOne({ cliente_id, prestador_id });
    if (jaExiste) {
      return res.status(400).json({ mensagem: 'Prestador ja esta nos favoritos' });
    }

    const favorito = await Favorito.create({ cliente_id, prestador_id });
    res.status(201).json({ mensagem: 'Adicionado aos favoritos', favorito });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ mensagem: 'Prestador ja esta nos favoritos' });
    }
    res.status(500).json({ mensagem: 'Erro ao adicionar favorito' });
  }
};

exports.removerFavorito = async (req, res) => {
  try {
    const { id } = req.params;
    const cliente_id = req.usuarioId;

    if (!idValido(id)) {
      return res.status(400).json({ mensagem: 'Informe um prestador valido' });
    }

    const favorito = await Favorito.findOneAndDelete({ prestador_id: id, cliente_id });
    if (!favorito) {
      return res.status(404).json({ mensagem: 'Favorito nao encontrado' });
    }

    res.json({ mensagem: 'Removido dos favoritos' });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao remover favorito' });
  }
};

exports.listarFavoritos = async (req, res) => {
  try {
    const cliente_id = req.usuarioId;
    const favoritos = await Favorito.find({ cliente_id }).populate({
      path: 'prestador_id',
      match: { tipo: 'prestador' },
      select: 'nome tipo descricao_detalhada',
      skipInvalidIds: true
    });
    // Filtra referencias antigas sem alterar ou apagar documentos do banco.
    res.json(favoritos
      .filter(favorito => favorito.prestador_id?.tipo === 'prestador')
      .map(favorito => ({
        _id: favorito._id,
        cliente_id: favorito.cliente_id,
        data_criacao: favorito.data_criacao,
        prestador_id: {
          _id: favorito.prestador_id._id,
          nome: favorito.prestador_id.nome,
          descricao_detalhada: favorito.prestador_id.descricao_detalhada || ''
        }
      })));
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar favoritos' });
  }
};

exports.verificarFavorito = async (req, res) => {
  try {
    const { prestador_id } = req.params;
    const cliente_id = req.usuarioId;

    if (!idValido(prestador_id)) {
      return res.status(400).json({ mensagem: 'Informe um prestador valido' });
    }

    const prestador = await Usuario.findOne({ _id: prestador_id, tipo: 'prestador' }).select('_id');
    if (!prestador) {
      return res.json({ favorito: false });
    }

    const favorito = await Favorito.findOne({ cliente_id, prestador_id });
    res.json({ favorito: !!favorito });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao verificar favorito' });
  }
};
