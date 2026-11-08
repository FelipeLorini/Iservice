const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { disposableReplicaSet } = require('./helpers/disposableReplicaSet');

// Ensaio tecnico, nao implementacao/substituicao do service de producao.
const files = { Pedido: 'pedidoModel.js', Proposta: 'propostaModel.js', Agendamento: 'agendamentoModel.js',
  Notificacao: 'notificacaoModel.js', Servico: 'servicoModel.js' };
const candidates = [
  { name: 'I1', model: 'Agendamento', field: 'pedido_id', ref: 'Pedido' },
  { name: 'I2', model: 'Agendamento', field: 'proposta_id', ref: 'Proposta' },
  { name: 'I3', model: 'Pedido', field: 'contratacao.agendamento_id', ref: 'Agendamento' },
  { name: 'I4', model: 'Pedido', field: 'contratacao.proposta_id', ref: 'Proposta' },
  { name: 'I5', model: 'Notificacao', field: 'evento_chave' }
];
const oid = () => new mongoose.Types.ObjectId();
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const sessionId = session => session.id.id.toString('hex');
const duplicate = error => error.code === 11000;
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
  readPreference: 'primary', maxCommitTimeMS: 10000 };

function indexSpec(candidate) {
  return { key: { [candidate.field]: 1, ...(candidate.name === 'I5' ? { usuario_id: 1 } : {}) },
    options: { name: candidate.name, unique: true,
      partialFilterExpression: { [candidate.field]: { $type: candidate.name === 'I5' ? 'string' : 'objectId' } } } };
}
function setField(doc, field, value) {
  const parts = field.split('.');
  if (parts.length === 2) doc[parts[0]] = { ...doc[parts[0]], [parts[1]]: value };
  else doc[field] = value;
  return doc;
}
function barrier(parties) {
  let count = 0, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(Error('Barreira de leituras nao completou')), 10000);
  promise.catch(() => {});
  return { async wait() { if (++count === parties) { clearTimeout(timer); resolve(); } await promise; },
    close() { clearTimeout(timer); resolve(); }, get count() { return count; } };
}

