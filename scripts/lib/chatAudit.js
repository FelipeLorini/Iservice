'use strict';

// Usa agregacoes fixas no driver nativo: nao importa modelos, servidor ou .env.
// Nao existem operacoes de escrita nem estagios $out/$merge nesta ferramenta.
const CHAT_FLAGS = [
  'participantes_formato_invalido', 'participantes_quantidade_invalida',
  'participantes_id_invalido', 'participantes_tipo_bson_incorreto', 'participantes_repetidos',
  'participantes_usuario_ausente', 'pair_key_ausente', 'pair_key_invalida',
  'pair_key_divergente', 'pair_key_nao_verificavel', 'historico_formato_invalido',
  'historico_inconsistente', 'par_duplicado', 'chave_armazenada_repetida'
];
const MESSAGE_FLAGS = [
  'estrutura_invalida', 'id_invalido', 'tipo_bson_incorreto',
  'remetente_igual_destinatario', 'fora_dos_participantes', 'usuario_ausente',
  'conteudo_invalido', 'par_nao_verificavel'
];
const TOTAL_FIELDS = [
  'c_total', 'c_com_achados', 'c_inativas', 'm_total', 'm_inconsistentes', 'r_participantes_ausentes',
  ...CHAT_FLAGS.map(flag => 'c_' + flag), ...MESSAGE_FLAGS.map(flag => 'm_' + flag)
];
// Mesmo conjunto de espacos removido por String.prototype.trim(), inclusive BOM.
const TRIM_CHARS = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const count = condition => ({ $sum: { $cond: [condition, 1, 0] } });
const filteredCount = (input, as, cond) => ({ $size: { $filter: { input, as, cond } } });
const safeArray = value => ({ $cond: [{ $isArray: value }, value, []] });
const nonNull = value => ({ $ne: [value, null] });
const any = expressions => ({ $or: expressions });

function normalizedId(value) {
  return { $switch: { branches: [
    { case: { $eq: [{ $type: value }, 'objectId'] }, then: { $toString: value } },
    { case: { $eq: [{ $type: value }, 'string'] }, then: {
      $cond: [{ $and: [
        { $eq: [{ $strLenCP: value }, 24] },
        { $regexMatch: { input: value, regex: '^[a-fA-F0-9]{24}$' } }
      ] }, { $toLower: value }, null]
    } }
  ], default: null } };
}

function duplicateSummary(field) {
  return [
    { $match: { [field]: { $ne: null } } },
    { $group: { _id: '$' + field, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, grupos: { $sum: 1 }, excedentes: { $sum: { $subtract: ['$n', 1] } } } },
    { $project: { _id: 0, grupos: 1, excedentes: 1 } }
  ];
}

