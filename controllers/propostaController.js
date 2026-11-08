const Proposta = require('../Models/propostaModel');
const Pedido = require('../Models/pedidoModel');
const propostaService = require('../services/propostaService');
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
    const resultado = await propostaService.aceitarProposta({ propostaId: id, clienteId: req.usuarioId });

    if (resultado.motivo === 'PROPOSTA_NAO_ENCONTRADA') {
      return res.status(404).json({ mensagem: 'Proposta nao encontrada' });
    }

    if (resultado.motivo === 'SEM_PERMISSAO') {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para aceitar esta proposta' });
    }

    if (resultado.motivo === 'PEDIDO_NAO_ABERTO') {
      return res.status(409).json({ mensagem: 'Este pedido nao esta aberto para aceitar propostas' });
    }
    if (resultado.motivo === 'PROPOSTA_NAO_ENVIADA') {
      return res.status(409).json({ mensagem: 'Esta proposta nao esta disponivel para aceitacao' });
    }
    if (resultado.motivo === 'SERVICO_NAO_ENCONTRADO') {
      return res.status(409).json({ mensagem: 'Nao existe servico correspondente para aceitar esta proposta' });
    }

    const { proposta, agendamento } = resultado;
    res.json({ mensagem: 'Proposta aceita com sucesso', proposta, agendamento });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao aceitar proposta', erro: error.message });
  }
};
