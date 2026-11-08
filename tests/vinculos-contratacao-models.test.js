const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { disposableMongo } = require('./helpers/disposableMongo');
const { loadController, loadService, controllerStubs, startHttp } = require('./helpers/httpApp');

const modelFiles = { Pedido: 'pedidoModel.js', Proposta: 'propostaModel.js',
  Agendamento: 'agendamentoModel.js', Notificacao: 'notificacaoModel.js', Servico: 'servicoModel.js' };
const added = { Pedido: ['fluxo_contratacao', 'contratacao'], Proposta: ['servico_id'],
  Agendamento: ['origem', 'pedido_id', 'proposta_id'], Notificacao: ['pedido_id', 'evento_chave'] };
const oid = () => new mongoose.Types.ObjectId();
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = name => ({
  Pedido: { cliente_id: oid(), titulo: 'Pedido ficticio', descricao: 'Descricao ficticia', categoria: 'faxina' },
  Proposta: { pedido_id: oid(), prestador_id: oid(), valor: 120, prazo: 'Dois dias' },
  Agendamento: { cliente_id: oid(), prestador_id: oid(), servico_id: oid(), data: new Date('2030-01-01T00:00:00Z'), hora: '09:00' },
  Notificacao: { usuario_id: oid(), mensagem: 'Mensagem ficticia', tipo: 'proposta_aceita' }
})[name];
const metadata = name => ({
  Pedido: { fluxo_contratacao: 1, contratacao: { proposta_id: oid(), servico_id: oid(), agendamento_id: oid() } },
  Proposta: { servico_id: oid() },
  Agendamento: { origem: 'proposta', pedido_id: oid(), proposta_id: oid() },
  Notificacao: { pedido_id: oid(), evento_chave: 'pedido:ficticio:proposta_aceita:v1' }
})[name];