function buildAuditPipeline() {
  const p0 = { $arrayElemAt: ['$pids', 0] }, p1 = { $arrayElemAt: ['$pids', 1] };
  const validPair = { $and: [
    { $eq: [{ $size: '$pids' }, 2] }, { $eq: [{ $size: '$validPids' }, 2] }, { $ne: [p0, p1] }
  ] };
  const messageFlags = {
    estrutura_invalida: { $ne: ['$$m.type', 'object'] },
    id_invalido: any([{ $eq: ['$$m.sender', null] }, { $eq: ['$$m.receiver', null] }]),
    tipo_bson_incorreto: any([{ $ne: ['$$m.senderType', 'objectId'] }, { $ne: ['$$m.receiverType', 'objectId'] }]),
    remetente_igual_destinatario: { $and: [nonNull('$$m.sender'), { $eq: ['$$m.sender', '$$m.receiver'] }] },
    fora_dos_participantes: { $and: [nonNull('$canonical'), any([
      { $and: [nonNull('$$m.sender'), { $not: [{ $in: ['$$m.sender', '$validPids'] }] }] },
      { $and: [nonNull('$$m.receiver'), { $not: [{ $in: ['$$m.receiver', '$validPids'] }] }] }
    ])] },
    usuario_ausente: any([{ $in: ['$$m.sender', '$missingIds'] }, { $in: ['$$m.receiver', '$missingIds'] }]),
    conteudo_invalido: { $not: ['$$m.contentValid'] },
    par_nao_verificavel: { $eq: ['$canonical', null] }
  };
  const flags = {
    participantes_formato_invalido: { $not: ['$participantsIsArray'] },
    participantes_quantidade_invalida: { $ne: [{ $size: '$pids' }, 2] },
    participantes_id_invalido: { $ne: [{ $size: '$pids' }, { $size: '$validPids' }] },
    participantes_tipo_bson_incorreto: { $gt: ['$badParticipantTypes', 0] },
    participantes_repetidos: { $ne: [{ $size: '$validPids' }, { $size: { $setUnion: ['$validPids', []] } }] },
    participantes_usuario_ausente: { $gt: ['$missingParticipants', 0] },
    pair_key_ausente: { $not: ['$keyPresent'] },
    pair_key_invalida: { $and: ['$keyPresent', { $not: ['$keyValid'] }] },
    pair_key_divergente: { $and: [nonNull('$canonical'), nonNull('$storedKey'), { $ne: ['$storedKey', '$canonical'] }] },
    pair_key_nao_verificavel: { $and: ['$keyPresent', { $eq: ['$canonical', null] }] },
    historico_formato_invalido: { $not: ['$messagesIsArray'] },
    historico_inconsistente: any([{ $not: ['$messagesIsArray'] }, { $gt: ['$badMessages', 0] }]),
    par_duplicado: { $and: [nonNull('$canonical'), { $gt: ['$pairCount', 1] }] },
    chave_armazenada_repetida: { $and: [nonNull('$storedKey'), { $gt: ['$storedKeyCount', 1] }] }
  };
  const totals = {
    _id: null, c_total: { $sum: 1 }, c_com_achados: count(any(Object.values(flags))),
    c_inativas: count('$inactive'), m_total: { $sum: { $size: '$messages' } },
    m_inconsistentes: { $sum: '$badMessages' }, r_participantes_ausentes: { $sum: '$missingParticipants' }
  };
  for (const flag of CHAT_FLAGS) totals['c_' + flag] = count(flags[flag]);
  for (const flag of MESSAGE_FLAGS) totals['m_' + flag] = { $sum: filteredCount('$messageFlags', 'm', '$$m.' + flag) };

  return [
    { $project: {
      _id: 0, participants: safeArray('$participants'), participantsIsArray: { $isArray: '$participants' },
      messagesIsArray: { $isArray: '$messages' },
      keyPresent: { $ne: [{ $type: '$pairKey' }, 'missing'] },
      storedKey: { $cond: [{ $eq: [{ $type: '$pairKey' }, 'string'] }, '$pairKey', null] },
      inactive: { $eq: ['$isActive', false] },
      // So tipos, IDs internos e flags continuam no pipeline. Conteudo nunca sai do servidor.
      messages: { $map: { input: safeArray('$messages'), as: 'm', in: {
        type: { $type: '$$m' }, sender: normalizedId('$$m.sender'), receiver: normalizedId('$$m.receiver'),
        senderType: { $type: '$$m.sender' }, receiverType: { $type: '$$m.receiver' },
        contentValid: { $cond: [{ $eq: [{ $type: '$$m.content' }, 'string'] },
          { $gt: [{ $strLenCP: { $trim: { input: '$$m.content', chars: TRIM_CHARS } } }, 0] }, false] }
      } } }
    } },
    { $set: {
      pids: { $map: { input: '$participants', as: 'p', in: normalizedId('$$p') } },
      badParticipantTypes: filteredCount('$participants', 'p', { $ne: [{ $type: '$$p' }, 'objectId'] })
    } },
    { $set: { validPids: { $filter: { input: '$pids', as: 'p', cond: nonNull('$$p') } } } },
    { $set: {
      canonical: { $cond: [validPair, { $cond: [{ $lt: [p0, p1] }, { $concat: [p0, ':', p1] }, { $concat: [p1, ':', p0] }] }, null] },
      referenceIds: { $setDifference: [{ $setUnion: ['$validPids', '$messages.sender', '$messages.receiver'] }, [null]] },
      keyValid: { $cond: [nonNull('$storedKey'), { $and: [
        { $eq: [{ $strLenCP: '$storedKey' }, 49] },
        { $regexMatch: { input: '$storedKey', regex: '^[a-f0-9]{24}:[a-f0-9]{24}$' } },
        { $lt: [{ $substrCP: ['$storedKey', 0, 24] }, { $substrCP: ['$storedKey', 25, 24] }] }
      ] }, false] }
    } },
    { $set: { lookupIds: { $map: { input: '$referenceIds', as: 'id', in: { $toObjectId: '$$id' } } } } },
    { $lookup: { from: 'usuarios', localField: 'lookupIds', foreignField: '_id', pipeline: [{ $project: { _id: 1 } }], as: 'existingUsers' } },
    { $set: { missingIds: { $setDifference: ['$referenceIds', { $map: { input: '$existingUsers', as: 'u', in: { $toString: '$$u._id' } } }] } } },
    { $set: {
      missingParticipants: filteredCount('$validPids', 'p', { $in: ['$$p', '$missingIds'] }),
      messageFlags: { $map: { input: '$messages', as: 'm', in: messageFlags } }
    } },
    { $set: { badMessages: filteredCount('$messageFlags', 'm', any(MESSAGE_FLAGS.map(flag => '$$m.' + flag))) } },
    { $setWindowFields: { partitionBy: '$canonical', output: { pairCount: { $sum: 1, window: { documents: ['unbounded', 'unbounded'] } } } } },
    { $setWindowFields: { partitionBy: '$storedKey', output: { storedKeyCount: { $sum: 1, window: { documents: ['unbounded', 'unbounded'] } } } } },
    { $facet: {
      totals: [{ $group: totals }, { $project: { _id: 0 } }],
      pairs: duplicateSummary('canonical'), keys: duplicateSummary('storedKey')
    } },
    // $group nao emite linha para entrada vazia. Somente essa condicao conhecida
    // recebe zeros explicitos NO servidor; o cliente nunca completa campos ausentes.
    { $project: Object.fromEntries([
      ['totals', Object.fromEntries(TOTAL_FIELDS.map(field => [field, 0]))],
      ['pairs', { grupos: 0, excedentes: 0 }], ['keys', { grupos: 0, excedentes: 0 }]
    ].map(([field, empty]) => [field, { $cond: [
      { $eq: [{ $size: '$' + field }, 0] }, { $literal: [empty] }, '$' + field
    ] }])) }
  ];
}