test('Replica set descartavel: atomicidade, indices I1-I5 e concorrencia real', { timeout: 120000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  let replica, ready = false;
  const commands = [], collections = new Set(), sessions = [], knownSessionIds = new Set();
  const transactionalCommands = new Set(['find', 'findAndModify', 'update', 'insert']);
  const mutations = new Set(['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes',
    'drop', 'dropDatabase', 'dropIndexes', 'commitTransaction', 'abortTransaction']);
  const sessionWindows = [];
  try {
    replica = await disposableReplicaSet();
    const url = new URL(replica.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), replica.port); assert.notEqual(replica.port, 27017);
    assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(url.searchParams.get('replicaSet'), replica.setName);
    assert.equal(url.searchParams.get('directConnection'), 'true');
    assert.equal(url.pathname, '/'); assert.equal([...url.searchParams].length, 2);
    assert.match(replica.databaseName, /^iservice_tx_[a-f0-9]{32}$/);
    await replica.assertIdentity();
    await database.connect(replica.uri, { dbName: replica.databaseName, autoCreate: false, autoIndex: false,
      bufferCommands: false, monitorCommands: true, serverSelectionTimeoutMS: 3000 });
    database.connection.getClient().on('commandStarted', event => {
      if (event.databaseName === replica.databaseName || mutations.has(event.commandName)) {
        commands.push({ name: event.commandName, db: event.databaseName,
          collection: event.command[event.commandName], ready,
          session: event.command.lsid?.id.toString('hex'), transaction: event.command.autocommit === false,
          number: event.command.txnNumber?.toString() });
      }
    });
    async function assertTarget() {
      assert.equal(database.connection.host, '127.0.0.1'); assert.equal(database.connection.port, replica.port);
      assert.equal(database.connection.name, replica.databaseName); assert.equal(database.connection.readyState, 1);
      await replica.assertIdentity(database.connection.getClient());
    }
    await assertTarget();
    const models = {};
    for (const [name, file] of Object.entries(files)) {
      const filename = path.join(__dirname, '..', 'Models', file), module = { exports: {} };
      assert.equal(await fs.realpath(filename), filename);
      vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, exports: module.exports,
        require(dependency) { assert.equal(dependency, 'mongoose'); return database; }
      }, { filename });
      models[name] = module.exports;
      assert.equal(models[name].modelName, name); assert.equal(models[name].db, database.connection);
      collections.add(models[name].collection.name);
    }
    assert.equal(mongoose.connection.readyState, 0);
    assert.ok(commands.every(cmd => !mutations.has(cmd.name)));
    ready = true;
    const { Pedido, Proposta, Agendamento, Notificacao, Servico } = models;
    for (const Model of Object.values(models)) { await assertTarget(); await Model.createCollection(); }
    for (const candidate of candidates) {
      const { key, options } = indexSpec(candidate);
      await assertTarget(); await models[candidate.model].collection.createIndex(key, options);
    }
    const reader = replica.client.db(replica.databaseName); // Conexao independente, sem sessao transacional.

    async function withSession(work) {
      await assertTarget();
      const session = await database.startSession(); sessions.push(session); knownSessionIds.add(sessionId(session));
      try { return await work(session); }
      finally { await session.endSession(); assert.equal(session.hasEnded, true); }
    }
    function assertSessionCommands(start, id) {
      const operations = commands.slice(start).filter(cmd => cmd.db === replica.databaseName && transactionalCommands.has(cmd.name));
      assert.ok(operations.length > 0);
      for (const cmd of operations) {
        assert.equal(cmd.session, id); assert.equal(cmd.transaction, true); assert.ok(cmd.number !== undefined);
      }
      sessionWindows.push(operations);
      return operations;
    }
    async function fixture() {
      await assertTarget();
      const cliente = oid(), prestador = oid(), outroPrestador = oid();
      const servico = await Servico.create({ nome: 'Servico ficticio', descricao: 'Ficticio', preco: 100,
        categoria: 'faxina', prestador_id: prestador });
      const outroServico = await Servico.create({ nome: 'Outro servico ficticio', descricao: 'Ficticio', preco: 110,
        categoria: 'faxina', prestador_id: outroPrestador });
      const pedido = await Pedido.create({ cliente_id: cliente, titulo: 'Pedido ficticio', descricao: 'Ficticio',
        categoria: 'faxina', fluxo_contratacao: 1, data_desejada: new Date('2035-01-10T00:00:00Z') });
      const proposta = await Proposta.create({ pedido_id: pedido._id, prestador_id: prestador, valor: 120, prazo: 'Dois dias' });
      const outra = await Proposta.create({ pedido_id: pedido._id, prestador_id: outroPrestador, valor: 130, prazo: 'Tres dias' });
      return { cliente, pedido, proposta, outra, servico, outroServico };
    }
    async function snapshot(f) {
      const result = {};
      for (const [name, filter] of [['Pedido', { _id: f.pedido._id }], ['Proposta', { pedido_id: f.pedido._id }],
        ['Agendamento', { pedido_id: f.pedido._id }], ['Notificacao', { pedido_id: f.pedido._id }]]) {
        result[name] = plain(await reader.collection(models[name].collection.name).find(filter).sort({ _id: 1 }).toArray());
      }
      return result;
    }
    // Protocolo minimo LOCAL AO ENSAIO. Nao importado pelo sistema nem prova de suas regras de negocio.
    async function operation(f, proposal, service, agendaId, session, { afterRead, afterFirst, afterAll } = {}) {
      const selected = await Proposta.findById(proposal._id).session(session)
        .populate({ path: 'pedido_id', options: { session } });
      const pedido = selected.pedido_id;
      assert.ok(pedido.cliente_id.equals(f.cliente));
      if (afterRead) await afterRead(pedido);
      if (pedido.contratacao) {
        if (!pedido.contratacao.proposta_id.equals(proposal._id)) return { kind: 'conflito', winner: pedido.contratacao.proposta_id.toString() };
        const agenda = await Agendamento.findById(pedido.contratacao.agendamento_id).session(session);
        assert.ok(agenda && agenda.pedido_id.equals(pedido._id) && agenda.proposta_id.equals(proposal._id));
        assert.ok(agenda.servico_id.equals(pedido.contratacao.servico_id));
        return { kind: 'existente', agenda: agenda.id, winner: proposal.id };
      }
      const chosen = await Servico.findById(service._id).session(session);
      assert.ok(chosen && chosen.prestador_id.equals(selected.prestador_id));
      const claim = await Pedido.updateOne({ _id: pedido._id, cliente_id: f.cliente, fluxo_contratacao: 1,
        status: 'aberto', contratacao: { $exists: false } }, { $set: { status: 'em andamento', contratacao: {
        proposta_id: proposal._id, servico_id: service._id, agendamento_id: agendaId
      } } }, { session });
      assert.equal(claim.modifiedCount, 1);
      if (afterFirst) await afterFirst();
      const changed = await Proposta.updateOne({ _id: proposal._id, pedido_id: pedido._id, status: 'enviada' },
        { $set: { status: 'aceita', servico_id: service._id } }, { session });
      assert.equal(changed.modifiedCount, 1);
      await Proposta.updateMany({ pedido_id: pedido._id, _id: { $ne: proposal._id }, status: 'enviada' },
        { $set: { status: 'recusada' } }, { session });
      await Agendamento.create([{ _id: agendaId, origem: 'proposta', pedido_id: pedido._id, proposta_id: proposal._id,
        cliente_id: f.cliente, prestador_id: selected.prestador_id, servico_id: service._id,
        data: pedido.data_desejada, hora: '09:00' }], { session });
      await Notificacao.create([{ usuario_id: selected.prestador_id, pedido_id: pedido._id,
        evento_chave: 'pedido:' + pedido.id + ':proposta_aceita:v1', mensagem: 'Ensaio ficticio', tipo: 'proposta_aceita' }], { session });
      if (afterAll) await afterAll();
      return { kind: 'criada', agenda: agendaId.toString(), winner: proposal.id };
    }
    function assertComplete(state, proposalId, agendaId) {
      assert.equal(state.Pedido.length, 1); assert.equal(state.Agendamento.length, 1); assert.equal(state.Notificacao.length, 1);
      assert.equal(state.Pedido[0].status, 'em andamento');
      assert.equal(state.Pedido[0].contratacao.proposta_id, proposalId);
      assert.equal(state.Pedido[0].contratacao.agendamento_id, agendaId);
      assert.equal(state.Proposta.filter(p => p.status === 'aceita').length, 1);
      assert.equal(state.Proposta.find(p => p._id === proposalId).status, 'aceita');
      assert.equal(state.Proposta.find(p => p._id !== proposalId).status, 'recusada');
      assert.equal(state.Agendamento[0]._id, agendaId); assert.equal(state.Agendamento[0].proposta_id, proposalId);
      assert.equal(state.Agendamento[0].servico_id, state.Pedido[0].contratacao.servico_id);
      assert.equal(state.Notificacao[0].usuario_id, state.Agendamento[0].prestador_id);
    }

    await t.test('commit conjunto, isolamento antes do commit, recarga e consulta repetida sem escrita', async () => {
      const f = await fixture(), before = await snapshot(f), agendaId = oid();
      await withSession(async session => {
        const start = commands.length, id = sessionId(session);
        await session.withTransaction(async () => {
          await operation(f, f.proposta, f.servico, agendaId, session, { afterAll: async () => {
            assert.deepEqual(await snapshot(f), before, 'Leitor externo nao ve dados nao confirmados');
          } });
        }, transactionOptions);
        const ops = assertSessionCommands(start, id);
        assert.ok(ops.some(cmd => cmd.name === 'find') && ops.some(cmd => cmd.name === 'update') && ops.some(cmd => cmd.name === 'insert'));
      });
      const committed = await snapshot(f); assertComplete(committed, f.proposta.id, agendaId.toString());
      await withSession(async session => {
        const start = commands.length; let result;
        await session.withTransaction(async () => { result = await operation(f, f.proposta, f.servico, oid(), session); }, transactionOptions);
        assert.equal(result.kind, 'existente'); assert.equal(result.agenda, agendaId.toString());
        const ops = assertSessionCommands(start, sessionId(session));
        assert.ok(ops.every(cmd => cmd.name === 'find'), 'Reconsulta autorizada nao repete efeitos');
      });
      assert.deepEqual(await snapshot(f), committed);
    });
    for (const stage of ['afterFirst', 'afterAll']) await t.test('aborto em ' + stage + ' reverte todas as escritas reais', async () => {
      const f = await fixture(), before = await snapshot(f), failure = new Error('Falha ficticia do ensaio');
      await withSession(async session => {
        const start = commands.length;
        await assert.rejects(session.withTransaction(() => operation(f, f.proposta, f.servico, oid(), session,
          { [stage]: async () => { throw failure; } }), transactionOptions), error => error === failure);
        assertSessionCommands(start, sessionId(session));
        assert.ok(commands.slice(start).some(cmd => cmd.name === 'abortTransaction'));
      });
      assert.deepEqual(await snapshot(f), before);
    });

    await t.test('duas escritas condicionais sem transacao escolhem no maximo um vencedor no Pedido', async () => {
      const f = await fixture(), gate = barrier(2);
      async function claim(proposta) {
        const observed = await Pedido.findById(f.pedido._id).lean();
        assert.equal(observed.status, 'aberto'); assert.equal(observed.contratacao, undefined);
        await gate.wait();
        return Pedido.updateOne({ _id: f.pedido._id, status: 'aberto', contratacao: { $exists: false } },
          { $set: { status: 'em andamento', contratacao: { proposta_id: proposta._id } } });
      }
      try {
        const results = await Promise.allSettled([claim(f.proposta), claim(f.outra)]);
        assert.ok(results.every(r => r.status === 'fulfilled'));
        assert.deepEqual(results.map(r => r.value.modifiedCount).sort(), [0, 1]);
        assert.equal(gate.count, 2);
      } finally { gate.close(); }
      const state = await snapshot(f);
      assert.ok([f.proposta.id, f.outra.id].includes(state.Pedido[0].contratacao.proposta_id));
      assert.equal(state.Agendamento.length, 0); assert.equal(state.Notificacao.length, 0);
      assert.ok(state.Proposta.every(p => p.status === 'enviada')); // CAS sozinho nao garante outras colecoes.
    });

    await t.test('transacoes concorrentes com leituras sincronizadas confirmam um unico conjunto', async () => {
      const f = await fixture(), gate = barrier(2), attempts = [0, 0], ids = [], start = commands.length;
      async function attempt(index, proposta, servico) {
        const agendaId = oid();
        return withSession(async session => {
          ids.push(sessionId(session)); let result;
          await session.withTransaction(async () => {
            attempts[index]++;
            result = await operation(f, proposta, servico, agendaId, session, {
              afterRead: async pedido => {
                if (attempts[index] === 1) {
                  assert.equal(pedido.contratacao, undefined);
                  await gate.wait(); // Apenas leituras iniciais; retry nao espera uma segunda barreira.
                }
              }
            });
          }, transactionOptions);
          return result;
        });
      }
      let results;
      try {
        results = await Promise.allSettled([attempt(0, f.proposta, f.servico), attempt(1, f.outra, f.outroServico)]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        assert.equal(gate.count, 2);
      } finally { gate.close(); }
      const values = results.map(r => r.value);
      assert.deepEqual(values.map(r => r.kind).sort(), ['conflito', 'criada']);
      const winner = values.find(r => r.kind === 'criada');
      assert.equal(values.find(r => r.kind === 'conflito').winner, winner.winner);
      assert.ok(attempts.some(count => count > 1), 'Snapshot concorrente exige retry legitimo do driver');
      const ops = commands.slice(start).filter(cmd => cmd.db === replica.databaseName && transactionalCommands.has(cmd.name));
      assert.ok(ops.every(cmd => ids.includes(cmd.session) && cmd.transaction));
      const state = await snapshot(f); assertComplete(state, winner.winner, winner.agenda);
      assert.ok(commands.slice(start).some(cmd => cmd.name === 'abortTransaction'));
    });

    // Colecoes de ensaio separadas para atribuir cada erro ao indice certo, sem apagar documentos.
    // Insercoes BSON cruas sao intencionais aqui: distinguem filtro do indice de casting/validacao Mongoose.
    async function collection(name) {
      await assertTarget(); collections.add(name);
      await database.connection.db.createCollection(name);
      return database.connection.db.collection(name);
    }
    for (const candidate of candidates) await t.test(candidate.name + ': filtro, duplicidade, legados e falha de construcao', async () => {
      const { key, options } = indexSpec(candidate), col = await collection('ensaio_' + candidate.name.toLowerCase());
      const legacy = [{ _id: oid(), exemplo: 'legado ficticio' }, { _id: oid(), exemplo: 'legado ficticio' }];
      await col.insertMany(legacy);
      assert.equal(await col.createIndex(key, options), candidate.name);
      const index = (await col.indexes()).find(i => i.name === candidate.name);
      assert.deepEqual(index.key, key); assert.equal(index.unique, true);
      assert.deepEqual(index.partialFilterExpression, options.partialFilterExpression);
      for (const row of legacy) assert.deepEqual(plain(await col.findOne({ _id: row._id })), plain(row));
      const value = candidate.name === 'I5' ? 'pedido:' + oid() + ':proposta_aceita:v1' : oid();
      const owner = oid();
      const row = () => setField({ _id: oid(), usuario_id: owner }, candidate.field, value);
      const first = row(); await col.insertOne(first);
      await assert.rejects(col.insertOne(row()), duplicate);
      if (candidate.name !== 'I5') {
        for (const status of ['cancelado', 'finalizado']) {
          await col.updateOne({ _id: first._id }, { $set: { status } });
          await assert.rejects(col.insertOne(row()), duplicate);
        }
        // O ObjectId pode apontar para nada: indice nao e chave estrangeira.
        assert.equal(await models[candidate.ref].countDocuments({ _id: value }), 0);
      } else {
        await col.updateOne({ _id: first._id }, { $set: { lida: true } });
        await assert.rejects(col.insertOne(row()), duplicate);
        const otherUser = row(); otherUser.usuario_id = oid(); await col.insertOne(otherUser);
        const empty = () => setField({ _id: oid(), usuario_id: owner }, candidate.field, '');
        await col.insertOne(empty()); await assert.rejects(col.insertOne(empty()), duplicate);
      }
      for (const outside of [undefined, null, candidate.name === 'I5' ? 42 : 'objectid-invalido']) {
        const rows = [0, 1].map(() => {
          const doc = { _id: oid(), usuario_id: owner };
          return outside === undefined ? doc : setField(doc, candidate.field, outside);
        });
        await col.insertMany(rows); // Ambos passam fora do filtro; nao e protecao para novos escritores incompletos.
        assert.equal(await col.countDocuments({ _id: { $in: rows.map(r => r._id) } }), 2);
      }
      const dirty = await collection('duplicidades_' + candidate.name.toLowerCase());
      const duplicates = [row(), row()]; await dirty.insertMany(duplicates);
      await assert.rejects(dirty.createIndex(key, options), duplicate);
      assert.equal(await dirty.countDocuments(), 2);
      assert.ok(!(await dirty.indexes()).some(i => i.name === candidate.name));
    });

    await t.test('Models reais preservam legados, incompletos e referencias inexistentes sob os indices', async () => {
      const oldPedido = { _id: oid(), cliente_id: oid(), titulo: 'Legado ficticio', descricao: 'Ficticio', categoria: 'faxina', status: 'aberto' };
      const partial = { ...oldPedido, _id: oid(), contratacao: { servico_id: oid() } };
      const agenda = { cliente_id: oid(), prestador_id: oid(), servico_id: oid(), data: new Date('2030-01-01'), hora: '09:00' };
      const notification = { usuario_id: oid(), mensagem: 'Legado ficticio', tipo: 'proposta_aceita' };
      await Pedido.collection.insertMany([oldPedido, partial]);
      for (const row of [oldPedido, partial]) {
        const hydrated = await Pedido.findById(row._id); await hydrated.validate(); await hydrated.save();
        const saved = await Pedido.collection.findOne({ _id: row._id });
        assert.equal(Object.hasOwn(saved, 'fluxo_contratacao'), false);
        assert.deepEqual(plain(saved.contratacao), plain(row.contratacao));
      }
      const agendas = await Agendamento.create([agenda, agenda]);
      const notes = await Notificacao.create([notification, notification]);
      for (const a of agendas) {
        const saved = await Agendamento.findById(a._id).lean();
        for (const field of ['origem', 'pedido_id', 'proposta_id']) assert.equal(Object.hasOwn(saved, field), false);
      }
      for (const n of notes) assert.equal(Object.hasOwn(await Notificacao.findById(n._id).lean(), 'evento_chave'), false);
      const orphan = await Agendamento.create({ ...agenda, origem: 'proposta', pedido_id: oid(), proposta_id: oid() });
      assert.equal(await Pedido.countDocuments({ _id: orphan.pedido_id }), 0);
      assert.equal(await Proposta.countDocuments({ _id: orphan.proposta_id }), 0);
      // Os schemas continuam sem os indices candidatos; criacao foi exclusiva da fixture.
      for (const Model of [Pedido, Agendamento, Notificacao]) assert.deepEqual(Model.schema.indexes(), []);
      assert.equal(Proposta.schema.indexes().length, 1);
    });
    assert.ok(sessionWindows.length >= 4);
    assert.ok(sessions.length >= 6 && sessions.every(session => session.hasEnded));
    await assertTarget();
  } finally {
    const results = await Promise.allSettled(sessions.filter(s => !s.hasEnded).map(s => s.endSession()));
    results.push(...await Promise.allSettled([database.disconnect()]));
    if (replica) { try { await replica.cleanup(); } catch (error) { results.push({ status: 'rejected', reason: error }); } }
    assert.ok(results.every(result => result.status === 'fulfilled'), 'Limpeza completa obrigatoria');
    assert.equal(database.connection.readyState, 0); assert.equal(mongoose.connection.readyState, 0);
    assert.ok(sessions.every(session => session.hasEnded));
    if (replica) {
      assert.throws(() => process.kill(replica.pid, 0), error => error.code === 'ESRCH');
      assert.ok(await fs.access(replica.directory).then(() => false, error => error.code === 'ENOENT'));
      const writes = commands.filter(cmd => mutations.has(cmd.name));
      assert.ok(writes.every(cmd => cmd.ready && (['commitTransaction', 'abortTransaction'].includes(cmd.name)
        ? cmd.db === 'admin' && cmd.transaction && knownSessionIds.has(cmd.session)
        : cmd.db === replica.databaseName && collections.has(cmd.collection) &&
          ['create', 'createIndexes', 'insert', 'update', 'findAndModify'].includes(cmd.name))),
      'Mutacoes apenas no banco/colecoes temporarios e sessoes do ensaio');
    }
  }
});
