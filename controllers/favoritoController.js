const Favorito = require('../Models/favoritoModel');

exports.adicionarFavorito = async (req, res) => {
  try {
    const { prestador_id } = req.body;
    const cliente_id = req.usuarioId;

    const jaExiste = await Favorito.findOne({ cliente_id, prestador_id });
    if (jaExiste) {
      return res.status(400).json({ mensagem: 'Prestador ja esta nos favoritos' });
    }

    const favorito = await Favorito.create({ cliente_id, prestador_id });
    res.status(201).json({ mensagem: 'Adicionado aos favoritos', favorito });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao adicionar favorito', erro: error.message });
  }
};

exports.removerFavorito = async (req, res) => {
  try {
    const { id } = req.params;
    const cliente_id = req.usuarioId;

    const favorito = await Favorito.findOneAndDelete({ prestador_id: id, cliente_id });
    if (!favorito) {
      return res.status(404).json({ mensagem: 'Favorito nao encontrado' });
    }

    res.json({ mensagem: 'Removido dos favoritos' });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao remover favorito', erro: error.message });
  }
};

exports.listarFavoritos = async (req, res) => {
  try {
    const cliente_id = req.usuarioId;
    const favoritos = await Favorito.find({ cliente_id }).populate('prestador_id', 'nome telefone descricao_detalhada');
    res.json(favoritos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar favoritos', erro: error.message });
  }
};

exports.verificarFavorito = async (req, res) => {
  try {
    const { prestador_id } = req.params;
    const cliente_id = req.usuarioId;

    const favorito = await Favorito.findOne({ cliente_id, prestador_id });
    res.json({ favorito: !!favorito });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao verificar favorito', erro: error.message });
  }
};