class AuditError extends Error {
  constructor(code) { super(code); this.name = 'AuditError'; this.code = code; }
}

function validateAuditResult(rows) {
  const invalid = () => { throw new AuditError('AUDIT_INVALID_RESULT'); };
  function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Reflect.ownKeys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) invalid();
  }
  function counters(value, fields) {
    record(value, fields);
    if (!fields.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0 && !Object.is(value[field], -0))) invalid();
  }
  if (!Array.isArray(rows) || rows.length !== 1) invalid();
  record(rows[0], ['totals', 'pairs', 'keys']);
  for (const field of ['totals', 'pairs', 'keys']) {
    if (!Array.isArray(rows[0][field]) || rows[0][field].length !== 1) invalid();
  }
  const t = rows[0].totals[0], p = rows[0].pairs[0], k = rows[0].keys[0];
  counters(t, TOTAL_FIELDS); counters(p, ['grupos', 'excedentes']); counters(k, ['grupos', 'excedentes']);
  const ensure = condition => { if (!condition) invalid(); };
  const sum = values => values.reduce((n, value) => n + BigInt(value), 0n);
  ensure(t.c_com_achados <= t.c_total && t.c_inativas <= t.c_total);
  for (const flag of CHAT_FLAGS) ensure(t['c_' + flag] <= t.c_com_achados);
  ensure(BigInt(t.c_com_achados) <= sum(CHAT_FLAGS.map(flag => t['c_' + flag])));
  ensure(t.m_inconsistentes <= t.m_total);
  for (const flag of MESSAGE_FLAGS) ensure(t['m_' + flag] <= t.m_inconsistentes);
  ensure(BigInt(t.m_inconsistentes) <= sum(MESSAGE_FLAGS.map(flag => t['m_' + flag])));
  ensure(t.c_participantes_formato_invalido <= t.c_participantes_quantidade_invalida);
  ensure(t.c_participantes_id_invalido <= t.c_participantes_tipo_bson_incorreto);
  ensure(sum([t.c_pair_key_ausente, t.c_pair_key_invalida]) <= BigInt(t.c_total));
  ensure(sum([t.c_pair_key_ausente, t.c_pair_key_divergente, t.c_pair_key_nao_verificavel]) <= BigInt(t.c_total));
  ensure(t.c_historico_formato_invalido <= t.c_historico_inconsistente);
  const badArrayHistories = t.c_historico_inconsistente - t.c_historico_formato_invalido;
  ensure(badArrayHistories <= t.m_inconsistentes && (badArrayHistories === 0) === (t.m_inconsistentes === 0));
  ensure(t.c_participantes_usuario_ausente <= t.r_participantes_ausentes);
  ensure((t.c_participantes_usuario_ausente === 0) === (t.r_participantes_ausentes === 0));
  if (t.c_total === t.c_historico_formato_invalido) ensure(t.m_total === 0);
  if (t.c_participantes_quantidade_invalida + t.c_participantes_id_invalido + t.c_participantes_repetidos === 0) {
    ensure(t.m_par_nao_verificavel === 0 && t.c_pair_key_nao_verificavel === 0);
  }
  function duplicates(summary, documents) {
    ensure((summary.grupos === 0) === (summary.excedentes === 0));
    ensure(summary.excedentes >= summary.grupos);
    ensure(sum([summary.grupos, summary.excedentes]) === BigInt(documents));
  }
  duplicates(p, t.c_par_duplicado); duplicates(k, t.c_chave_armazenada_repetida);
  ensure(t.c_par_duplicado <= t.c_total - t.c_participantes_quantidade_invalida);
  ensure(t.c_par_duplicado <= t.c_total - t.c_participantes_id_invalido);
  ensure(t.c_par_duplicado <= t.c_total - t.c_participantes_repetidos);
  ensure(t.c_chave_armazenada_repetida <= t.c_total - t.c_pair_key_ausente);
  if (t.c_total === 0) ensure(TOTAL_FIELDS.every(field => t[field] === 0));
  return { totals: t, pairs: p, keys: k };
}

