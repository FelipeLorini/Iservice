const Proposta = require('../Models/propostaModel');
const Agendamento = require('../Models/agendamentoModel');
const Servico = require('../Models/servicoModel');
const { criarNotificacao } = require('../utils/notificacaoHelper');

exports.aceitarProposta = async ({ propostaId, clienteId }) => {
  const proposta = await Proposta.findById(propostaId).populate('pedido_id');

  if (!proposta) {
    return { motivo: 'PROPOSTA_NAO_ENCONTRADA' };
  }

  const pedido = proposta.pedido_id;
  if (pedido.cliente_id.toString() !== clienteId) {
    return { motivo: 'SEM_PERMISSAO' };
  }

  // Guardas de leitura da primeira aceitacao; nao garantem exclusao concorrente.
  if (pedido.status !== 'aberto') {
    return { motivo: 'PEDIDO_NAO_ABERTO' };
  }
  if (proposta.status !== 'enviada') {
    return { motivo: 'PROPOSTA_NAO_ENVIADA' };
  }

  const servico = await Servico.findOne({ prestador_id: proposta.prestador_id, categoria: pedido.categoria });
  if (!servico) {
    return { motivo: 'SERVICO_NAO_ENCONTRADO' };
  }

  proposta.status = 'aceita';
  await proposta.save();

  pedido.status = 'em andamento';
  await pedido.save();

  await Proposta.updateMany(
    { pedido_id: pedido._id, _id: { $ne: proposta._id } },
    { status: 'recusada' }
  );

  const agendamento = await Agendamento.create({
    cliente_id: pedido.cliente_id,
    prestador_id: proposta.prestador_id,
    servico_id: servico._id,
    data: pedido.data_desejada || new Date(),
    hora: '09:00',
    status: 'pendente'
  });

  await criarNotificacao(
    proposta.prestador_id,
    'Sua proposta foi aceita pelo cliente',
    'proposta_aceita',
    '/dashboard-prestador.html'
  );

  return { proposta, agendamento };
};
