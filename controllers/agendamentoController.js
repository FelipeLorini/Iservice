const Agendamento = require('../Models/agendamentoModel');
const Servico = require('../Models/servicoModel');

exports.agendarServico = async (req, res) => {
  try {
    const { servico_id, data, hora } = req.body;
    const cliente_id = req.usuarioId;

    const servico = await Servico.findById(servico_id);
    if (!servico) {
      return res.status(404).json({ mensagem: 'Servico nao encontrado' });
    }

    const agendamentoExistente = await Agendamento.findOne({
      prestador_id: servico.prestador_id,
      data,
      hora,
      status: { $in: ['pendente', 'confirmado'] }
    });

    if (agendamentoExistente) {
      return res.status(400).json({ mensagem: 'Horario indisponivel para este prestador' });
    }

    const agendamento = await Agendamento.create({
      cliente_id,
      prestador_id: servico.prestador_id,
      servico_id,
      data,
      hora
    });

    res.status(201).json({
      mensagem: 'Servico agendado com sucesso',
      agendamento
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao agendar servico', erro: error.message });
  }
};

exports.listarAgendamentosCliente = async (req, res) => {
  try {
    const cliente_id = req.usuarioId;
    const agendamentos = await Agendamento.find({ cliente_id })
      .populate('prestador_id', 'nome telefone')
      .populate('servico_id', 'nome preco');
    res.json(agendamentos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar agendamentos', erro: error.message });
  }
};

exports.listarAgendamentosPrestador = async (req, res) => {
  try {
    const prestador_id = req.usuarioId;
    const agendamentos = await Agendamento.find({ prestador_id })
      .populate('cliente_id', 'nome telefone')
      .populate('servico_id', 'nome preco');
    res.json(agendamentos);
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao listar agendamentos', erro: error.message });
  }
};

exports.atualizarStatusAgendamento = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const agendamento = await Agendamento.findById(id);
    if (!agendamento) {
      return res.status(404).json({ mensagem: 'Agendamento nao encontrado' });
    }

    if (agendamento.prestador_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para alterar este agendamento' });
    }

    agendamento.status = status;
    await agendamento.save();

    res.json({
      mensagem: 'Status atualizado com sucesso',
      agendamento
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao atualizar status', erro: error.message });
  }
};

exports.cancelarAgendamento = async (req, res) => {
  try {
    const { id } = req.params;

    const agendamento = await Agendamento.findById(id);
    if (!agendamento) {
      return res.status(404).json({ mensagem: 'Agendamento nao encontrado' });
    }

    if (agendamento.cliente_id.toString() !== req.usuarioId) {
      return res.status(403).json({ mensagem: 'Voce nao tem permissao para cancelar este agendamento' });
    }

    agendamento.status = 'cancelado';
    await agendamento.save();

    res.json({
      mensagem: 'Agendamento cancelado com sucesso',
      agendamento
    });
  } catch (error) {
    res.status(500).json({ mensagem: 'Erro ao cancelar agendamento', erro: error.message });
  }
};