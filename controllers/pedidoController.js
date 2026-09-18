const Pedido = require('../Models/pedidoModel');

exports.criarPedido = async (req, res) => {
  try {
    const { titulo, descricao, categoria, data_desejada } = req.body;
    const cliente_id = req.usuarioId;

    const pedido = await Pedido.create({
      cliente_id,
      titulo,
      descricao,
      categoria,
      data_desejada
    });

    res.status(201).json({ mensagem: 'Pedido criado com sucesso', pedido });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao criar pedido', erro: error.message });
  }
};

exports.listarPedidosCliente = async (req, res) => {
  try {
    const cliente_id = req.usuarioId;
    const pedidos = await Pedido.find({ cliente_id }).sort({ data_criacao: -1 });
    res.json(pedidos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar pedidos', erro: error.message });
  }
};

exports.listarPedidosAbertos = async (req, res) => {
  try {
    const filtro = { status: 'aberto' };
    if (req.query.categoria) {
      filtro.categoria = req.query.categoria;
    }
    const pedidos = await Pedido.find(filtro)
      .populate('cliente_id', 'nome')
      .sort({ data_criacao: -1 });
    res.json(pedidos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar pedidos abertos', erro: error.message });
  }
};

exports.cancelarPedido = async (req, res) => {
  try {
    const { id } = req.params;
    const pedido = await Pedido.findById(id);

    if (!pedido) {
      return res.status(404).json({ mensagem: 'Pedido nao encontrado' });
    }
    if (pedido.cliente_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para cancelar este pedido' });
    }

    pedido.status = 'cancelado';
    await pedido.save();

    res.json({ mensagem: 'Pedido cancelado com sucesso', pedido });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao cancelar pedido', erro: error.message });
  }
};