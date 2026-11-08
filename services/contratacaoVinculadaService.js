'use strict';

class ConflitoContratacao extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}
const exigir = (condicao, motivo = 'VINCULOS_INCONSISTENTES') => {
  if (!condicao) throw new ConflitoContratacao(motivo);
};
const id = value => value == null ? '' : String(value).toLowerCase();
const objectId = value => /^[a-f\d]{24}$/.test(id(value));
const igual = (a, b) => objectId(a) && objectId(b) && id(a) === id(b);

// Nao integrado aos controllers. O chamador futuro deve fornecer identidade autenticada
// e papel de cliente; este caso de uso verifica propriedade, nao interpreta JWT.
// Ativacao exige indices I1-I5 instalados e exclusao dos escritores antigos.
function criarContratacaoVinculadaService({ Pedido, Proposta, Servico, Agendamento, Notificacao }) {
  const models = { Pedido, Proposta, Servico, Agendamento, Notificacao };
  const connection = Pedido?.db;
  for (const [name, Model] of Object.entries(models)) {
    if (!connection || Model?.db !== connection || Model?.modelName !== name) {
      throw new TypeError('Models reais da mesma conexao devem ser fornecidos explicitamente');
    }
  }
  const opcoes = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    readPreference: 'primary', maxCommitTimeMS: 10000 };
  const evento = pedidoId => 'pedido:' + id(pedidoId) + ':proposta_aceita:v1';

  async function recuperar(pedido, solicitada, session) {
    const vinculo = pedido.contratacao;
    exigir(vinculo && objectId(vinculo.proposta_id) && objectId(vinculo.servico_id) && objectId(vinculo.agendamento_id));
    const vencedora = await Proposta.findById(vinculo.proposta_id).session(session).lean();
    exigir(vencedora && vencedora.status === 'aceita' && igual(vencedora.pedido_id, pedido._id) &&
      igual(vencedora.servico_id, vinculo.servico_id));
    const aceitas = await Proposta.countDocuments({ pedido_id: pedido._id, status: 'aceita' }).session(session);
    exigir(aceitas === 1);
    const agendas = await Agendamento.find({ $or: [{ _id: vinculo.agendamento_id },
      { pedido_id: pedido._id }, { proposta_id: vencedora._id }] }).limit(2).session(session).lean();
    exigir(agendas.length === 1);
    const agenda = agendas[0];
    exigir(igual(agenda._id, vinculo.agendamento_id) && agenda.origem === 'proposta' &&
      igual(agenda.pedido_id, pedido._id) && igual(agenda.proposta_id, vencedora._id) &&
      igual(agenda.servico_id, vinculo.servico_id) && igual(agenda.cliente_id, pedido.cliente_id) &&
      igual(agenda.prestador_id, vencedora.prestador_id));
    const notas = await Notificacao.find({ tipo: 'proposta_aceita', $or: [
      { pedido_id: pedido._id }, { evento_chave: evento(pedido._id) }
    ] }).limit(2).session(session).lean();
    exigir(notas.length === 1 && notas[0].evento_chave === evento(pedido._id) &&
      igual(notas[0].pedido_id, pedido._id) && igual(notas[0].usuario_id, vencedora.prestador_id));
    exigir(pedido.status !== 'cancelado' && agenda.status !== 'cancelado', 'CONTRATACAO_CANCELADA');
    exigir((pedido.status === 'em andamento' && ['pendente', 'confirmado'].includes(agenda.status)) ||
      (pedido.status === 'finalizado' && agenda.status === 'finalizado'));
    exigir(igual(vencedora._id, solicitada._id), 'OUTRA_PROPOSTA_VENCEDORA');
    // Nao consultar novamente o catalogo: o servico pode ter sido retirado apos o commit.
    return { proposta: vencedora, agendamento: agenda, reutilizada: true };
  }

  async function aceitarProposta({ propostaId, clienteId }) {
    if (!objectId(clienteId)) return { motivo: 'SEM_PERMISSAO' };
    if (!objectId(propostaId)) return { motivo: 'IDENTIFICADOR_INVALIDO' };
    if (connection.readyState !== 1) throw new Error('Conexao de persistencia deve estar aberta pelo chamador');
    const session = await connection.startSession();
    // Identidade/data estaveis durante retries do callback, nunca fornecidas pelo navegador.
    const agendaId = new connection.base.Types.ObjectId();
    const dataAlternativa = new Date();
    try {
      let resultado;
      await session.withTransaction(async () => {
        resultado = undefined;
        const proposta = await Proposta.findById(propostaId).session(session).lean();
        exigir(proposta, 'PROPOSTA_NAO_ENCONTRADA');
        const pedido = await Pedido.findById(proposta.pedido_id).session(session).lean();
        // Pedido removido nao permite certificar propriedade nem revelar seus vinculos.
        exigir(pedido && igual(pedido.cliente_id, clienteId), 'SEM_PERMISSAO');
        exigir(pedido.fluxo_contratacao === 1, 'PROTOCOLO_NAO_CERTIFICADO');
        if (pedido.contratacao !== undefined) {
          resultado = await recuperar(pedido, proposta, session);
          return;
        }
        exigir(pedido.status === 'aberto', 'PEDIDO_NAO_ABERTO');
        exigir(proposta.status === 'enviada', 'PROPOSTA_NAO_ENVIADA');
        exigir(proposta.servico_id === undefined);
        const aceita = await Proposta.exists({ pedido_id: pedido._id, status: 'aceita' }).session(session);
        const agendaAnterior = await Agendamento.exists({ $or: [
          { pedido_id: pedido._id }, { proposta_id: proposta._id }
        ] }).session(session);
        const notaAnterior = await Notificacao.exists({ tipo: 'proposta_aceita', $or: [
          { pedido_id: pedido._id }, { evento_chave: evento(pedido._id) }
        ] }).session(session);
        exigir(!aceita && !agendaAnterior && !notaAnterior);
        const servicos = await Servico.find({ prestador_id: proposta.prestador_id, categoria: pedido.categoria })
          .limit(2).session(session).lean();
        exigir(servicos.length > 0, 'SERVICO_NAO_ENCONTRADO');
        exigir(servicos.length === 1, 'SERVICO_AMBIGUO');
        const servico = servicos[0];
        const disputa = await Pedido.updateOne({ _id: pedido._id, cliente_id: pedido.cliente_id,
          fluxo_contratacao: 1, status: 'aberto', contratacao: { $exists: false } }, { $set: {
          status: 'em andamento', contratacao: { proposta_id: proposta._id, servico_id: servico._id, agendamento_id: agendaId }
        } }, { session });
        exigir(disputa.modifiedCount === 1, 'CONFLITO_CONTRATACAO');
        const escolha = await Proposta.updateOne({ _id: proposta._id, pedido_id: pedido._id,
          prestador_id: proposta.prestador_id, status: 'enviada', servico_id: { $exists: false } },
        { $set: { status: 'aceita', servico_id: servico._id } }, { session });
        exigir(escolha.modifiedCount === 1, 'CONFLITO_CONTRATACAO');
        await Proposta.updateMany({ pedido_id: pedido._id, _id: { $ne: proposta._id }, status: 'enviada' },
          { $set: { status: 'recusada' } }, { session });
        await Agendamento.create([{ _id: agendaId, origem: 'proposta', pedido_id: pedido._id, proposta_id: proposta._id,
          cliente_id: pedido.cliente_id, prestador_id: proposta.prestador_id, servico_id: servico._id,
          data: pedido.data_desejada || dataAlternativa, hora: '09:00', status: 'pendente' }], { session });
        // Model real, mesma sessao; erro deve abortar em vez de ser suprimido pelo helper antigo.
        await Notificacao.create([{ usuario_id: proposta.prestador_id, pedido_id: pedido._id,
          evento_chave: evento(pedido._id), mensagem: 'Sua proposta foi aceita pelo cliente',
          tipo: 'proposta_aceita', link: '/dashboard-prestador.html' }], { session });
        const confirmado = await Pedido.findById(pedido._id).session(session).lean();
        resultado = { ...await recuperar(confirmado, proposta, session), reutilizada: false };
      }, opcoes);
      // O callback pode ser repetido: seu resultado so e publicado apos withTransaction concluir.
      if (!resultado) return { motivo: 'RESULTADO_INDETERMINADO' };
      return resultado;
    } catch (error) {
      // O driver repete conflitos transitorios e commits incertos. Se esgotar, nao
      // inferir sucesso do callback nem executar outra escrita para compensar.
      if (error.hasErrorLabel?.('UnknownTransactionCommitResult')) return { motivo: 'RESULTADO_INDETERMINADO' };
      if (error instanceof ConflitoContratacao) return { motivo: error.motivo };
      if (error.code === 11000) return { motivo: 'CONFLITO_PERSISTENCIA' };
      if (error.hasErrorLabel?.('TransientTransactionError')) return { motivo: 'CONFLITO_TRANSACIONAL' };
      throw error;
    } finally {
      await session.endSession();
    }
  }

  return { aceitarProposta };
}

module.exports = { criarContratacaoVinculadaService };
