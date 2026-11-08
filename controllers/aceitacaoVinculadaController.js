'use strict';

// Adaptador ainda nao montado na aplicacao. Mantem o envelope de tres chaves;
// replay usa mensagem distinta, sem indicador publico reutilizada.
const respostas = Object.freeze({
  PROPOSTA_NAO_ENCONTRADA: [404, 'Proposta nao encontrada'],
  IDENTIFICADOR_INVALIDO: [400, 'Identificador de proposta invalido'],
  SEM_PERMISSAO: [403, 'Voce nao tem permissao para aceitar esta proposta'],
  PEDIDO_NAO_ABERTO: [409, 'Este pedido nao esta aberto para aceitar propostas'],
  PROPOSTA_NAO_ENVIADA: [409, 'Esta proposta nao esta disponivel para aceitacao'],
  SERVICO_NAO_ENCONTRADO: [409, 'Nao existe servico correspondente para aceitar esta proposta'],
  SERVICO_AMBIGUO: [409, 'Nao foi possivel determinar qual servico contratar'],
  PROTOCOLO_NAO_CERTIFICADO: [409, 'Este pedido precisa de revisao antes da contratacao'],
  VINCULOS_INCONSISTENTES: [409, 'Os dados desta contratacao precisam de revisao'],
  CONTRATACAO_CANCELADA: [409, 'Esta contratacao foi cancelada'],
  OUTRA_PROPOSTA_VENCEDORA: [409, 'Outra proposta ja foi aceita para este pedido'],
  CONFLITO_CONTRATACAO: [409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  CONFLITO_PERSISTENCIA: [409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  CONFLITO_TRANSACIONAL: [409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  RESULTADO_INDETERMINADO: [503, 'Nao foi possivel confirmar o resultado da aceitacao. Consulte sua contratacao antes de tentar novamente']
});

// Projecao proposta somente para este adaptador: exclui novos metadados de
// coordenacao e campos extras. A rota antiga continua com sua serializacao atual.
function projetar(documento, campos, referencias) {
  const resultado = {};
  for (const campo of campos) {
    if (documento[campo] !== undefined) {
      const valor = documento[campo];
      // Referencias populadas nao devem expor documentos inteiros por acidente.
      resultado[campo] = referencias.includes(campo) && valor != null
        ? String(valor._id ?? valor) : valor;
    }
  }
  return resultado;
}

function criarAceitacaoVinculadaController(service) {
  if (typeof service?.aceitarProposta !== 'function') throw new TypeError('Service de aceitacao obrigatorio');
  async function aceitarProposta(req, res) {
    try {
      const resultado = await service.aceitarProposta({ propostaId: req.params.id, clienteId: req.usuarioId });
      if (resultado?.motivo !== undefined) {
        const resposta = Object.hasOwn(respostas, resultado.motivo) ? respostas[resultado.motivo] : null;
        if (!resposta) throw new Error('Resultado de service desconhecido');
        return res.status(resposta[0]).json({ mensagem: resposta[1] });
      }
      if (!resultado?.proposta?._id || !resultado?.agendamento?._id || typeof resultado.reutilizada !== 'boolean') {
        throw new Error('Resultado de service incompleto');
      }
      return res.status(200).json({
        mensagem: resultado.reutilizada ? 'Contratacao existente recuperada com sucesso' : 'Proposta aceita com sucesso',
        proposta: projetar(resultado.proposta,
          ['_id', 'pedido_id', 'prestador_id', 'valor', 'prazo', 'descricao', 'status', 'data_criacao', '__v'],
          ['_id', 'pedido_id', 'prestador_id']),
        agendamento: projetar(resultado.agendamento,
          ['_id', 'cliente_id', 'prestador_id', 'servico_id', 'data', 'hora', 'status', 'data_criacao', '__v'],
          ['_id', 'cliente_id', 'prestador_id', 'servico_id'])
      });
    } catch {
      return res.status(500).json({ mensagem: 'Erro ao aceitar proposta' });
    }
  }
  return { aceitarProposta };
}

module.exports = { criarAceitacaoVinculadaController };