async function auditChats(db, { maxTimeMS = 30000 } = {}) {
  if (!Number.isSafeInteger(maxTimeMS) || maxTimeMS < 1 || maxTimeMS > 300000) throw new AuditError('AUDIT_INVALID_OPTIONS');
  try {
    const collections = await db.listCollections({ name: { $in: ['chats', 'usuarios'] } }, { nameOnly: true, maxTimeMS }).toArray();
    if (!['chats', 'usuarios'].every(name => collections.some(c => c.name === name))) throw new AuditError('AUDIT_COLLECTIONS_REQUIRED');
    const rows = await db.collection('chats').aggregate(buildAuditPipeline(), {
      allowDiskUse: false, maxTimeMS, collation: { locale: 'simple' }, readConcern: { level: 'majority' },
      comment: 'iservice-chat-audit-readonly-v1'
    }).toArray();
    const { totals, pairs, keys } = validateAuditResult(rows);
    const report = {
      versao: 1, somente_leitura: true, consistencia: 'sem_snapshot',
      conversas: { total: totals.c_total, com_achados: totals.c_com_achados, inativas: totals.c_inativas },
      mensagens: { total: totals.m_total, inconsistentes: totals.m_inconsistentes },
      referencias: { participantes_ausentes: totals.r_participantes_ausentes },
      pares: { grupos_duplicados: pairs.grupos, conversas_excedentes: pairs.excedentes,
        grupos_chaves_repetidas: keys.grupos, chaves_excedentes: keys.excedentes }
    };
    for (const flag of CHAT_FLAGS) report.conversas[flag] = totals['c_' + flag];
    for (const flag of MESSAGE_FLAGS) report.mensagens[flag] = totals['m_' + flag];
    return report;
  } catch (error) {
    // Nao propagar mensagem/stack do driver, URI, chave duplicada ou documento.
    if (error instanceof AuditError) throw error;
    throw new AuditError('AUDIT_READ_FAILED');
  }
}

module.exports = { auditChats, buildAuditPipeline, validateAuditResult, TOTAL_FIELDS, CHAT_FLAGS, MESSAGE_FLAGS, AuditError };