async function sourceModule(file, dependencies) {
  assert.ok(Object.values(modelFiles).some(name => file === 'Models/' + name) || file === 'utils/notificacaoHelper.js');
  const filename = path.join(__dirname, '..', file);
  assert.equal(await fs.realpath(filename), filename);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Dependencia nao autorizada no modulo isolado');
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

async function modelsOn(database) {
  const models = {};
  for (const [name, file] of Object.entries(modelFiles)) {
    models[name] = await sourceModule('Models/' + file, { mongoose: database });
    assert.equal(models[name].modelName, name);
    assert.equal(models[name].db, database.connection);
  }
  return models;
}

function absent(name, value) {
  for (const field of added[name]) assert.equal(Object.hasOwn(value, field), false, name + '.' + field);
}

// Contratos anteriores explicitos; nao derivados dos novos paths nem de snapshots gerados.
const previous = {
  Pedido: { refs: { cliente_id: 'Usuario' }, strings: ['titulo', 'descricao', 'categoria'], numbers: [],
    enums: { categoria: ['eletrica', 'encanamento', 'faxina', 'jardinagem', 'pintura', 'reparos'],
      status: ['aberto', 'em andamento', 'finalizado', 'cancelado'] }, defaults: { status: 'aberto' }, dates: ['data_desejada', 'data_criacao'] },
  Proposta: { refs: { pedido_id: 'Pedido', prestador_id: 'Usuario' }, strings: ['prazo'], numbers: ['valor'],
    enums: { status: ['enviada', 'aceita', 'recusada'] }, defaults: { descricao: '', status: 'enviada' }, dates: ['data_criacao'] },
  Agendamento: { refs: { cliente_id: 'Usuario', prestador_id: 'Usuario', servico_id: 'Servico' }, strings: ['hora'], numbers: [],
    enums: { status: ['pendente', 'confirmado', 'cancelado', 'finalizado'] }, defaults: { status: 'pendente' }, dates: ['data', 'data_criacao'] },
  Notificacao: { refs: { usuario_id: 'Usuario' }, strings: ['mensagem', 'tipo'], numbers: [],
    enums: { tipo: ['nova_proposta', 'proposta_aceita', 'novo_agendamento', 'cancelamento', 'avaliacao'] },
    defaults: { lida: false, link: '' }, dates: ['data_criacao'] }
};

test('schemas reais: compatibilidade e campos opcionais sem conexao', async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  const models = await modelsOn(database);
  for (const name of Object.keys(added)) {
    const Model = models[name];
    await t.test(name + ': legado hidratado e criacao atual sem metadados continuam validos', async () => {
      for (const doc of [new Model(fixture(name)), Model.hydrate({ _id: oid(), ...fixture(name) })]) {
        await doc.validate();
        absent(name, doc.toObject()); absent(name, plain(doc));
        for (const field of added[name]) assert.equal(doc.get(field), undefined);
      }
    });
    await t.test(name + ': metadados explicitos aceitos e serializados sem geracao adicional', async () => {
      const fields = metadata(name), doc = new Model({ ...fixture(name), ...fields });
      await doc.validate();
      for (const [key, value] of Object.entries(fields)) assert.deepEqual(plain(doc)[key], plain(value));
      if (name === 'Pedido') {
        assert.equal(doc.contratacao._id, undefined);
        assert.equal(Object.hasOwn(doc.toObject().contratacao, '_id'), false);
      }
    });
    await t.test(name + ': campos, defaults, enums, opcoes e indices anteriores preservados', async () => {
      const spec = previous[name], schema = Model.schema, doc = new Model(fixture(name));
      for (const [field, ref] of Object.entries(spec.refs)) {
        assert.equal(schema.path(field).instance, 'ObjectId');
        assert.equal(schema.path(field).options.ref, ref);
        assert.equal(schema.path(field).options.required, true);
      }
      for (const [fields, type] of [[spec.strings, 'String'], [spec.numbers, 'Number'], [spec.dates, 'Date']]) {
        for (const field of fields) assert.equal(schema.path(field).instance, type);
      }
      for (const field of [...Object.keys(spec.refs), ...spec.strings, ...spec.numbers, ...(name === 'Agendamento' ? ['data'] : [])]) {
        const invalid = new Model(fixture(name)); invalid.set(field, undefined);
        assert.equal(invalid.validateSync().errors[field].kind, 'required');
      }
      for (const [field, values] of Object.entries(spec.enums)) {
        assert.deepEqual(Array.from(schema.path(field).enumValues), values);
        const invalid = new Model(fixture(name)); invalid.set(field, 'invalido-ficticio');
        assert.equal(invalid.validateSync().errors[field].kind, 'enum');
      }
      for (const [field, value] of Object.entries(spec.defaults)) assert.equal(doc.get(field), value);
      assert.ok(doc.data_criacao instanceof Date);
      if (name === 'Pedido') assert.equal(doc.data_desejada, undefined);
      const indexes = schema.indexes().map(([keys, options]) => ({ keys: plain(keys), unique: options.unique }));
      assert.deepEqual(indexes, name === 'Proposta' ? [{ keys: { pedido_id: 1, prestador_id: 1 }, unique: true }] : []);
      assert.equal(schema.options.strict, true); assert.equal(schema.options.minimize, true);
      assert.equal(schema.options.toJSON, undefined); assert.equal(schema.options.toObject, undefined);
      for (const field of added[name]) {
        assert.equal(schema.path(field).defaultValue, undefined);
        assert.ok(!schema.path(field).options.required);
      }
    });
  }
  await t.test('novas referencias tem tipos e Models corretos; ObjectIds malformados sao rejeitados', () => {
    const refs = { Pedido: { 'contratacao.proposta_id': 'Proposta', 'contratacao.servico_id': 'Servico', 'contratacao.agendamento_id': 'Agendamento' },
      Proposta: { servico_id: 'Servico' }, Agendamento: { pedido_id: 'Pedido', proposta_id: 'Proposta' }, Notificacao: { pedido_id: 'Pedido' } };
    for (const [name, fields] of Object.entries(refs)) for (const [field, ref] of Object.entries(fields)) {
      const Model = models[name], schemaPath = Model.schema.path(field);
      assert.equal(schemaPath.instance, 'ObjectId'); assert.equal(schemaPath.options.ref, ref);
      assert.equal(schemaPath.defaultValue, undefined); assert.ok(!schemaPath.options.required);
      const fields = field.startsWith('contratacao.')
        ? { contratacao: { [field.split('.')[1]]: 'nao-e-objectid' } }
        : { [field]: 'nao-e-objectid' };
      const doc = new Model({ ...fixture(name), ...fields });
      assert.equal(doc.validateSync().errors[field].name, 'CastError');
    }
  });
  await t.test('marcador reconhece somente 1 e origem somente direta ou proposta', async () => {
    assert.equal(models.Pedido.schema.path('fluxo_contratacao').instance, 'Number');
    assert.equal(models.Notificacao.schema.path('evento_chave').instance, 'String');
    for (const value of [0, 2, -1]) {
      const doc = new models.Pedido({ ...fixture('Pedido'), fluxo_contratacao: value });
      assert.equal(doc.validateSync().errors.fluxo_contratacao.kind, 'enum');
    }
    for (const origem of ['direta', 'proposta']) await new models.Agendamento({ ...fixture('Agendamento'), origem }).validate();
    for (const origem of ['legado', '', 'Direta']) {
      const doc = new models.Agendamento({ ...fixture('Agendamento'), origem });
      assert.equal(doc.validateSync().errors.origem.kind, 'enum');
    }
  });
  await t.test('preparacao nao ativa validacao completa, chaves canonicas ou vinculos automaticos', async () => {
    const pedido = new models.Pedido({ ...fixture('Pedido'), contratacao: { proposta_id: oid() } });
    await pedido.validate();
    assert.equal(pedido.fluxo_contratacao, undefined); assert.equal(pedido.contratacao.servico_id, undefined);
    const notif = new models.Notificacao({ ...fixture('Notificacao'), pedido_id: oid() });
    await notif.validate(); assert.equal(notif.evento_chave, undefined);
  });
  assert.equal(database.connection.readyState, 0); assert.equal(mongoose.connection.readyState, 0);
});

