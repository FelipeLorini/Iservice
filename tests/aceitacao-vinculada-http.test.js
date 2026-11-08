const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { createRouteLoader, loadController } = require('./helpers/httpApp');
const { disposableReplicaSet } = require('./helpers/disposableReplicaSet');
const { criarContratacaoVinculadaService } = require('../services/contratacaoVinculadaService');

const secret = 'segredo-ficticio-http-vinculado';
const cliente = '111111111111111111111111', propostaId = '222222222222222222222222';
const agendaId = '333333333333333333333333';
const endpoint = id => '/api/propostas/' + id + '/aceitar';
const headers = (id = cliente, tipo = 'cliente') => ({ Authorization: 'Bearer ' + jwt.sign({ id, tipo }, secret, { expiresIn: 60 }) });
const plain = value => JSON.parse(JSON.stringify(value));

async function start(t, service) {
  const { auth, verificarCliente } = createRouteLoader({ controllers: {}, secret })('middleware/auth.js');
  const { criarAceitacaoVinculadaController } = loadController('controllers/aceitacaoVinculadaController.js', {}, { secret });
  const adapter = criarAceitacaoVinculadaController(service);
  const app = express(), router = express.Router();
  app.use(express.json());
  // Router exclusivo desta fixture. Nenhum Router ativo ou src/app.js e substituido/modificado.
  router.put('/:id/aceitar', auth, verificarCliente, adapter.aceitarProposta);
  app.use('/api/propostas', router);
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return async (id = propostaId, actor = headers(), body, method = 'PUT') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + endpoint(id), {
      method, headers: { ...actor, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    return { status: response.status, type: response.headers.get('content-type'), text,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : undefined };
  };
}
function json(response, status, body) {
  assert.equal(response.status, status); assert.match(response.type, /^application\/json/);
  if (body !== undefined) assert.deepEqual(response.body, body);
  return response.body;
}

// Expectativas explicitas, independentes do mapa do adaptador e dos motivos extraidos do service.
const mappings = [
  ['PROPOSTA_NAO_ENCONTRADA', 404, 'Proposta nao encontrada'],
  ['IDENTIFICADOR_INVALIDO', 400, 'Identificador de proposta invalido'],
  ['SEM_PERMISSAO', 403, 'Voce nao tem permissao para aceitar esta proposta'],
  ['PEDIDO_NAO_ABERTO', 409, 'Este pedido nao esta aberto para aceitar propostas'],
  ['PROPOSTA_NAO_ENVIADA', 409, 'Esta proposta nao esta disponivel para aceitacao'],
  ['SERVICO_NAO_ENCONTRADO', 409, 'Nao existe servico correspondente para aceitar esta proposta'],
  ['SERVICO_AMBIGUO', 409, 'Nao foi possivel determinar qual servico contratar'],
  ['PROTOCOLO_NAO_CERTIFICADO', 409, 'Este pedido precisa de revisao antes da contratacao'],
  ['VINCULOS_INCONSISTENTES', 409, 'Os dados desta contratacao precisam de revisao'],
  ['CONTRATACAO_CANCELADA', 409, 'Esta contratacao foi cancelada'],
  ['OUTRA_PROPOSTA_VENCEDORA', 409, 'Outra proposta ja foi aceita para este pedido'],
  ['CONFLITO_CONTRATACAO', 409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  ['CONFLITO_PERSISTENCIA', 409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  ['CONFLITO_TRANSACIONAL', 409, 'Nao foi possivel concluir a aceitacao. Consulte o estado do pedido'],
  ['RESULTADO_INDETERMINADO', 503, 'Nao foi possivel confirmar o resultado da aceitacao. Consulte sua contratacao antes de tentar novamente']
];
for (const [motivo, status, mensagem] of mappings) test('HTTP isolado mapeia ' + motivo, async t => {
  const received = [];
  const request = await start(t, { async aceitarProposta(args) {
    received.push(plain(args)); return { motivo, erro: 'detalhe-interno-ficticio', proposta: { privada: true } };
  } });
  json(await request(), status, { mensagem });
  assert.deepEqual(received, [{ propostaId, clienteId: cliente }]);
});

test('HTTP preserva envelope e usa identidade JWT/URL, sem metadados extras ou mensagem de nova criacao no replay', async t => {
  const received = [], proposal = { _id: propostaId, pedido_id: { _id: '444444444444444444444444', privado: 'nao-expor' },
    prestador_id: '555555555555555555555555', valor: 123, prazo: 'Dois dias', status: 'aceita', servico_id: 'extra', detalheInterno: 'nao-expor' };
  const agenda = { _id: agendaId, cliente_id: cliente, prestador_id: proposal.prestador_id, servico_id: '666666666666666666666666',
    data: '2035-05-20T00:00:00.000Z', hora: '09:00', status: 'pendente', origem: 'proposta', pedido_id: 'extra', proposta_id: propostaId, segredo: 'nao-expor' };
  const request = await start(t, { async aceitarProposta(args) {
    received.push(plain(args)); return { proposta: proposal, agendamento: agenda, reutilizada: received.length > 1, sessao: 'nao-expor' };
  } });
  const first = json(await request(propostaId, headers(), { clienteId: 'forjado', usuarioId: 'forjado', propostaId: 'forjado' }), 200);
  assert.deepEqual(Object.keys(first).sort(), ['agendamento', 'mensagem', 'proposta']);
  assert.equal(first.mensagem, 'Proposta aceita com sucesso');
  assert.deepEqual(first.proposta, { _id: propostaId, pedido_id: '444444444444444444444444', prestador_id: proposal.prestador_id,
    valor: 123, prazo: 'Dois dias', status: 'aceita' });
  assert.deepEqual(first.agendamento, { _id: agendaId, cliente_id: cliente, prestador_id: proposal.prestador_id,
    servico_id: agenda.servico_id, data: agenda.data, hora: '09:00', status: 'pendente' });
  const replay = json(await request(), 200);
  assert.deepEqual(replay, { ...first, mensagem: 'Contratacao existente recuperada com sucesso' });
  assert.doesNotMatch(JSON.stringify(replay), /nao-expor|criado|reutilizada|detalheInterno/);
  assert.deepEqual(received, [0, 1].map(() => ({ propostaId, clienteId: cliente })));
  assert.equal(proposal.detalheInterno, 'nao-expor'); // Projecao nao modifica dados do service.
});

for (const [label, actor, status, mensagem] of [
  ['sem token', {}, 401, 'Acesso negado. Token nao fornecido'],
  ['token invalido', { Authorization: 'Bearer invalido-ficticio' }, 401, 'Token invalido ou expirado'],
  ['prestador', headers(cliente, 'prestador'), 403, 'Acesso negado. Apenas clientes podem realizar esta acao']
]) test('middleware real: ' + label + ' nao chama o service', async t => {
  let calls = 0;
  const request = await start(t, { async aceitarProposta() { calls++; throw Error('Nao deve executar'); } });
  json(await request(propostaId, actor), status, { mensagem }); assert.equal(calls, 0);
});

for (const variant of ['excecao', 'motivo desconhecido', 'resultado incompleto']) test('HTTP 500 sanitizado: ' + variant, async t => {
  const request = await start(t, { async aceitarProposta() {
    if (variant === 'excecao') throw Error('E11000 indice interno sessao stack detalhe-ficticio');
    return variant === 'motivo desconhecido' ? { motivo: 'MOTIVO_INTERNO_FICTICIO' } : { proposta: {}, agendamento: null, reutilizada: false };
  } });
  json(await request(), 500, { mensagem: 'Erro ao aceitar proposta' });
});

test('HTTP com service e Models reais no replica set descartavel', { timeout: 90000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  let replica, ready = false, restoreSessions;
  const sessions = [], writes = [], collections = new Set();
  const mutations = new Set(['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'dropIndexes']);
  try {
    replica = await disposableReplicaSet();
    const url = new URL(replica.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), replica.port); assert.notEqual(replica.port, 27017);
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.pathname, '/');
    assert.deepEqual(Object.fromEntries(url.searchParams), { replicaSet: replica.setName, directConnection: 'true' });
    assert.match(replica.databaseName, /^iservice_tx_[a-f0-9]{32}$/);
    await replica.assertIdentity();
    await database.connect(replica.uri, { dbName: replica.databaseName, autoCreate: false, autoIndex: false,
      bufferCommands: false, monitorCommands: true, serverSelectionTimeoutMS: 3000 });
    database.connection.getClient().on('commandStarted', event => {
      if (mutations.has(event.commandName)) writes.push({ name: event.commandName, db: event.databaseName,
        collection: event.command[event.commandName], ready });
    });
    async function assertTarget() {
      assert.equal(database.connection.host, '127.0.0.1'); assert.equal(database.connection.port, replica.port);
      assert.equal(database.connection.name, replica.databaseName); assert.equal(database.connection.readyState, 1);
      await replica.assertIdentity(database.connection.getClient());
    }
    await assertTarget();
    const models = {}, files = { Pedido: 'pedidoModel.js', Proposta: 'propostaModel.js', Servico: 'servicoModel.js',
      Agendamento: 'agendamentoModel.js', Notificacao: 'notificacaoModel.js' };
    for (const [name, file] of Object.entries(files)) {
      const filename = path.join(__dirname, '..', 'Models', file), module = { exports: {} };
      assert.equal(await fs.realpath(filename), filename);
      vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, exports: module.exports,
        require(dependency) { assert.equal(dependency, 'mongoose'); return database; }
      }, { filename });
      models[name] = module.exports; assert.equal(models[name].db, database.connection);
      assert.equal(models[name].modelName, name); collections.add(models[name].collection.name);
    }
    assert.equal(writes.length, 0); assert.equal(mongoose.connection.readyState, 0); ready = true;
    const { Pedido, Proposta, Servico, Agendamento, Notificacao } = models;
    for (const Model of Object.values(models)) { await assertTarget(); await Model.createCollection(); }
    for (const [Model, field, name] of [[Agendamento, 'pedido_id', 'I1'], [Agendamento, 'proposta_id', 'I2'],
      [Pedido, 'contratacao.agendamento_id', 'I3'], [Pedido, 'contratacao.proposta_id', 'I4'], [Notificacao, 'evento_chave', 'I5']]) {
      await assertTarget(); await Model.collection.createIndex({ [field]: 1, ...(name === 'I5' ? { usuario_id: 1 } : {}) },
        { name, unique: true, partialFilterExpression: { [field]: { $type: name === 'I5' ? 'string' : 'objectId' } } });
    }
    const originalStart = database.connection.startSession, descriptor = Object.getOwnPropertyDescriptor(database.connection, 'startSession');
    database.connection.startSession = async function (...args) { const s = await originalStart.apply(this, args); sessions.push(s); return s; };
    restoreSessions = () => descriptor ? Object.defineProperty(database.connection, 'startSession', descriptor) : delete database.connection.startSession;
    const service = criarContratacaoVinculadaService(models), oid = () => new mongoose.Types.ObjectId();
    async function fixture({ certificado = true, servicos = 1, pedidoStatus = 'aberto', propostaStatus = 'enviada' } = {}) {
      await assertTarget(); const owner = oid(), provider = oid();
      for (let i = 0; i < servicos; i++) await Servico.create({ nome: 'Servico ficticio', descricao: 'Ficticio',
        preco: 100 + i, categoria: 'faxina', prestador_id: provider });
      const pedido = await Pedido.create({ cliente_id: owner, titulo: 'Pedido ficticio', descricao: 'Ficticio', categoria: 'faxina',
        data_desejada: new Date('2035-05-20T00:00:00Z'), status: pedidoStatus, ...(certificado ? { fluxo_contratacao: 1 } : {}) });
      const proposta = await Proposta.create({ pedido_id: pedido._id, prestador_id: provider, valor: 120, prazo: 'Dois dias', status: propostaStatus });
      return { owner, provider, pedido, proposta };
    }
    async function snapshot(f) {
      return plain({ pedido: await Pedido.findById(f.pedido._id).lean(), propostas: await Proposta.find({ pedido_id: f.pedido._id }).lean(),
        agendas: await Agendamento.find({ cliente_id: f.owner }).lean(), notas: await Notificacao.find({ usuario_id: f.provider }).lean() });
    }
    await t.test('servidor HTTP isolado usa identidade JWT e transacao reais', async t => {
      const request = await start(t, service);
      await t.test('primeira aceitacao e replay mantem IDs, projecao e unica persistencia', async () => {
        const f = await fixture(), first = json(await request(f.proposta.id, headers(f.owner.toString()), { clienteId: oid().toString() }), 200);
        assert.equal(first.mensagem, 'Proposta aceita com sucesso');
        assert.deepEqual(Object.keys(first).sort(), ['agendamento', 'mensagem', 'proposta']);
        assert.equal(first.agendamento.cliente_id, f.owner.toString());
        assert.equal(first.proposta._id, f.proposta.id); assert.equal(first.proposta.pedido_id, f.pedido.id);
        assert.equal(Object.hasOwn(first.proposta, 'servico_id'), false);
        for (const key of ['pedido_id', 'proposta_id', 'origem']) assert.equal(Object.hasOwn(first.agendamento, key), false);
        const before = await snapshot(f), previousWrites = writes.length;
        assert.ok(before.pedido.contratacao); assert.equal(before.agendas.length, 1); assert.equal(before.notas.length, 1);
        const replay = json(await request(f.proposta.id, headers(f.owner.toString())), 200);
        assert.deepEqual(replay, { ...first, mensagem: 'Contratacao existente recuperada com sucesso' });
        assert.equal(writes.length, previousWrites); assert.deepEqual(await snapshot(f), before);
      });
      await t.test('outra conta nao pode forjar cliente no body nem conhecer conflito privado', async () => {
        const f = await fixture({ certificado: false, pedidoStatus: 'cancelado', servicos: 0 }), before = await snapshot(f), count = writes.length;
        json(await request(f.proposta.id, headers(oid().toString()), { clienteId: f.owner.toString() }), 403,
          { mensagem: 'Voce nao tem permissao para aceitar esta proposta' });
        assert.equal(writes.length, count); assert.deepEqual(await snapshot(f), before);
      });
      await t.test('404 e 400 reais nao escrevem', async () => {
        const count = writes.length;
        json(await request(oid().toString()), 404, { mensagem: 'Proposta nao encontrada' });
        json(await request('malformado'), 400, { mensagem: 'Identificador de proposta invalido' });
        assert.equal(writes.length, count);
      });
      for (const [label, options, mensagem] of [
        ['legado', { certificado: false }, 'Este pedido precisa de revisao antes da contratacao'],
        ['sem servico', { servicos: 0 }, 'Nao existe servico correspondente para aceitar esta proposta'],
        ['ambiguo', { servicos: 2 }, 'Nao foi possivel determinar qual servico contratar'],
        ['pedido fechado', { pedidoStatus: 'cancelado' }, 'Este pedido nao esta aberto para aceitar propostas'],
        ['proposta recusada', { propostaStatus: 'recusada' }, 'Esta proposta nao esta disponivel para aceitacao']
      ]) await t.test('409 real: ' + label, async () => {
        const f = await fixture(options), before = await snapshot(f), count = writes.length;
        json(await request(f.proposta.id, headers(f.owner.toString())), 409, { mensagem });
        assert.equal(writes.length, count); assert.deepEqual(await snapshot(f), before);
      });
      await t.test('outra vencedora, cancelamento e vinculo parcial retornam 409 sem recriar', async () => {
        const f = await fixture(); json(await request(f.proposta.id, headers(f.owner.toString())), 200);
        const outra = await Proposta.create({ pedido_id: f.pedido._id, prestador_id: oid(), valor: 130, prazo: 'Tres dias' });
        let count = writes.length;
        json(await request(outra.id, headers(f.owner.toString())), 409, { mensagem: 'Outra proposta ja foi aceita para este pedido' });
        assert.equal(writes.length, count);
        await Pedido.updateOne({ _id: f.pedido._id }, { $set: { status: 'cancelado' } });
        await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { status: 'cancelado' } }); count = writes.length;
        json(await request(f.proposta.id, headers(f.owner.toString())), 409, { mensagem: 'Esta contratacao foi cancelada' });
        assert.equal(writes.length, count);
        const partial = await fixture(); await Pedido.updateOne({ _id: partial.pedido._id }, { $set: { contratacao: { proposta_id: partial.proposta._id } } });
        const before = await snapshot(partial); count = writes.length;
        json(await request(partial.proposta.id, headers(partial.owner.toString())), 409, { mensagem: 'Os dados desta contratacao precisam de revisao' });
        assert.equal(writes.length, count); assert.deepEqual(await snapshot(partial), before);
      });
      await t.test('falha apos escrita real da notificacao retorna 500 sanitizado e aborta', async () => {
        const f = await fixture(), before = await snapshot(f), original = Notificacao.create;
        const descriptor = Object.getOwnPropertyDescriptor(Notificacao, 'create');
        Notificacao.create = async function (...args) { await original.apply(this, args); throw Error('Detalhe interno ficticio de persistencia'); };
        try { json(await request(f.proposta.id, headers(f.owner.toString())), 500, { mensagem: 'Erro ao aceitar proposta' }); }
        finally { descriptor ? Object.defineProperty(Notificacao, 'create', descriptor) : delete Notificacao.create; }
        assert.deepEqual(await snapshot(f), before);
      });
    }); // Fecha HTTP antes da conexao MongoDB.
    assert.ok(sessions.every(s => s.hasEnded)); await assertTarget();
  } finally {
    if (restoreSessions) restoreSessions();
    const results = await Promise.allSettled(sessions.filter(s => !s.hasEnded).map(s => s.endSession()));
    results.push(...await Promise.allSettled([database.disconnect()]));
    if (replica) { try { await replica.cleanup(); } catch (error) { results.push({ status: 'rejected', reason: error }); } }
    assert.ok(results.every(r => r.status === 'fulfilled'), 'Limpeza integral obrigatoria');
    assert.equal(database.connection.readyState, 0); assert.equal(mongoose.connection.readyState, 0);
    assert.ok(sessions.every(s => s.hasEnded));
    if (replica) {
      assert.throws(() => process.kill(replica.pid, 0), error => error.code === 'ESRCH');
      assert.ok(await fs.access(replica.directory).then(() => false, error => error.code === 'ENOENT'));
      assert.ok(writes.every(cmd => cmd.ready && cmd.db === replica.databaseName && collections.has(cmd.collection) &&
        ['create', 'createIndexes', 'insert', 'update'].includes(cmd.name)), 'Escritas apenas nas fixtures descartaveis');
    }
  }
});
