const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { disposableMongo } = require('./helpers/disposableMongo');
const { loadController, loadService, controllerStubs, startHttp } = require('./helpers/httpApp');

const secret = 'segredo-ficticio-integracao-contratacoes';
const FALHA = 'falha-controlada-exclusiva-do-teste';
const plain = value => JSON.parse(JSON.stringify(value));
const modelFiles = Object.freeze({ Usuario: 'usuarioModel.js', Servico: 'servicoModel.js',
  Pedido: 'pedidoModel.js', Proposta: 'propostaModel.js', Agendamento: 'agendamentoModel.js', Notificacao: 'notificacaoModel.js' });

async function sourceModule(file, dependencies) {
  assert.ok(Object.values(modelFiles).some(name => file === 'Models/' + name) || file === 'utils/notificacaoHelper.js',
    'Somente Models e helper de notificacao autorizados');
  const filename = path.join(__dirname, '..', file);
  assert.equal(await fs.realpath(filename), filename);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Dependencia inesperada no codigo real isolado');
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

function json(res, status, mensagem) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  const body = JSON.parse(res.text);
  if (mensagem) assert.equal(body.mensagem, mensagem);
  return body;
}

test('MongoDB descartavel: propostas e agendamentos com persistencia real', { timeout: 90000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false); database.set('autoIndex', false); database.set('bufferCommands', false);
  const databaseName = 'iservice_contratacoes_' + randomUUID().replace(/-/g, '');
  assert.ok(databaseName.length <= 63);
  let mongo, directory, writesAllowed = false;
  const writes = [], collections = new Set();
  const mutating = new Set(['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes',
    'drop', 'dropDatabase', 'dropIndexes']);
  try {
    // Mesmas verificacoes de identidade/diretorio da integracao de autenticacao.
    mongo = await disposableMongo();
    const url = new URL(mongo.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0 && Number(url.port) !== 27017, 'Porta temporaria obrigatoria');
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
    const models = {};
    for (const [name, file] of Object.entries(modelFiles)) {
      models[name] = await sourceModule('Models/' + file, { mongoose: database, bcryptjs: bcrypt });
      assert.equal(models[name].db, database.connection);
      collections.add(models[name].collection.name);
    }
    const { Usuario, Servico, Pedido, Proposta, Agendamento, Notificacao } = models;
    assert.equal(mongoose.connection.readyState, 0); assert.equal(writes.length, 0);
    writesAllowed = true;
    for (const Model of Object.values(models)) { await assertTarget(); await Model.createCollection(); }
    // Somente os indices declarados de identidade das fixtures e unicidade de proposta.
    for (const Model of [Usuario, Proposta]) { await assertTarget(); await Model.createIndexes(); }
    const notificationHelper = await sourceModule('utils/notificacaoHelper.js', { '../Models/notificacaoModel': Notificacao });
    const dependencies = { '../Models/propostaModel': Proposta, '../Models/pedidoModel': Pedido,
      '../Models/agendamentoModel': Agendamento, '../Models/servicoModel': Servico,
      '../utils/notificacaoHelper': notificationHelper };
    const service = loadService('services/propostaService.js', dependencies, { secret });

    await t.test('HTTP real com Models, service e notificacoes reais', async t => {
      const dispatches = [], controllers = controllerStubs(dispatches);
      controllers.propostaController = loadController('controllers/propostaController.js', {
        ...dependencies, '../services/propostaService': service
      }, { secret });
      controllers.agendamentoController = loadController('controllers/agendamentoController.js', dependencies, { secret });
      controllers.pedidoController = loadController('controllers/pedidoController.js', dependencies, { secret });
      const http = await startHttp(t, { controllers, secret });
      let sequence = 0;
      async function user(label, tipo) {
        await assertTarget();
        return Usuario.create({ nome: 'Conta ficticia ' + label, email: label + '@example.invalid',
          senha: 'senha-exclusivamente-ficticia', telefone: '000000000', tipo });
      }
      const cliente = await user('cliente', 'cliente'), outroCliente = await user('outro-cliente', 'cliente');
      const concorrente = await user('outro-prestador', 'prestador');
      const headers = user => ({ Authorization: 'Bearer ' + jwt.sign({ id: user.id, tipo: user.tipo }, secret, { expiresIn: 60 }) });
      async function fixture({ service = true, pedidoStatus = 'aberto', propostaStatus = 'enviada' } = {}) {
        await assertTarget();
        const n = ++sequence, prestador = await user('prestador-' + n, 'prestador');
        const data = new Date(Date.UTC(2030, 0, n)).toISOString();
        const servico = service ? await Servico.create({ prestador_id: prestador._id, nome: 'Servico ficticio',
          descricao: 'Descricao ficticia', categoria: 'faxina', preco: 100 }) : null;
        const pedido = await Pedido.create({ cliente_id: cliente._id, titulo: 'Pedido ficticio',
          descricao: 'Descricao ficticia', categoria: 'faxina', data_desejada: data, status: pedidoStatus });
        const proposta = await Proposta.create({ pedido_id: pedido._id, prestador_id: prestador._id,
          valor: 120, prazo: 'Dois dias', descricao: 'Proposta ficticia', status: propostaStatus });
        const outra = await Proposta.create({ pedido_id: pedido._id, prestador_id: concorrente._id,
          valor: 150, prazo: 'Tres dias' });
        return { prestador, servico, pedido, proposta, outra, data };
      }
      const aceitar = (f, actor = cliente) => http.request('PUT', '/api/propostas/' + f.proposta.id + '/aceitar', headers(actor), {});
      const agendar = (f, actor = cliente, extra = {}) => http.request('POST', '/api/agendamentos', headers(actor),
        { servico_id: f.servico.id, data: f.data, hora: '09:00', ...extra });
      async function persisted(f) {
        return { pedido: plain(await Pedido.findById(f.pedido.id)), proposta: plain(await Proposta.findById(f.proposta.id)),
          outra: plain(await Proposta.findById(f.outra.id)),
          agendamentos: plain(await Agendamento.find({ prestador_id: f.prestador._id })),
          notificacoes: plain(await Notificacao.find({ usuario_id: f.prestador._id })) };
      }

      await t.test('aceitacao valida persiste proposta, pedido, recusas, vinculos e notificacao real', async () => {
        const f = await fixture();
        const unrelated = await Pedido.create({ cliente_id: outroCliente._id, titulo: 'Outro pedido ficticio',
          descricao: 'Outro', categoria: 'faxina' });
        const otherProposal = await Proposta.create({ pedido_id: unrelated._id, prestador_id: concorrente._id, valor: 80, prazo: 'Um dia' });
        const body = json(await aceitar(f), 200, 'Proposta aceita com sucesso');
        assert.deepEqual(Object.keys(body).sort(), ['agendamento', 'mensagem', 'proposta']);
        const state = await persisted(f);
        assert.equal(state.proposta.status, 'aceita'); assert.equal(state.pedido.status, 'em andamento');
        assert.equal(state.outra.status, 'recusada'); assert.equal(state.agendamentos.length, 1);
        assert.equal(body.proposta.pedido_id._id, f.pedido.id); // populate real do service.
        assert.equal(body.proposta.pedido_id.status, 'em andamento');
        assert.equal(body.agendamento._id, state.agendamentos[0]._id);
        const row = state.agendamentos[0];
        assert.equal(row.cliente_id, cliente.id); assert.equal(row.prestador_id, f.prestador.id);
        assert.equal(row.servico_id, f.servico.id); assert.equal(row.data, f.data);
        assert.equal(row.hora, '09:00'); assert.equal(row.status, 'pendente');
        assert.equal(state.notificacoes.length, 1);
        assert.deepEqual({ usuario_id: state.notificacoes[0].usuario_id, mensagem: state.notificacoes[0].mensagem,
          tipo: state.notificacoes[0].tipo, link: state.notificacoes[0].link, lida: state.notificacoes[0].lida },
        { usuario_id: f.prestador.id, mensagem: 'Sua proposta foi aceita pelo cliente', tipo: 'proposta_aceita',
          link: '/dashboard-prestador.html', lida: false });
        assert.equal((await Proposta.findById(otherProposal.id)).status, 'enviada');
      });

      await t.test('outro cliente nao aceita proposta nem altera documentos persistidos', async () => {
        const f = await fixture(), before = await persisted(f);
        json(await aceitar(f, outroCliente), 403, 'Voce nao tem permissao para aceitar esta proposta');
        assert.deepEqual(await persisted(f), before);
      });

      await t.test('FUNC-006: sem servico aceita e notifica, persistindo nenhum agendamento', async () => {
        const f = await fixture({ service: false });
        const body = json(await aceitar(f), 200, 'Proposta aceita com sucesso');
        assert.equal(body.agendamento, null);
        const state = await persisted(f);
        assert.equal(state.proposta.status, 'aceita'); assert.equal(state.pedido.status, 'em andamento');
        assert.equal(state.outra.status, 'recusada'); assert.equal(state.agendamentos.length, 0);
        assert.equal(state.notificacoes.length, 1);
      });

      await t.test('FUNC-001: proposta recusada de pedido cancelado e realmente aceita', async () => {
        const f = await fixture({ pedidoStatus: 'cancelado', propostaStatus: 'recusada' });
        json(await aceitar(f), 200, 'Proposta aceita com sucesso');
        const state = await persisted(f);
        assert.equal(state.proposta.status, 'aceita'); assert.equal(state.pedido.status, 'em andamento');
        assert.equal(state.agendamentos.length, 1); assert.equal(state.notificacoes.length, 1);
      });

      await t.test('FUNC-002: repetir aceitacao persiste dois agendamentos e duas notificacoes', async () => {
        const f = await fixture();
        json(await aceitar(f), 200, 'Proposta aceita com sucesso');
        json(await aceitar(f), 200, 'Proposta aceita com sucesso');
        const state = await persisted(f);
        assert.equal(state.agendamentos.length, 2); assert.equal(state.notificacoes.length, 2);
        assert.notEqual(state.agendamentos[0]._id, state.agendamentos[1]._id);
        assert.notEqual(state.notificacoes[0]._id, state.notificacoes[1]._id);
        assert.ok(state.agendamentos.every(row => row.data === f.data && row.hora === '09:00'));
      });

      for (const point of ['pedido.save', 'agendamento.create']) {
        await t.test(`FUNC-003: falha controlada em ${point} preserva escritas reais anteriores`, async () => {
          const f = await fixture();
          const target = point === 'pedido.save' ? Pedido.prototype : Agendamento;
          const method = point === 'pedido.save' ? 'save' : 'create', original = target[method];
          const descriptor = Object.getOwnPropertyDescriptor(target, method);
          // Somente o ponto de falha e interceptado; as operacoes anteriores persistem de verdade.
          target[method] = async function (...args) {
            const matches = point === 'pedido.save' ? this._id.equals(f.pedido._id) : args[0].servico_id.equals(f.servico._id);
            if (matches) throw Error(FALHA);
            return original.apply(this, args);
          };
          try {
            const body = json(await aceitar(f), 500, 'Erro ao aceitar proposta');
            assert.equal(body.erro, FALHA);
          } finally {
            if (descriptor) Object.defineProperty(target, method, descriptor);
            else delete target[method];
          }
          const state = await persisted(f);
          assert.equal(state.proposta.status, 'aceita');
          assert.equal(state.pedido.status, point === 'pedido.save' ? 'aberto' : 'em andamento');
          assert.equal(state.outra.status, point === 'pedido.save' ? 'enviada' : 'recusada');
          assert.equal(state.agendamentos.length, 0); assert.equal(state.notificacoes.length, 0);
        });
      }

      await t.test('agendamento direto persiste identidade JWT e bloqueia conflito sequencial real', async () => {
        const f = await fixture();
        const body = json(await agendar(f, cliente, { cliente_id: outroCliente.id, prestador_id: concorrente.id }),
          201, 'Servico agendado com sucesso');
        const saved = await Agendamento.findById(body.agendamento._id);
        assert.equal(saved.cliente_id.toString(), cliente.id); assert.equal(saved.prestador_id.toString(), f.prestador.id);
        assert.equal(saved.servico_id.toString(), f.servico.id); assert.equal(saved.data.toISOString(), f.data);
        assert.equal(saved.status, 'pendente');
        json(await agendar(f, outroCliente), 400, 'Horario indisponivel para este prestador');
        assert.equal(await Agendamento.countDocuments({ prestador_id: f.prestador._id }), 1);
      });

      await t.test('mesmo horario de outro prestador, outra data e outra hora nao conflitam', async () => {
        const f = await fixture();
        json(await agendar(f), 201);
        json(await agendar(f, outroCliente, { hora: '10:00' }), 201);
        json(await agendar(f, outroCliente, { data: new Date(Date.parse(f.data) + 86400000).toISOString() }), 201);
        const another = await Servico.create({ prestador_id: concorrente._id, nome: 'Servico ficticio alternativo',
          descricao: 'Outro', categoria: 'faxina', preco: 90 });
        const body = json(await agendar(f, outroCliente, { servico_id: another.id }), 201);
        assert.equal((await Agendamento.findById(body.agendamento._id)).prestador_id.toString(), concorrente.id);
        assert.equal(await Agendamento.countDocuments({ prestador_id: f.prestador._id }), 3);
      });

      await t.test('FUNC-004: aceitacao ignora reserva direta existente no mesmo prestador/data/hora', async () => {
        const f = await fixture();
        json(await agendar(f, outroCliente), 201);
        json(await aceitar(f), 200);
        const rows = await Agendamento.find({ prestador_id: f.prestador._id, data: f.data, hora: '09:00' });
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map(row => row.cliente_id.toString()).sort(), [cliente.id, outroCliente.id].sort());
        const g = await fixture();
        json(await aceitar(g), 200);
        json(await agendar(g, outroCliente), 400, 'Horario indisponivel para este prestador');
        assert.equal(await Agendamento.countDocuments({ prestador_id: g.prestador._id }), 1);
      });

      await t.test('FUNC-005: prestador finaliza e reabre sem restricao de transicao; outra conta recebe 403', async () => {
        const f = await fixture(), body = json(await agendar(f), 201), id = body.agendamento._id;
        const url = '/api/agendamentos/' + id + '/status';
        json(await http.request('PUT', url, headers(concorrente), { status: 'finalizado' }),
          403, 'Voce nao tem permissao para alterar este agendamento');
        assert.equal((await Agendamento.findById(id)).status, 'pendente');
        for (const status of ['finalizado', 'pendente']) {
          json(await http.request('PUT', url, headers(f.prestador), { status }), 200, 'Status atualizado com sucesso');
          assert.equal((await Agendamento.findById(id)).status, status);
        }
      });

      await t.test('FUNC-005: cliente cancela agendamento finalizado mas nao recurso de outra conta', async () => {
        const f = await fixture(), body = json(await agendar(f), 201), id = body.agendamento._id;
        json(await http.request('PUT', '/api/agendamentos/' + id + '/status', headers(f.prestador), { status: 'finalizado' }), 200);
        const url = '/api/agendamentos/' + id + '/cancelar';
        json(await http.request('PUT', url, headers(outroCliente), {}), 403, 'Voce nao tem permissao para cancelar este agendamento');
        assert.equal((await Agendamento.findById(id)).status, 'finalizado');
        json(await http.request('PUT', url, headers(cliente), {}), 200, 'Agendamento cancelado com sucesso');
        assert.equal((await Agendamento.findById(id)).status, 'cancelado');
      });

      await t.test('FUNC-005: pedido finalizado pode ser cancelado somente pelo proprietario', async () => {
        const f = await fixture({ pedidoStatus: 'finalizado' }), url = '/api/pedidos/' + f.pedido.id + '/cancelar';
        json(await http.request('PUT', url, headers(outroCliente), {}), 403, 'Voce nao tem permissao para cancelar este pedido');
        assert.equal((await Pedido.findById(f.pedido.id)).status, 'finalizado');
        json(await http.request('PUT', url, headers(cliente), {}), 200, 'Pedido cancelado com sucesso');
        assert.equal((await Pedido.findById(f.pedido.id)).status, 'cancelado');
      });

      await t.test('status fora do enum retorna 500 real e nao altera estado persistido', async () => {
        const f = await fixture(), body = json(await agendar(f), 201), id = body.agendamento._id;
        const result = json(await http.request('PUT', '/api/agendamentos/' + id + '/status', headers(f.prestador),
          { status: 'invalido-ficticio' }), 500, 'Erro ao atualizar status');
        assert.ok(result.erro.includes('status'));
        assert.equal((await Agendamento.findById(id)).status, 'pendente');
      });

      await t.test('FUNC-004: duas leituras reais sincronizadas permitem duas reservas diretas iguais', async () => {
        const f = await fixture(), original = Agendamento.findOne;
        const descriptor = Object.getOwnPropertyDescriptor(Agendamento, 'findOne');
        let release, reads = 0, timer;
        const observed = [];
        const gate = new Promise((resolve, reject) => {
          release = resolve;
          timer = setTimeout(() => reject(Error('Barreira de concorrencia nao completou')), 3000);
        });
        // Consome a rejeicao mesmo se alguma requisicao falhar antes de alcancar a barreira.
        gate.catch(() => {});
        Agendamento.findOne = function (...args) {
          const query = original.apply(this, args), filter = args[0];
          if (filter.prestador_id.equals(f.prestador._id) && filter.data === f.data && filter.hora === '09:00') {
            const exec = query.exec;
            query.exec = async function (...params) {
              const result = await exec.apply(this, params); // Leitura real, nunca um resultado fabricado.
              observed.push(result === null);
              if (++reads === 2) release();
              await gate;
              return result;
            };
          }
          return query;
        };
        try {
          const responses = await Promise.all([agendar(f, cliente), agendar(f, outroCliente)]);
          for (const response of responses) json(response, 201, 'Servico agendado com sucesso');
          assert.deepEqual(observed, [true, true]);
        } finally {
          clearTimeout(timer);
          if (descriptor) Object.defineProperty(Agendamento, 'findOne', descriptor);
          else delete Agendamento.findOne;
        }
        const rows = await Agendamento.find({ prestador_id: f.prestador._id, data: f.data, hora: '09:00' });
        assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
        assert.deepEqual(rows.map(row => row.cliente_id.toString()).sort(), [cliente.id, outroCliente.id].sort());
      });

      assert.deepEqual(dispatches, [], 'Nenhum fluxo investigado deve usar controller sentinela');
      const brokenReferences = await Promise.all([
        Proposta.countDocuments({ pedido_id: { $exists: false } }), Agendamento.countDocuments({ servico_id: { $exists: false } })
      ]);
      assert.deepEqual(brokenReferences, [0, 0]);
      const linked = await Agendamento.find().populate('cliente_id', '_id').populate('prestador_id', '_id').populate('servico_id', '_id');
      assert.ok(linked.every(row => row.cliente_id && row.prestador_id && row.servico_id), 'Referencias das fixtures devem existir');
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
      ['insert', 'update', 'create', 'createIndexes'].includes(write.name)), 'Escritas restritas as colecoes temporarias autorizadas');
  }
});
