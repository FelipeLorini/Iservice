'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const { disposableReplicaSet } = require('./disposableReplicaSet');
const { loadController, createRouteLoader } = require('./httpApp');
const { criarContratacaoVinculadaService } = require('../../services/contratacaoVinculadaService');

// Apenas fontes conhecidas, sem require livre, ambiente ou conexao global.
function loadFixtureSource(file, dependencies) {
  const filename = path.join(__dirname, '../..', file), module = { exports: {} };
  assert.equal(fs.realpathSync(filename), filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Import nao autorizado: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

// Definicoes locais do desenho aprovado. Nao instala indices em schemas/bancos externos.
const indices = [
  ['Agendamento', 'I1', { pedido_id: 1 }, { pedido_id: { $type: 'objectId' } }],
  ['Agendamento', 'I2', { proposta_id: 1 }, { proposta_id: { $type: 'objectId' } }],
  ['Pedido', 'I3', { 'contratacao.agendamento_id': 1 }, { 'contratacao.agendamento_id': { $type: 'objectId' } }],
  ['Pedido', 'I4', { 'contratacao.proposta_id': 1 }, { 'contratacao.proposta_id': { $type: 'objectId' } }],
  ['Notificacao', 'I5', { evento_chave: 1, usuario_id: 1 }, { evento_chave: { $type: 'string' } }],
  ['Usuario', 'email', { email: 1 }, undefined],
  ['Proposta', 'pedido_prestador', { pedido_id: 1, prestador_id: 1 }, undefined]
];
async function criarContratacaoLocalApp({ servirFrontend = false } = {}) {
  assert.equal(typeof servirFrontend, 'boolean');
  const replica = await disposableReplicaSet();
  const isolated = new mongoose.Mongoose(), connection = isolated.connection, models = {};
  isolated.set('bufferCommands', false);
  let server, closed = false, phase = 'PREPARACAO', active = 0, running = 0, transition;
  const drains = new Set();
  const completions = new Set();
  const waitForDrain = () => active ? new Promise(resolve => drains.add(resolve)) : Promise.resolve();
  const unavailable = (_, res) => res.status(409).json({ mensagem: 'Operacao indisponivel nesta fase da demonstracao local' });

  async function verificarProntidao() {
    assert.ok(!closed);
    const url = new URL(replica.uri);
    assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(Number(url.port), 27017);
    assert.equal(Number(url.port), replica.port);
    assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(connection.readyState, 1);
    assert.equal(connection.name, replica.databaseName);
    assert.match(connection.name, /^iservice_tx_[a-f0-9]{32}$/);
    assert.equal(connection.host, '127.0.0.1'); assert.equal(connection.port, replica.port);
    await replica.assertIdentity(connection.getClient());
    for (const model of Object.values(models)) assert.ok(model.db === connection, 'Model fora da conexao exclusiva');
    for (const [name, label, key, partial] of indices) {
      const actual = await models[name].collection.indexes();
      assert.ok(actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && index.unique === true &&
        JSON.stringify(index.partialFilterExpression) === JSON.stringify(partial)), `Indice ${label} invalido em ${models[name].collection.name}`);
    }
  }

  // Conta o handler completo, nao somente finish/close da resposta HTTP.
  function preparation(handler) {
    return async (req, res, next) => {
      if (closed || phase !== 'PREPARACAO') return unavailable(req, res);
      active++;
      try { await handler(req, res); } catch (error) { next(error); }
      finally {
        active--;
        if (!active) { for (const resolve of drains) resolve(); drains.clear(); }
      }
    };
  }
  function iniciarAceitacao() {
    assert.ok(server?.listening && !closed, 'HTTP local precisa estar iniciado');
    if (transition) return transition;
    phase = 'DRENANDO'; // Fecha admissao antes do primeiro await.
    transition = (async () => {
      await waitForDrain();
      assert.equal(active, 0); assert.ok(!closed);
      await verificarProntidao();
      phase = 'ACEITACAO';
    })();
    return transition;
  }
  // Bloqueio local APOS JWT/papel no Router e propriedade no recurso.
  function ownedBlock(model, field, missing, forbidden) {
    return async (req, res, next) => {
      try {
        const document = await model.findById(req.params.id);
        if (!document) return res.status(404).json({ mensagem: missing });
        if (String(document[field]) !== req.usuarioId) return res.status(403).json({ mensagem: forbidden });
        return unavailable(req, res);
      } catch (error) { next(error); }
    };
  }
  async function encerrar() {
    if (closed) return;
    closed = true;
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (running) await new Promise(resolve => completions.add(resolve));
    } finally {
      try { await connection.close(); } finally { await replica.cleanup(); }
    }
  }

  try {
    await connection.openUri(replica.uri, { dbName: replica.databaseName, autoIndex: false, autoCreate: false,
      bufferCommands: false, serverSelectionTimeoutMS: 3000 });
    await replica.assertIdentity(connection.getClient());
    assert.equal(connection.name, replica.databaseName);
    for (const name of ['Usuario', 'Servico', 'Pedido', 'Proposta', 'Agendamento', 'Notificacao']) {
      models[name] = loadFixtureSource(`Models/${name.toLowerCase()}Model.js`, { mongoose: isolated, bcryptjs: require('bcryptjs') });
      assert.equal(models[name].db, connection);
      await models[name].createCollection();
      await models[name].createIndexes();
    }
    for (const [name, label, key, partial] of indices.slice(0, 5)) {
      await models[name].collection.createIndex(key, { name: label, unique: true, partialFilterExpression: partial });
    }
    await verificarProntidao();
    const secret = randomBytes(32).toString('hex'); // Nunca usa JWT_SECRET do ambiente.
    const load = (name, dependencies) => loadController(`controllers/${name}.js`, dependencies, { secret });
    const userDeps = { '../Models/usuarioModel': models.Usuario };
    const cadastro = load('CadastroController', userDeps);
    const login = load('LoginController', { ...userDeps, jsonwebtoken: require('jsonwebtoken') });
    const pedido = load('pedidoController', { '../Models/pedidoModel': models.Pedido });
    const servico = load('ServicoController', { '../Models/servicoModel': models.Servico });
    const agenda = load('agendamentoController', { '../Models/agendamentoModel': models.Agendamento, '../Models/servicoModel': models.Servico });
    const nota = load('notificacaoController', { '../Models/notificacaoModel': models.Notificacao });
    const notificationHelper = loadFixtureSource('utils/notificacaoHelper.js', { '../Models/notificacaoModel': models.Notificacao });
    const proposta = load('propostaController', {
      '../Models/propostaModel': models.Proposta, '../Models/pedidoModel': models.Pedido,
      '../utils/notificacaoHelper': notificationHelper,
      // Dependencia deliberadamente indisponivel: nenhum import do escritor antigo.
      '../services/propostaService': Object.freeze({})
    });
    const { criarAceitacaoVinculadaController } = load('aceitacaoVinculadaController', {});
    const service = criarContratacaoVinculadaService(models);
    const adapter = criarAceitacaoVinculadaController(service);
    const controllers = {
      CadastroController: { cadastrar: preparation(cadastro.cadastrar) },
      LoginController: { login: preparation(login.login) },
      pedidoController: { ...pedido,
        criarPedido: preparation(pedido.criarHandlerCriarPedido({ model: models.Pedido, certificar: true })),
        cancelarPedido: ownedBlock(models.Pedido, 'cliente_id', 'Pedido nao encontrado', 'Voce nao tem permissao para cancelar este pedido') },
      ServicoController: { ...servico, cadastrarServico: preparation(servico.cadastrarServico),
        deletarServico: ownedBlock(models.Servico, 'prestador_id', 'Servico nao encontrado', 'Voce nao tem permissao para deletar este servico') },
      propostaController: { ...proposta, criarProposta: preparation(proposta.criarProposta),
        aceitarProposta: (req, res) => phase === 'ACEITACAO' && !closed ? adapter.aceitarProposta(req, res) : unavailable(req, res) },
      agendamentoController: { ...agenda, agendarServico: unavailable,
        atualizarStatusAgendamento: ownedBlock(models.Agendamento, 'prestador_id', 'Agendamento nao encontrado', 'Voce nao tem permissao para alterar este agendamento'),
        cancelarAgendamento: ownedBlock(models.Agendamento, 'cliente_id', 'Agendamento nao encontrado', 'Voce nao tem permissao para cancelar este agendamento') },
      notificacaoController: nota
    };
    assert.notEqual(controllers.propostaController.aceitarProposta, proposta.aceitarProposta);
    // close HTTP nao garante que um handler de cliente desconectado terminou.
    // Tambem drenar os handlers de aceitacao/leitura antes de fechar a conexao.
    const trackedControllers = Object.fromEntries(Object.entries(controllers).map(([name, handlers]) => [name,
      Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, async (req, res, next) => {
        if (closed) return unavailable(req, res);
        running++;
        try { await handler(req, res, next); } catch (error) { next(error); }
        finally {
          running--;
          if (!running) { for (const resolve of completions) resolve(); completions.clear(); }
        }
      }]))
    ]));
    const route = createRouteLoader({ controllers: trackedControllers, secret }), app = express();
    app.use(express.json());
    for (const [prefix, file] of [
      ['', 'authRoutes'], ['/servicos', 'servicoRoutes'], ['/pedidos', 'pedidoRoutes'],
      ['/propostas', 'propostaRoutes'], ['/agendamentos', 'agendamentoRoutes'], ['/notificacoes', 'notificacaoRoutes']
    ]) app.use('/api' + prefix, route(`routes/${file}.js`));
    if (servirFrontend) {
      const publicRoot = path.resolve(__dirname, '../../site-iservice-main');
      assert.equal(fs.realpathSync(publicRoot), publicRoot);
      const extensions = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.gif', '.woff', '.woff2', '.ttf']);
      app.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(404);
        let pathname;
        try { pathname = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
        if (pathname === '/') pathname = '/index.html';
        if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.')) ||
          !extensions.has(path.extname(pathname).toLowerCase())) return res.sendStatus(404);
        const filename = path.resolve(publicRoot, '.' + pathname);
        if (!filename.startsWith(publicRoot + path.sep)) return res.sendStatus(404);
        try {
          // Nao servir links, atalhos para o repositorio, diretorios ou arquivos internos.
          if (fs.realpathSync(filename) !== filename || !fs.statSync(filename).isFile()) return res.sendStatus(404);
        } catch { return res.sendStatus(404); }
        next();
      }, express.static(publicRoot, { dotfiles: 'deny', redirect: false, index: 'index.html' }));
    }
    app.use((error, req, res, next) => res.status(500).json({ mensagem: 'Erro na demonstracao local' }));
    return {
      models, connection, replica,
      get fase() { return phase; }, get preparacoesAtivas() { return active; },
      get escutando() { return Boolean(server?.listening); },
      get url() { return server?.listening ? `http://127.0.0.1:${server.address().port}/` : null; },
      verificarProntidao, iniciarAceitacao, encerrar,
      async iniciarHttp() {
        assert.ok(!server, 'HTTP ja iniciado');
        await verificarProntidao();
        server = await new Promise((resolve, reject) => {
          const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
          listener.once('error', reject);
        });
      },
      async request(method, endpoint, token, body) {
        assert.ok(server?.listening && !closed);
        assert.ok(endpoint.startsWith('/api/'));
        const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
          method, headers: { Connection: 'close', ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
        });
        const text = await response.text();
        return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
      }
    };
  } catch (error) {
    try { await encerrar(); } catch (cleanupError) { throw new AggregateError([error, cleanupError]); }
    throw error;
  }
}

module.exports = { criarContratacaoLocalApp };
