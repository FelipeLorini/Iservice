const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { disposableMongo } = require('./helpers/disposableMongo');
const { controllerStubs, loadController, startHttp } = require('./helpers/httpApp');

test('MVP: HTTP real da main com modelos reais e MongoDB exclusivamente descartavel', { timeout: 60000 }, async t => {
  const mongo = await disposableMongo(), db = new mongoose.Mongoose();
  t.after(async () => { try { await db.disconnect(); } finally { await mongo.cleanup(); } });
  const uri = new URL(mongo.uri);
  assert.equal(uri.hostname, '127.0.0.1'); assert.notEqual(Number(uri.port), 27017);
  assert.equal(uri.username, ''); assert.equal(uri.password, '');
  const databaseName = 'iservice_mvp_' + randomUUID().replaceAll('-', '');
  await db.connect(mongo.uri, { dbName: databaseName, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 2000 });
  assert.equal(db.connection.name, databaseName);
  assert.equal((await db.connection.db.admin().command({ serverStatus: 1 })).pid, mongo.pid);
  const models = {};
  for (const name of ['Usuario', 'Servico', 'Pedido', 'Proposta', 'Agendamento', 'Notificacao']) {
    const filename = path.join(__dirname, '../Models', name.toLowerCase() + 'Model.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
      require(dependency) {
        if (dependency === 'mongoose') return db;
        assert.equal(dependency, 'bcryptjs'); return bcrypt;
      }
    }, { filename });
    models[name] = module.exports;
    assert.equal(models[name].db, db.connection);
    await models[name].createCollection();
    await models[name].createIndexes(); // Somente schemas existentes no processo descartavel acima.
  }
  const secret = 'segredo-ficticio-mvp';
  const controllers = controllerStubs([]);
  const definitions = {
    CadastroController: { '../Models/usuarioModel': models.Usuario },
    LoginController: { '../Models/usuarioModel': models.Usuario, jsonwebtoken: jwt },
    ServicoController: { '../Models/servicoModel': models.Servico },
    agendamentoController: { '../Models/agendamentoModel': models.Agendamento, '../Models/servicoModel': models.Servico },
    pedidoController: { '../Models/pedidoModel': models.Pedido },
    usuarioController: { '../Models/usuarioModel': models.Usuario },
    propostaController: { '../Models/propostaModel': models.Proposta, '../Models/pedidoModel': models.Pedido,
      '../Models/agendamentoModel': models.Agendamento, '../Models/servicoModel': models.Servico,
      '../utils/notificacaoHelper': { criarNotificacao: (usuario_id, mensagem, tipo, link) => models.Notificacao.create({ usuario_id, mensagem, tipo, link }) } }
  };
  for (const [name, dependencies] of Object.entries(definitions)) {
    controllers[name] = loadController('controllers/' + name + '.js', dependencies, { secret });
  }
  const http = await startHttp(t, { controllers, secret });
  const request = async (method, url, token, body) => {
    const res = await http.request(method, '/api' + url, token ? { Authorization: 'Bearer ' + token } : {}, body);
    return { status: res.status, body: JSON.parse(res.text) };
  };
  const actors = {};
  await t.test('cadastro, hash e login reais preservam JWT e identidade das duas contas e de terceiro', async () => {
    for (const [label, tipo] of [['cliente', 'cliente'], ['prestador', 'prestador'], ['outro', 'cliente']]) {
      const input = { nome: 'Conta ficticia ' + label, email: label + '@example.invalid', senha: 'Senha-ficticia-123!', tipo, telefone: '00000000000' };
      const created = await request('POST', '/cadastro', null, input);
      assert.equal(created.status, 201); assert.equal(created.body.usuario.senha, undefined);
      const stored = await models.Usuario.findOne({ email: input.email });
      assert.notEqual(stored.senha, input.senha); assert.equal(await bcrypt.compare(input.senha, stored.senha), true);
      assert.equal((await request('POST', '/login', null, { email: input.email, senha: 'incorreta' })).status, 401);
      const login = await request('POST', '/login', null, input);
      assert.equal(login.status, 200);
      assert.equal(jwt.verify(login.body.token, secret).id, stored.id);
      actors[label] = { id: stored.id, token: login.body.token };
    }
  });
  await t.test('JWT ausente/invalido e papel prestador nao criam agendamento nem aceitam propostas', async () => {
    for (const [method, url] of [['POST', '/agendamentos'], ['PUT', '/propostas/' + '1'.repeat(24) + '/aceitar']]) {
      for (const [token, status] of [[null, 401], ['invalido', 401], [actors.prestador.token, 403]]) {
        assert.equal((await request(method, url, token, {})).status, status);
      }
    }
    assert.equal(await models.Agendamento.countDocuments(), 0);
  });
  let service;
  await t.test('catalogo carrega servico persistido pela API e somente prestador pode cadastrar', async () => {
    const body = { nome: 'Faxina de teste', descricao: 'Dados ficticios', preco: 100, categoria: 'faxina' };
    assert.equal((await request('POST', '/servicos', actors.cliente.token, body)).status, 403);
    assert.equal((await request('POST', '/servicos', actors.prestador.token, body)).status, 201);
    service = await models.Servico.findOne({ prestador_id: actors.prestador.id });
    const list = await request('GET', '/servicos');
    assert.equal(list.status, 200); assert.equal(list.body[0]._id, service.id);
    assert.equal(list.body[0].prestador_id.senha, undefined);
  });
  await t.test('contratacao direta persiste e aparece so no Dashboard da conta correta', async () => {
    const result = await request('POST', '/agendamentos', actors.cliente.token, {
      servico_id: service.id, data: '2035-05-20', hora: '14:00', cliente_id: actors.outro.id, prestador_id: actors.outro.id
    });
    assert.equal(result.status, 201);
    const stored = await models.Agendamento.findById(result.body.agendamento._id);
    assert.equal(String(stored.cliente_id), actors.cliente.id);
    assert.equal(String(stored.prestador_id), actors.prestador.id);
    assert.equal(stored.status, 'pendente');
    const list = await request('GET', '/agendamentos/cliente', actors.cliente.token);
    assert.equal(list.body.length, 1); assert.equal(list.body[0].servico_id.nome, service.nome);
    assert.deepEqual((await request('GET', '/agendamentos/cliente', actors.outro.token)).body, []);
    assert.equal((await request('GET', '/agendamentos/prestador', actors.prestador.token)).body.length, 1);
  });
  await t.test('horario ocupado e servico inexistente nao criam registros adicionais', async () => {
    assert.equal((await request('POST', '/agendamentos', actors.cliente.token, { servico_id: service.id, data: '2035-05-20', hora: '14:00' })).status, 400);
    assert.equal((await request('POST', '/agendamentos', actors.cliente.token, { servico_id: 'f'.repeat(24), data: '2035-05-21', hora: '14:00' })).status, 404);
    assert.equal(await models.Agendamento.countDocuments(), 1);
  });
  async function fixture({ pedidoStatus = 'aberto', propostaStatus = 'enviada', categoria = 'faxina' } = {}) {
    const pedido = await models.Pedido.create({ cliente_id: actors.cliente.id, titulo: 'Pedido ficticio', descricao: 'Teste', categoria,
      status: pedidoStatus, data_desejada: '2035-05-22' });
    const proposta = await models.Proposta.create({ pedido_id: pedido.id, prestador_id: actors.prestador.id, valor: 100, prazo: 'Dois dias', status: propostaStatus });
    return { pedido, proposta };
  }
  async function snapshot(f) {
    return JSON.stringify({ pedido: await models.Pedido.findById(f.pedido.id).lean(),
      proposta: await models.Proposta.findById(f.proposta.id).lean(),
      agendas: await models.Agendamento.find().lean(), notas: await models.Notificacao.find().lean() });
  }
  const accept = (f, token = actors.cliente.token) => request('PUT', '/propostas/' + f.proposta.id + '/aceitar', token);
  for (const status of ['em andamento', 'finalizado', 'cancelado']) {
    await t.test('pedido ' + status + ': 409 antes de qualquer gravacao', async () => {
      const f = await fixture({ pedidoStatus: status }), before = await snapshot(f);
      const res = await accept(f); assert.equal(res.status, 409);
      assert.equal(res.body.mensagem, 'Este pedido nao esta aberto para aceitar propostas');
      assert.equal(await snapshot(f), before);
    });
  }
  for (const status of ['aceita', 'recusada']) {
    await t.test('proposta ' + status + ': 409 antes de qualquer gravacao', async () => {
      const f = await fixture({ propostaStatus: status }), before = await snapshot(f);
      const res = await accept(f); assert.equal(res.status, 409);
      assert.equal(res.body.mensagem, 'Esta proposta nao esta disponivel para aceitacao');
      assert.equal(await snapshot(f), before);
    });
  }
  await t.test('sem servico correspondente: 409 preserva pedido, proposta, agenda e notificacoes', async () => {
    const f = await fixture({ categoria: 'pintura' }), before = await snapshot(f);
    const res = await accept(f); assert.equal(res.status, 409);
    assert.equal(res.body.mensagem, 'Nao existe servico correspondente para aceitar esta proposta');
    assert.equal(await snapshot(f), before);
  });
  await t.test('propriedade e ausencia de proposta continuam protegidas antes das novas guardas', async () => {
    const f = await fixture({ pedidoStatus: 'cancelado' }), before = await snapshot(f);
    assert.equal((await accept(f, actors.outro.token)).status, 403);
    assert.equal((await request('PUT', '/propostas/' + 'e'.repeat(24) + '/aceitar', actors.cliente.token)).status, 404);
    assert.equal(await snapshot(f), before);
  });
  await t.test('falha na consulta de servico nao deixa alteracoes parciais', async () => {
    const f = await fixture(), before = await snapshot(f), original = models.Servico.findOne;
    models.Servico.findOne = async () => { throw Error('Falha sintetica'); };
    try { assert.equal((await accept(f)).status, 500); }
    finally { models.Servico.findOne = original; }
    assert.equal(await snapshot(f), before);
  });
  await t.test('aceitacao antiga valida preserva resposta e horario; repeticao sequencial nao duplica', async () => {
    const f = await fixture(), before = await models.Agendamento.countDocuments();
    const res = await accept(f); assert.equal(res.status, 200);
    assert.equal(res.body.mensagem, 'Proposta aceita com sucesso');
    assert.equal(res.body.proposta.status, 'aceita');
    assert.equal(res.body.agendamento.hora, '09:00');
    assert.equal((await models.Pedido.findById(f.pedido.id)).status, 'em andamento');
    assert.equal(await models.Agendamento.countDocuments(), before + 1);
    assert.equal(await models.Notificacao.countDocuments(), 1);
    const state = await snapshot(f);
    assert.equal((await accept(f)).status, 409);
    assert.equal(await snapshot(f), state);
  });
  await t.test('perfil persistido: descricao isolada preserva portfolio e e visivel em nova leitura publica', async () => {
    const photos = ['https://example.invalid/portfolio.png'];
    assert.equal((await request('PUT', '/usuario/portifolio', actors.prestador.token, { portifolio: photos, descricao_detalhada: 'Anterior' })).status, 200);
    const result = await request('PUT', '/usuario/portifolio', actors.prestador.token, {
      descricao_detalhada: 'Descricao persistida da demonstracao', usuarioId: actors.outro.id
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.portifolio, photos);
    for (const token of [undefined, actors.cliente.token]) {
      const publicProfile = await request('GET', '/usuario/' + actors.prestador.id + '/perfil', token);
      assert.equal(publicProfile.status, 200);
      assert.equal(publicProfile.body.descricao_detalhada, 'Descricao persistida da demonstracao');
      assert.deepEqual(publicProfile.body.portifolio, photos);
      for (const field of ['email', 'telefone', 'senha', 'especialidade']) assert.equal(publicProfile.body[field], undefined);
    }
    assert.equal((await models.Usuario.findById(actors.outro.id)).descricao_detalhada, '');
    assert.equal((await models.Usuario.findById(actors.prestador.id)).descricao_detalhada, 'Descricao persistida da demonstracao');
  });
  await t.test('perfil: autenticacao e papel recusados nao alteram documentos', async () => {
    const before = JSON.stringify(await models.Usuario.find().lean());
    for (const [token, status] of [[undefined, 401], ['invalido', 401], [actors.cliente.token, 403]]) {
      assert.equal((await request('PUT', '/usuario/portifolio', token, { descricao_detalhada: 'Nao salvar', portifolio: [] })).status, status);
    }
    assert.equal(JSON.stringify(await models.Usuario.find().lean()), before);
  });
  await t.test('perfil: segundo prestador nao herda descricao nem sobrescreve o primeiro', async () => {
    const second = await models.Usuario.create({ nome: 'Outro prestador ficticio', email: 'prestador2@example.invalid',
      senha: 'Ficticia-123', tipo: 'prestador', telefone: '00000000000' });
    const token = jwt.sign({ id: second.id, tipo: 'prestador' }, secret);
    assert.equal((await request('PUT', '/usuario/portifolio', token, { descricao_detalhada: 'Descricao B', id: actors.prestador.id })).status, 200);
    assert.equal((await models.Usuario.findById(second.id)).descricao_detalhada, 'Descricao B');
    assert.equal((await models.Usuario.findById(actors.prestador.id)).descricao_detalhada, 'Descricao persistida da demonstracao');
  });
  await t.test('home e formulario desativado sao servidos pelo server real da main', async () => {
    for (const file of ['index.html', 'contratar.html', 'profissionais.html', 'login.html', 'cadastro.html']) {
      const res = await http.request('GET', '/' + file);
      assert.equal(res.status, 200);
      assert.equal(res.text, fs.readFileSync(path.join(__dirname, '../site-iservice-main', file), 'utf8'));
    }
  });
});
