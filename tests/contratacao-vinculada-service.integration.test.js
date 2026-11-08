const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { disposableReplicaSet } = require('./helpers/disposableReplicaSet');
const { criarContratacaoVinculadaService } = require('../services/contratacaoVinculadaService');

const files = { Pedido: 'pedidoModel.js', Proposta: 'propostaModel.js', Servico: 'servicoModel.js',
  Agendamento: 'agendamentoModel.js', Notificacao: 'notificacaoModel.js' };
const oid = () => new mongoose.Types.ObjectId();
const plain = value => JSON.parse(JSON.stringify(value));
const writeNames = new Set(['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'dropIndexes']);
const dataNames = new Set(['find', 'aggregate', 'getMore', 'insert', 'update', 'findAndModify']);

// Interceptacoes somente nas instancias isoladas. As operacoes anteriores a falha sao reais.
function replace(target, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  target[key] = value;
  return () => descriptor ? Object.defineProperty(target, key, descriptor) : delete target[key];
}

test('service vinculado real em replica set descartavel, sem ativacao HTTP', { timeout: 150000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  let replica, ready = false, restoreSessions;
  const commands = [], collections = new Set(), sessions = [], sessionIds = new Set();
  try {
    replica = await disposableReplicaSet();
    const url = new URL(replica.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), replica.port); assert.notEqual(replica.port, 27017);
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.pathname, '/');
    assert.deepEqual(Object.fromEntries(url.searchParams), { replicaSet: replica.setName, directConnection: 'true' });
    assert.match(replica.databaseName, /^iservice_tx_[a-f0-9]{32}$/);
    await replica.assertIdentity();
    const connectionOptions = { dbName: replica.databaseName, autoCreate: false, autoIndex: false,
      bufferCommands: false, monitorCommands: true, serverSelectionTimeoutMS: 3000 };
    function monitor() {
      database.connection.getClient().on('commandStarted', event => {
        if (event.databaseName === replica.databaseName || ['commitTransaction', 'abortTransaction'].includes(event.commandName)) {
          commands.push({ name: event.commandName, db: event.databaseName, collection: event.command[event.commandName],
            session: event.command.lsid?.id.toString('hex'), transaction: event.command.autocommit === false, ready });
        }
      });
    }
    async function assertTarget() {
      assert.equal(database.connection.host, '127.0.0.1'); assert.equal(database.connection.port, replica.port);
      assert.equal(database.connection.name, replica.databaseName); assert.equal(database.connection.readyState, 1);
      await replica.assertIdentity(database.connection.getClient());
    }
    await database.connect(replica.uri, connectionOptions); monitor(); await assertTarget();
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
    assert.equal(mongoose.connection.readyState, 0); assert.ok(commands.every(cmd => !writeNames.has(cmd.name)));
    ready = true;
    const { Pedido, Proposta, Servico, Agendamento, Notificacao } = models;
    for (const Model of Object.values(models)) { await assertTarget(); await Model.createCollection(); }
    // Candidatos criados exclusivamente nas colecoes temporarias. Nenhum schema e modificado.
    for (const [Model, field, name] of [[Agendamento, 'pedido_id', 'I1'], [Agendamento, 'proposta_id', 'I2'],
      [Pedido, 'contratacao.agendamento_id', 'I3'], [Pedido, 'contratacao.proposta_id', 'I4'], [Notificacao, 'evento_chave', 'I5']]) {
      await assertTarget();
      await Model.collection.createIndex({ [field]: 1, ...(name === 'I5' ? { usuario_id: 1 } : {}) }, {
        name, unique: true, partialFilterExpression: { [field]: { $type: name === 'I5' ? 'string' : 'objectId' } }
      });
    }
    const startSession = database.connection.startSession;
    restoreSessions = replace(database.connection, 'startSession', async function (...args) {
      const session = await startSession.apply(this, args);
      sessions.push(session); sessionIds.add(session.id.id.toString('hex')); return session;
    });
    const service = criarContratacaoVinculadaService(models);
    const reader = replica.client.db(replica.databaseName);
    async function snapshot(f) {
      const state = {};
      for (const [name, filter] of [['Pedido', { _id: f.pedido._id }], ['Proposta', { pedido_id: f.pedido._id }],
        ['Agendamento', { cliente_id: f.cliente }], ['Notificacao', { usuario_id: { $in: [f.prestador, f.outroPrestador] } }]]) {
        state[name] = plain(await reader.collection(models[name].collection.name).find(filter).sort({ _id: 1 }).toArray());
      }
      return state;
    }
    async function fixture({ servicos = 1, pedidoStatus = 'aberto', propostaStatus = 'enviada', certificado = true } = {}) {
      await assertTarget();
      const cliente = oid(), prestador = oid(), outroPrestador = oid(), services = [];
      for (let i = 0; i < servicos; i++) services.push(await Servico.create({ prestador_id: prestador,
        nome: 'Servico ficticio ' + i, descricao: 'Ficticio', categoria: 'faxina', preco: 100 + i }));
      const outroServico = await Servico.create({ prestador_id: outroPrestador, nome: 'Outro servico ficticio',
        descricao: 'Ficticio', categoria: 'faxina', preco: 150 });
      const pedido = await Pedido.create({ cliente_id: cliente, titulo: 'Pedido ficticio', descricao: 'Ficticio', categoria: 'faxina',
        data_desejada: new Date('2035-05-20T00:00:00Z'), status: pedidoStatus, ...(certificado ? { fluxo_contratacao: 1 } : {}) });
      const proposta = await Proposta.create({ pedido_id: pedido._id, prestador_id: prestador, valor: 123, prazo: 'Dois dias', status: propostaStatus });
      const outra = await Proposta.create({ pedido_id: pedido._id, prestador_id: outroPrestador, valor: 157, prazo: 'Tres dias' });
      return { cliente, prestador, outroPrestador, pedido, proposta, outra, servico: services[0], outroServico };
    }
    function input(f, proposta = f.proposta, cliente = f.cliente) { return { propostaId: proposta.id, clienteId: cliente.toString() }; }
    async function call(f, proposta = f.proposta, cliente = f.cliente) {
      await assertTarget(); const start = commands.length;
      const result = await service.aceitarProposta(input(f, proposta, cliente));
      const operations = commands.slice(start).filter(cmd => dataNames.has(cmd.name));
      assert.ok(operations.every(cmd => cmd.transaction && sessionIds.has(cmd.session)), 'Cada leitura/escrita do service usa sessao');
      assert.ok(sessions.every(s => s.hasEnded), 'Service encerra todas as sessoes');
      return { result, operations };
    }
    function complete(state, proposalId) {
      const pedido = state.Pedido[0], winner = state.Proposta.find(p => p._id === proposalId), agenda = state.Agendamento[0], note = state.Notificacao[0];
      assert.equal(state.Agendamento.length, 1); assert.equal(state.Notificacao.length, 1);
      assert.equal(state.Proposta.filter(p => p.status === 'aceita').length, 1);
      assert.equal(pedido.contratacao.proposta_id, proposalId); assert.equal(pedido.contratacao.servico_id, winner.servico_id);
      assert.equal(pedido.contratacao.agendamento_id, agenda._id); assert.equal(agenda.pedido_id, pedido._id);
      assert.equal(agenda.proposta_id, winner._id); assert.equal(agenda.servico_id, winner.servico_id);
      assert.equal(agenda.cliente_id, pedido.cliente_id); assert.equal(agenda.prestador_id, winner.prestador_id);
      assert.equal(agenda.origem, 'proposta'); assert.equal(note.pedido_id, pedido._id);
      assert.equal(note.evento_chave, 'pedido:' + pedido._id + ':proposta_aceita:v1'); assert.equal(note.usuario_id, winner.prestador_id);
    }
    async function unchanged(f, motivo, proposta = f.proposta, cliente = f.cliente) {
      const before = await snapshot(f), { result, operations } = await call(f, proposta, cliente);
      assert.deepEqual(result, { motivo });
      assert.ok(operations.every(cmd => !writeNames.has(cmd.name)), 'Conflito anterior a qualquer escrita');
      assert.deepEqual(await snapshot(f), before);
    }

    await t.test('primeira aceitacao preserva termos, cria vinculos completos e recusa somente enviadas', async () => {
      const f = await fixture();
      const recusada = await Proposta.create({ pedido_id: f.pedido._id, prestador_id: oid(), valor: 200, prazo: 'Quatro dias', status: 'recusada' });
      const before = plain(await Proposta.findById(recusada._id));
      const { result } = await call(f);
      assert.equal(result.reutilizada, false); assert.equal(result.proposta.valor, 123); assert.equal(result.proposta.prazo, 'Dois dias');
      assert.equal(result.agendamento.hora, '09:00'); assert.equal(result.agendamento.data.toISOString(), '2035-05-20T00:00:00.000Z');
      const state = await snapshot(f); complete(state, f.proposta.id);
      assert.equal(state.Pedido[0].status, 'em andamento'); assert.equal(state.Agendamento[0].status, 'pendente');
      assert.equal(state.Proposta.find(p => p._id === f.outra.id).status, 'recusada');
      assert.deepEqual(plain(await Proposta.findById(recusada._id)), before);
    });
    await t.test('replay sem escrita ou nova escolha de servico/data, inclusive apos reconectar', async () => {
      const f = await fixture(); await call(f);
      await Servico.updateOne({ _id: f.servico._id }, { $set: { categoria: 'pintura' } });
      await Pedido.updateOne({ _id: f.pedido._id }, { $set: { data_desejada: new Date('2040-01-01') } });
      await Notificacao.updateOne({ pedido_id: f.pedido._id }, { $set: { lida: true } });
      const before = await snapshot(f);
      await database.disconnect(); await database.connect(replica.uri, connectionOptions); monitor(); await assertTarget();
      const { result, operations } = await call(f);
      assert.equal(result.reutilizada, true); assert.equal(result.agendamento._id.toString(), before.Agendamento[0]._id);
      assert.equal(result.agendamento.data.toISOString(), before.Agendamento[0].data);
      assert.ok(operations.every(cmd => !writeNames.has(cmd.name) && cmd.collection !== Servico.collection.name));
      assert.deepEqual(await snapshot(f), before);
    });
    await t.test('replay finalizado recupera mesmos IDs; outra vencedora e cancelamento retornam conflito', async () => {
      const f = await fixture(); await call(f);
      await unchanged(f, 'OUTRA_PROPOSTA_VENCEDORA', f.outra);
      await Pedido.updateOne({ _id: f.pedido._id }, { $set: { status: 'finalizado' } });
      await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { status: 'finalizado' } });
      const before = await snapshot(f), { result, operations } = await call(f);
      assert.equal(result.reutilizada, true); assert.equal(result.agendamento.status, 'finalizado');
      assert.ok(operations.every(cmd => !writeNames.has(cmd.name))); assert.deepEqual(await snapshot(f), before);
      await Pedido.updateOne({ _id: f.pedido._id }, { $set: { status: 'cancelado' } });
      await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { status: 'cancelado' } });
      await unchanged(f, 'CONTRATACAO_CANCELADA');
    });
    const guards = [
      ['servico ausente', { servicos: 0 }, 'SERVICO_NAO_ENCONTRADO'],
      ['servico ambiguo', { servicos: 2 }, 'SERVICO_AMBIGUO'],
      ['legado', { certificado: false }, 'PROTOCOLO_NAO_CERTIFICADO'],
      ...['cancelado', 'finalizado', 'em andamento'].map(status => ['pedido ' + status, { pedidoStatus: status }, 'PEDIDO_NAO_ABERTO']),
      ...['aceita', 'recusada'].map(status => ['proposta ' + status, { propostaStatus: status }, 'PROPOSTA_NAO_ENVIADA'])
    ];
    for (const [label, options, motivo] of guards) await t.test(label + ': bloqueio sem qualquer escrita', async () => {
      const f = await fixture(options); await unchanged(f, motivo);
    });
    await t.test('servicos de outro prestador ou categoria nao atendem a proposta', async () => {
      const f = await fixture();
      await Servico.updateOne({ _id: f.servico._id }, { $set: { categoria: 'pintura' } });
      await unchanged(f, 'SERVICO_NAO_ENCONTRADO');
    });
    await t.test('autorizacao precede estados, certificacao, servico e vinculos', async () => {
      for (const options of [{}, { certificado: false, servicos: 0, pedidoStatus: 'cancelado', propostaStatus: 'recusada' }]) {
        const f = await fixture(options); await unchanged(f, 'SEM_PERMISSAO', f.proposta, oid());
      }
      const f = await fixture(); await call(f); await unchanged(f, 'SEM_PERMISSAO', f.proposta, oid());
    });
    await t.test('proposta inexistente e identificadores invalidos nao provocam escrita', async () => {
      const f = await fixture();
      await unchanged(f, 'PROPOSTA_NAO_ENCONTRADA', { id: oid().toString() });
      await unchanged(f, 'IDENTIFICADOR_INVALIDO', { id: 'invalido' });
      assert.deepEqual(await service.aceitarProposta({ propostaId: f.proposta.id, clienteId: '' }), { motivo: 'SEM_PERMISSAO' });
    });
    for (const variant of ['contratacao parcial', 'contratacao nula', 'aceita concorrente', 'servico antecipado', 'agenda antecipada']) {
      await t.test(variant + ': estado parcial inicial nao e reparado automaticamente', async () => {
        const f = await fixture();
        if (variant === 'contratacao parcial') await Pedido.updateOne({ _id: f.pedido._id }, { $set: { contratacao: { proposta_id: f.proposta._id } } });
        if (variant === 'contratacao nula') await Pedido.updateOne({ _id: f.pedido._id }, { $set: { contratacao: null } });
        if (variant === 'aceita concorrente') await Proposta.updateOne({ _id: f.outra._id }, { $set: { status: 'aceita' } });
        if (variant === 'servico antecipado') await Proposta.updateOne({ _id: f.proposta._id }, { $set: { servico_id: f.servico._id } });
        if (variant === 'agenda antecipada') await Agendamento.create({ cliente_id: f.cliente, prestador_id: f.prestador,
          servico_id: f.servico._id, pedido_id: f.pedido._id, data: new Date('2030-01-01'), hora: '09:00' });
        await unchanged(f, 'VINCULOS_INCONSISTENTES');
      });
    }
    for (const variant of ['agenda ausente', 'cliente divergente', 'servico divergente', 'pedido divergente', 'vencedora divergente',
      'notificacao sem evento', 'destinatario divergente', 'status incoerente']) {
      await t.test('replay bloqueia ' + variant + ' sem criar ou reparar registros', async () => {
        const f = await fixture(); await call(f);
        if (variant === 'agenda ausente') await Pedido.updateOne({ _id: f.pedido._id }, { $set: { 'contratacao.agendamento_id': oid() } });
        if (variant === 'cliente divergente') await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { cliente_id: oid() } });
        if (variant === 'servico divergente') await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { servico_id: oid() } });
        if (variant === 'pedido divergente') await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { pedido_id: oid() } });
        if (variant === 'vencedora divergente') await Proposta.updateOne({ _id: f.proposta._id }, { $set: { pedido_id: oid() } });
        if (variant === 'notificacao sem evento') await Notificacao.updateOne({ pedido_id: f.pedido._id }, { $unset: { evento_chave: '' } });
        if (variant === 'destinatario divergente') await Notificacao.updateOne({ pedido_id: f.pedido._id }, { $set: { usuario_id: oid() } });
        if (variant === 'status incoerente') await Agendamento.updateOne({ pedido_id: f.pedido._id }, { $set: { status: 'finalizado' } });
        await unchanged(f, variant === 'vencedora divergente' ? 'SEM_PERMISSAO' : 'VINCULOS_INCONSISTENTES');
      });
    }

    for (const [name, method] of [['Pedido', 'updateOne'], ['Proposta', 'updateOne'], ['Proposta', 'updateMany'],
      ['Agendamento', 'create'], ['Notificacao', 'create']]) await t.test('falha apos ' + name + '.' + method + ' aborta escritas reais', async () => {
      const f = await fixture(), before = await snapshot(f), Model = models[name], original = Model[method];
      const failure = new Error('Falha ficticia apos escrita real'); let reached = false;
      const restore = replace(Model, method, function (...args) {
        const operation = original.apply(this, args);
        if (method === 'create') return operation.then(() => { reached = true; throw failure; });
        const exec = operation.exec;
        operation.exec = async function (...params) { await exec.apply(this, params); reached = true; throw failure; };
        return operation;
      });
      const start = commands.length;
      try { await assert.rejects(service.aceitarProposta(input(f)), error => error === failure); }
      finally { restore(); }
      assert.equal(reached, true); assert.deepEqual(await snapshot(f), before);
      assert.ok(commands.slice(start).some(cmd => cmd.name === 'abortTransaction'));
      assert.ok(commands.slice(start).filter(cmd => dataNames.has(cmd.name)).every(cmd => cmd.transaction && sessionIds.has(cmd.session)));
      assert.ok(sessions.every(s => s.hasEnded));
    });
    await t.test('colisao real no indice I5 aborta toda a contratacao e preserva documento conflitante', async () => {
      const f = await fixture();
      // Documento incoerente proposital: tipo diferente, mas mesma chave/destinatario.
      // A insercao da aceitacao colide de verdade com I5 depois das outras escritas.
      await Notificacao.create({ usuario_id: f.prestador, tipo: 'nova_proposta', mensagem: 'Fixture conflitante',
        evento_chave: 'pedido:' + f.pedido.id + ':proposta_aceita:v1' });
      const before = await snapshot(f), { result, operations } = await call(f);
      assert.deepEqual(result, { motivo: 'CONFLITO_PERSISTENCIA' });
      assert.ok(operations.some(cmd => cmd.name === 'insert' && cmd.collection === Notificacao.collection.name));
      assert.deepEqual(await snapshot(f), before);
    });
    for (const same of [false, true]) await t.test('concorrencia sincronizada: ' + (same ? 'mesma proposta' : 'propostas diferentes'), async () => {
      const f = await fixture(), original = Pedido.findById, seen = new Set();
      let release, reject, timer;
      const gate = new Promise((yes, no) => { release = yes; reject = no; }); gate.catch(() => {});
      timer = setTimeout(() => reject(Error('Barreira nao completou')), 10000);
      const restore = replace(Pedido, 'findById', function (...args) {
        const query = original.apply(this, args), exec = query.exec;
        query.exec = async function (...params) {
          const result = await exec.apply(this, params), session = this.getOptions().session;
          if (String(args[0]) === f.pedido.id && result && !result.contratacao && session) {
            const key = session.id.id.toString('hex');
            if (!seen.has(key)) {
              seen.add(key); if (seen.size === 2) { clearTimeout(timer); release(); } await gate;
            }
          }
          return result;
        }; return query;
      });
      const start = commands.length; let values;
      try {
        const results = await Promise.allSettled([service.aceitarProposta(input(f)), service.aceitarProposta(input(f, same ? f.proposta : f.outra))]);
        for (const r of results) if (r.status === 'rejected') throw r.reason;
        values = results.map(r => r.value); assert.equal(seen.size, 2);
      } finally { clearTimeout(timer); release(); restore(); }
      const created = values.find(r => r.reutilizada === false); assert.ok(created);
      const other = values.find(r => r !== created);
      if (same) { assert.equal(other.reutilizada, true); assert.equal(String(other.agendamento._id), String(created.agendamento._id)); }
      else assert.deepEqual(other, { motivo: 'OUTRA_PROPOSTA_VENCEDORA' });
      complete(await snapshot(f), String(created.proposta._id));
      assert.ok(commands.slice(start).some(cmd => cmd.name === 'abortTransaction'));
      assert.ok(commands.slice(start).filter(cmd => dataNames.has(cmd.name)).every(cmd => cmd.transaction && sessionIds.has(cmd.session)));
      assert.ok(sessions.every(s => s.hasEnded));
    });
    await t.test('commit confirmado seguido de sinal incerto nao e anunciado como sucesso; nova consulta recupera', async () => {
      const f = await fixture(), original = database.connection.startSession;
      // Injecao de sinal depois do commit real; nao simula perda de rede nem substitui persistencia.
      const restore = replace(database.connection, 'startSession', async function (...args) {
        const session = await original.apply(this, args), transaction = session.withTransaction;
        session.withTransaction = async function (...params) {
          await transaction.apply(this, params);
          const error = new Error('Confirmacao ficticiamente indisponivel');
          error.hasErrorLabel = label => label === 'UnknownTransactionCommitResult'; throw error;
        }; return session;
      });
      try { assert.deepEqual(await service.aceitarProposta(input(f)), { motivo: 'RESULTADO_INDETERMINADO' }); }
      finally { restore(); }
      const state = await snapshot(f); complete(state, f.proposta.id);
      const { result, operations } = await call(f); assert.equal(result.reutilizada, true);
      assert.ok(operations.every(cmd => !writeNames.has(cmd.name))); assert.deepEqual(await snapshot(f), state);
    });
    await t.test('Models de conexoes diferentes sao rejeitados sem abrir conexao', () => {
      const other = new mongoose.Mongoose();
      const foreign = other.model('Proposta', new other.Schema({}));
      assert.throws(() => criarContratacaoVinculadaService({ ...models, Proposta: foreign }), TypeError);
      assert.equal(other.connection.readyState, 0);
    });
    await assertTarget();
    assert.ok(sessions.every(s => s.hasEnded));
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
      assert.ok(commands.filter(cmd => writeNames.has(cmd.name)).every(cmd => cmd.ready && cmd.db === replica.databaseName &&
        collections.has(cmd.collection) && ['create', 'createIndexes', 'insert', 'update'].includes(cmd.name)), 'Escritas restritas ao ensaio');
    }
  }
});
