const Proposta = require('../Models/propostaModel');
const Pedido = require('../Models/pedidoModel');
const Agendamento = require('../Models/agendamentoModel');
const Servico = require('../Models/servicoModel');
const { criarNotificacao } = require('../utils/notificacaoHelper');

exports.criarProposta = async (req, res) => {
  try {
    const { pedido_id, valor, prazo, descricao } = req.body;
    const prestador_id = req.usuarioId;

    const pedido = await Pedido.findById(pedido_id);
    if (!pedido) {
      return res.status(404).json({ mensagem: 'Pedido nao encontrado' });
    }
    if (pedido.status !== 'aberto') {
      return res.status(400).json({ mensagem: 'Este pedido nao esta mais aberto para propostas' });
    }

    const propostaExistente = await Proposta.findOne({ pedido_id, prestador_id });
    if (propostaExistente) {
      return res.status(400).json({ mensagem: 'Voce ja enviou uma proposta para este pedido' });
    }

    const proposta = await Proposta.create({
      pedido_id,
      prestador_id,
      valor,
      prazo,
      descricao
    });

    await criarNotificacao(
      pedido.cliente_id,
      'Voce recebeu uma nova proposta para o seu pedido',
      'nova_proposta',
      '/dashboard-cliente.html'
    );

    res.status(201).json({ mensagem: 'Proposta enviada com sucesso', proposta });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao criar proposta', erro: error.message });
  }
};

exports.listarPropostas = async (req, res) => {
  try {
    const { id } = req.params;
    const pedido = await Pedido.findById(id);
    if (!pedido) {
      return res.status(404).json({ mensagem: 'Pedido nao encontrado' });
    }
    if (pedido.cliente_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para ver estas propostas' });
    }

    const propostas = await Proposta.find({ pedido_id: id })
      .populate('prestador_id', 'nome telefone')
      .sort({ data_criacao: -1 });
    res.json(propostas);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar propostas', erro: error.message });
  }
};

exports.listarPropostasPrestador = async (req, res) => {
  try {
    const prestador_id = req.usuarioId;
    const propostas = await Proposta.find({ prestador_id })
      .populate('pedido_id')
      .sort({ data_criacao: -1 });
    res.json(propostas);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar propostas', erro: error.message });
  }
};

exports.aceitarProposta = async (req, res) => {
  try {
    const { id } = req.params;
    const proposta = await Proposta.findById(id).populate('pedido_id');

    if (!proposta) {
      return res.status(404).json({ mensagem: 'Proposta nao encontrada' });
    }

    const pedido = proposta.pedido_id;
    if (pedido.cliente_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para aceitar esta proposta' });
    }

    proposta.status = 'aceita';
    await proposta.save();

    pedido.status = 'em andamento';
    await pedido.save();

    await Proposta.updateMany(
      { pedido_id: pedido._id, _id: { $ne: proposta._id } },
      { status: 'recusada' }
    );

    let servico = await Servico.findOne({ prestador_id: proposta.prestador_id, categoria: pedido.categoria });
    let agendamento = null;
    if (servico) {
      agendamento = await Agendamento.create({
        cliente_id: pedido.cliente_id,
        prestador_id: proposta.prestador_id,
        servico_id: servico._id,
        data: pedido.data_desejada || new Date(),
        hora: '09:00',
        status: 'pendente'
      });
    }

    await criarNotificacao(
      proposta.prestador_id,
      'Sua proposta foi aceita pelo cliente',
      'proposta_aceita',
      '/dashboard-prestador.html'
    );

    res.json({ mensagem: 'Proposta aceita com sucesso', proposta, agendamento });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao aceitar proposta', erro: error.message });
  }
};