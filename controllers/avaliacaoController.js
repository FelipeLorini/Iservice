const Avaliacao = require('../Models/avaliacaoModel');
const Agendamento = require('../Models/agendamentoModel');
const { criarNotificacao } = require('../utils/notificacaoHelper');

exports.criarAvaliacao = async (req, res) => {
  try {
    const { agendamento_id, nota, comentario } = req.body;
    const cliente_id = req.usuarioId;

    if (typeof agendamento_id !== 'string' || !/^[a-f\d]{24}$/i.test(agendamento_id)) {
      return res.status(400).json({ mensagem: 'Informe um agendamento valido' });
    }

    if (!Number.isFinite(nota) || nota < 1 || nota > 5) {
      return res.status(400).json({ mensagem: 'A nota deve ser entre 1 e 5' });
    }

    const agendamento = await Agendamento.findById(agendamento_id);
    if (!agendamento) {
      return res.status(404).json({ mensagem: 'Agendamento nao encontrado' });
    }
    if (!agendamento.cliente_id) {
      return res.status(409).json({ mensagem: 'Este agendamento possui dados incompletos e nao pode ser avaliado' });
    }
    if (agendamento.cliente_id.toString() !== cliente_id) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para avaliar este agendamento' });
    }
    // Os IDs historicos devem estar presentes; o servico pode ter sido excluido.
    if (!agendamento.prestador_id || !agendamento.servico_id) {
      return res.status(409).json({ mensagem: 'Este agendamento possui dados incompletos e nao pode ser avaliado' });
    }
    if (agendamento.status !== 'finalizado') {
      return res.status(400).json({ mensagem: 'So e possivel avaliar servicos finalizados' });
    }
    const jaAvaliado = await Avaliacao.findOne({ agendamento_id });
    if (jaAvaliado) {
      return res.status(400).json({ mensagem: 'Este agendamento ja foi avaliado', codigo: 'AVALIACAO_DUPLICADA' });
    }

    const { prestador_id, servico_id } = agendamento;
    const avaliacao = await Avaliacao.create({
      cliente_id,
      prestador_id,
      servico_id,
      agendamento_id,
      nota,
      comentario
    });

    await criarNotificacao(
      prestador_id,
      'Voce recebeu uma nova avaliacao',
      'avaliacao',
      '/perfil_prestador.html'
    );

    res.status(201).json({ mensagem: 'Avaliacao registrada com sucesso', avaliacao });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ mensagem: 'Este agendamento ja foi avaliado', codigo: 'AVALIACAO_DUPLICADA' });
    }
    res.status(500).json({ mensagem: 'Erro ao criar avaliacao' });
  }
};

exports.listarAvaliacoesCliente = async (req, res) => {
  try {
    const avaliacoes = await Avaliacao.find({ cliente_id: req.usuarioId })
      .select('agendamento_id')
      .lean();

    res.json({
      total: avaliacoes.length,
      agendamentos_avaliados: [...new Set(avaliacoes
        .filter(avaliacao => avaliacao.agendamento_id)
        .map(avaliacao => avaliacao.agendamento_id.toString()))]
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao consultar suas avaliacoes' });
  }
};

exports.listarAvaliacoesPorPrestador = async (req, res) => {
  try {
    const { id } = req.params;
    const avaliacoes = await Avaliacao.find({ prestador_id: id })
      .populate('cliente_id', 'nome')
      .sort({ data_criacao: -1 });
    res.json(avaliacoes);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar avaliacoes', erro: error.message });
  }
};

exports.calcularMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await Avaliacao.aggregate([
      { $match: { prestador_id: new (require('mongoose').Types.ObjectId)(id) } },
      { $group: { _id: '$prestador_id', media: { $avg: '$nota' }, total: { $sum: 1 } } }
    ]);

    if (resultado.length === 0) {
      return res.json({ media: 0, total: 0 });
    }

    res.json({ media: Math.round(resultado[0].media * 10) / 10, total: resultado[0].total });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao calcular media', erro: error.message });
  }
};