test('MongoDB descartavel: legados e vinculos opcionais com persistencia real', { timeout: 90000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  const databaseName = 'iservice_vinculos_' + randomUUID().replace(/-/g, '');
  let mongo, directory, writesAllowed = false;
  const writes = [], collections = new Set();
  const mutating = new Set(['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'dropIndexes']);
  try {
    mongo = await disposableMongo();
    const url = new URL(mongo.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0 && Number(url.port) !== 27017);
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.search, '');
    assert.ok(url.pathname === '' || url.pathname === '/');
    assert.ok(Number.isSafeInteger(mongo.pid) && mongo.pid > 0);
    assert.equal((await mongo.client.db('admin').command({ serverStatus: 1 })).pid, mongo.pid);
    const options = await mongo.client.db('admin').command({ getCmdLineOpts: 1 });
    assert.equal(options.parsed.net.bindIp, '127.0.0.1'); assert.equal(options.parsed.net.port, Number(url.port));
    directory = path.resolve(options.parsed.storage.dbPath);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('iservice-chat-audit-'));
    assert.equal(await fs.realpath(directory), directory);
    await database.connect(mongo.uri, { dbName: databaseName, autoCreate: false, autoIndex: false,
      bufferCommands: false, monitorCommands: true, serverSelectionTimeoutMS: 1000 });
    database.connection.getClient().on('commandStarted', event => {
      if (mutating.has(event.commandName)) writes.push({ name: event.commandName, databaseName: event.databaseName,
        collection: event.command[event.commandName], allowed: writesAllowed });
    });
    async function assertTarget() {
      assert.equal(database.connection.host, '127.0.0.1'); assert.equal(database.connection.port, Number(url.port));
      assert.equal(database.connection.name, databaseName); assert.equal(database.connection.readyState, 1);
      assert.equal((await database.connection.db.admin().command({ serverStatus: 1 })).pid, mongo.pid);
    }
    await assertTarget();
    const models = await modelsOn(database);
    for (const Model of Object.values(models)) collections.add(Model.collection.name);
    assert.equal(writes.length, 0); assert.equal(mongoose.connection.readyState, 0);
    writesAllowed = true;
    for (const Model of Object.values(models)) { await assertTarget(); await Model.createCollection(); }

    for (const name of Object.keys(added)) {
      const Model = models[name];
      await t.test(name + ': carregar, salvar e recarregar legado nao acrescenta metadados', async () => {
        await assertTarget();
        // Insercao crua simula BSON anterior ao schema novo, nao uma fixture ja enriquecida pelo Model.
        const raw = { _id: oid(), ...fixture(name), ...previous[name].defaults, data_criacao: new Date('2025-01-01T00:00:00Z'), __v: 0 };
        await Model.collection.insertOne(raw);
        const doc = await Model.findById(raw._id);
        absent(name, doc.toObject()); absent(name, plain(doc)); await doc.save();
        assert.deepEqual(plain(await Model.collection.findOne({ _id: raw._id })), plain(raw));
        const field = { Pedido: 'titulo', Proposta: 'descricao', Agendamento: 'hora', Notificacao: 'mensagem' }[name];
        const value = name === 'Agendamento' ? '10:00' : 'Edicao ficticia';
        doc.set(field, value); await doc.save();
        const saved = await Model.collection.findOne({ _id: raw._id });
        assert.deepEqual(plain(saved), plain({ ...raw, [field]: value }));
        absent(name, plain(await Model.findById(raw._id)));
      });
      await t.test(name + ': novos metadados explicitos sobrevivem a persistencia e recarga', async () => {
        await assertTarget();
        const fields = metadata(name), doc = await Model.create({ ...fixture(name), ...fields });
        const reloaded = await Model.findById(doc._id), raw = await Model.collection.findOne({ _id: doc._id });
        for (const [key, value] of Object.entries(fields)) {
          assert.deepEqual(plain(reloaded)[key], plain(value)); assert.deepEqual(plain(raw)[key], plain(value));
        }
        if (name === 'Pedido') assert.equal(Object.hasOwn(raw.contratacao, '_id'), false);
      });
    }

    await t.test('HTTP real continua criando sem campos novos e ignora metadados forjados', async t => {
      const secret = 'segredo-ficticio-vinculos', cliente = oid(), prestador = oid();
      const headers = (id, tipo) => ({ Authorization: 'Bearer ' + jwt.sign({ id: id.toString(), tipo }, secret, { expiresIn: 60 }) });
      const helper = await sourceModule('utils/notificacaoHelper.js', { '../Models/notificacaoModel': models.Notificacao });
      const deps = Object.fromEntries(Object.entries(modelFiles).map(([name, file]) => ['../Models/' + file.replace('.js', ''), models[name]]));
      deps['../utils/notificacaoHelper'] = helper;
      const service = loadService('services/propostaService.js', deps, { secret });
      const dispatches = [], controllers = controllerStubs(dispatches);
      for (const name of ['pedido', 'proposta', 'agendamento', 'notificacao']) {
        controllers[name + 'Controller'] = loadController('controllers/' + name + 'Controller.js', {
          ...deps, '../services/propostaService': service
        }, { secret });
      }
      const http = await startHttp(t, { controllers, secret });
      async function request(method, url, actor, body, status) {
        const response = await http.request(method, url, actor, body);
        assert.equal(response.status, status); return JSON.parse(response.text);
      }
      const serviceDoc = await models.Servico.create({ nome: 'Servico ficticio', descricao: 'Ficticio', preco: 100,
        categoria: 'faxina', prestador_id: prestador });
      const p = await request('POST', '/api/pedidos', headers(cliente, 'cliente'), { ...fixture('Pedido'), ...metadata('Pedido') }, 201);
      absent('Pedido', p.pedido);
      const q = await request('POST', '/api/propostas', headers(prestador, 'prestador'), {
        pedido_id: p.pedido._id, valor: 120, prazo: 'Dois dias', ...metadata('Proposta')
      }, 201);
      absent('Proposta', q.proposta);
      const accepted = await request('PUT', '/api/propostas/' + q.proposta._id + '/aceitar', headers(cliente, 'cliente'), {}, 200);
      assert.deepEqual(Object.keys(accepted).sort(), ['agendamento', 'mensagem', 'proposta']);
      absent('Proposta', accepted.proposta); absent('Pedido', accepted.proposta.pedido_id); absent('Agendamento', accepted.agendamento);
      assert.equal(accepted.agendamento.servico_id, serviceDoc.id);
      await request('PUT', '/api/propostas/' + q.proposta._id + '/aceitar', headers(cliente, 'cliente'), {}, 409);
      const direct = await request('POST', '/api/agendamentos', headers(cliente, 'cliente'), {
        servico_id: serviceDoc.id, data: '2035-05-20', hora: '11:00', ...metadata('Agendamento')
      }, 201);
      absent('Agendamento', direct.agendamento);
      const notifications = await request('GET', '/api/notificacoes', headers(prestador, 'prestador'), undefined, 200);
      assert.equal(notifications.length, 1); absent('Notificacao', notifications[0]);
      for (const [name, filter] of [['Pedido', { _id: new mongoose.Types.ObjectId(p.pedido._id) }],
        ['Proposta', { _id: new mongoose.Types.ObjectId(q.proposta._id) }],
        ['Agendamento', { prestador_id: prestador }], ['Notificacao', { usuario_id: prestador }]]) {
        for (const doc of await models[name].collection.find(filter).toArray()) absent(name, doc);
      }
      assert.deepEqual(dispatches, []);
    });
    await t.test('nenhum indice secundario foi criado automaticamente neste ensaio', async () => {
      for (const Model of Object.values(models)) {
        const indexes = await Model.collection.indexes();
        assert.deepEqual(indexes.map(index => index.key), [{ _id: 1 }]);
      }
      assert.ok(writes.every(write => write.name !== 'createIndexes'));
    });
  } finally {
    const cleanup = await Promise.allSettled([database.disconnect()]);
    if (mongo) { try { await mongo.cleanup(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); } }
    assert.equal(database.connection.readyState, 0); assert.equal(mongoose.connection.readyState, 0);
    assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'Limpeza deve concluir');
    if (mongo) {
      assert.throws(() => process.kill(mongo.pid, 0), error => error.code === 'ESRCH');
      if (directory) assert.ok(await fs.access(directory).then(() => false, error => error.code === 'ENOENT'));
    }
    assert.ok(writes.every(write => write.allowed && write.databaseName === databaseName && collections.has(write.collection) &&
      ['create', 'insert', 'update'].includes(write.name)), 'Escritas apenas nas colecoes descartaveis autorizadas');
  }
});
