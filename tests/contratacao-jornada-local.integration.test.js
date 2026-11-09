'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { criarContratacaoLocalApp } = require('./helpers/contratacaoLocalApp');
const { loadController } = require('./helpers/httpApp');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function json(response, status) { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; }
const accept = id => `/api/propostas/${id}/aceitar`;

test('Jornada HTTP real em replica set exclusivo: preparacao, barreira e contratacao', { timeout: 90000 }, async t => {
  const local = await criarContratacaoLocalApp();
  t.after(() => local.encerrar());
  const { models, connection, replica } = local;
  const request = local.request;
  const sessions = [], startSession = connection.startSession;
  connection.startSession = async function (...args) {
    const session = await startSession.apply(this, args); sessions.push(session); return session;
  };
  const snapshot = async () => plain(await Promise.all(Object.values(models).map(model => model.find().sort({ _id: 1 }).lean())));

  await t.test('prontidao exige identidade real e Models na mesma conexao antes de abrir HTTP', async () => {
    assert.equal(local.escutando, false);
    const original = replica.assertIdentity;
    replica.assertIdentity = async () => { throw Error('Falha de identidade injetada'); };
    try { await assert.rejects(local.iniciarHttp(), /Falha de identidade/); } finally { replica.assertIdentity = original; }
    assert.equal(local.escutando, false);
    const db = models.Pedido.db;
    models.Pedido.db = {};
    try { await assert.rejects(local.iniciarHttp()); } finally { models.Pedido.db = db; }
    assert.equal(local.escutando, false);
    assert.equal(await models.Usuario.countDocuments(), 0);
  });

  for (const [name, label] of [['Agendamento', 'I1'], ['Agendamento', 'I2'], ['Pedido', 'I3'], ['Pedido', 'I4'], ['Notificacao', 'I5']]) {
    await t.test(`${label}: chave, unicidade, filtro e colecao sao obrigatorios, nome nao basta`, async () => {
      const collection = models[name].collection, original = collection.indexes;
      for (const corrupt of [index => ({ ...index, key: { outra_chave: 1 } }), index => ({ ...index, unique: false }),
        index => ({ ...index, partialFilterExpression: {} }), () => null]) {
        collection.indexes = async function () { return (await original.call(this)).map(index => index.name === label ? corrupt(index) : index).filter(Boolean); };
        try { await assert.rejects(local.iniciarHttp(), new RegExp(`Indice ${label} invalido`)); }
        finally { collection.indexes = original; }
        assert.equal(local.escutando, false);
      }
    });
  }
  await t.test('indices preexistentes e replica primary sao conferidos; HTTP inicia apenas apos prontidao', async () => {
    for (const name of ['Usuario', 'Proposta']) {
      const collection = models[name].collection, original = collection.indexes;
      collection.indexes = async function () { return (await original.call(this)).filter(index => !index.unique); };
      try { await assert.rejects(local.iniciarHttp(), /Indice .* invalido/); } finally { collection.indexes = original; }
      assert.equal(local.escutando, false);
    }
    await local.verificarProntidao();
    await local.iniciarHttp();
    assert.equal(local.escutando, true);
    assert.equal(local.fase, 'PREPARACAO');
    assert.equal((await replica.client.db('admin').command({ hello: 1 })).isWritablePrimary, true);
  });

  const accounts = {};
  await t.test('cadastro e login reais de cinco contas ficticias, hashing e JWT emitido pelo backend', async () => {
    for (const [name, tipo] of [['cliente', 'cliente'], ['outroCliente', 'cliente'], ['prestador', 'prestador'], ['concorrente', 'prestador'], ['semServico', 'prestador']]) {
      const body = { nome: `Fixture ${name}`, email: `${name}@example.invalid`, senha: 'Senha-ficticia-123!', tipo, telefone: '00000000000' };
      const registered = json(await request('POST', '/api/cadastro', undefined, body), 201);
      assert.equal(registered.usuario.tipo, tipo); assert.equal(registered.usuario.senha, undefined);
      const stored = await models.Usuario.findById(registered.usuario.id);
      assert.notEqual(stored.senha, body.senha); assert.equal(await stored.compararSenha(body.senha), true);
      const login = json(await request('POST', '/api/login', undefined, { email: body.email, senha: body.senha }), 200);
      assert.equal(login.usuario.id, registered.usuario.id); assert.ok(login.token);
      assert.ok((await models.Usuario.findById(registered.usuario.id)).ultimo_login);
      accounts[name] = { id: registered.usuario.id, token: login.token, nome: body.nome };
    }
    json(await request('POST', '/api/login', undefined, { email: 'cliente@example.invalid', senha: 'errada' }), 401);
  });
  let service, main, competing, rollback, race, legacy, missing, ambiguous;
  const pedidoBody = (titulo, categoria = 'faxina') => ({ titulo, descricao: 'Ensaio ficticio descartavel', categoria, data_desejada: '2035-04-20' });
  const proposalBody = pedido => ({ pedido_id: pedido._id, valor: 100, prazo: 'Dois dias', descricao: 'Proposta ficticia' });
  const createPedido = async (title, categoria) => json(await request('POST', '/api/pedidos', accounts.cliente.token, pedidoBody(title, categoria)), 201).pedido;
  const createProposal = async (pedido, actor = accounts.prestador) => json(await request('POST', '/api/propostas', actor.token, proposalBody(pedido)), 201).proposta;

  await t.test('JWT ausente/invalido e papel incorreto bloqueiam endpoints antes de gravar', async () => {
    const before = await snapshot();
    for (const [method, url, role] of [['POST', '/api/servicos', 'cliente'], ['POST', '/api/pedidos', 'prestador'],
      ['POST', '/api/propostas', 'cliente'], ['PUT', accept('111111111111111111111111'), 'prestador'],
      ['GET', '/api/agendamentos/cliente', 'prestador'], ['GET', '/api/agendamentos/prestador', 'cliente']]) {
      for (const [token, status] of [[undefined, 401], ['invalido', 401], [accounts[role].token, 403]]) {
        json(await request(method, url, token, method === 'GET' ? undefined : {}), status);
      }
    }
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('servico e Pedido certificados usam identidade da sessao e ignoram campos forjados', async () => {
    const body = { nome: 'Faxina ficticia', descricao: 'Ensaio', preco: 100, categoria: 'faxina', prestador_id: accounts.concorrente.id };
    service = json(await request('POST', '/api/servicos', accounts.prestador.token, body), 201).servico;
    assert.equal(service.prestador_id, accounts.prestador.id);
    for (const marker of [undefined, 0, 99, { falso: true }]) {
      const pedido = json(await request('POST', '/api/pedidos', accounts.cliente.token, {
        ...pedidoBody('Pedido certificado'), fluxo_contratacao: marker, cliente_id: accounts.outroCliente.id,
        status: 'finalizado', contratacao: { proposta_id: '111111111111111111111111' }
      }), 201).pedido;
      assert.equal(pedido.fluxo_contratacao, 1); assert.equal(pedido.cliente_id, accounts.cliente.id);
      assert.equal(pedido.status, 'aberto'); assert.equal(pedido.contratacao, undefined);
      assert.equal((await models.Pedido.findById(pedido._id)).fluxo_contratacao, 1);
      main = pedido;
    }
  });
  await t.test('exportacao padrao continua sem certificar; legado nao recebe marcador do body', async () => {
    // Fixture legada pelo handler real padrao, sem mudar a composicao HTTP certificada.
    const controller = loadController('controllers/pedidoController.js', { '../Models/pedidoModel': models.Pedido });
    let status, result;
    await controller.criarPedido({ usuarioId: accounts.cliente.id, body: { ...pedidoBody('Legado'), fluxo_contratacao: 1 } },
      { status(value) { status = value; return this; }, json(value) { result = plain(value); } });
    assert.equal(status, 201); legacy = result.pedido;
    assert.equal(legacy.fluxo_contratacao, undefined);
    assert.equal((await models.Pedido.findById(legacy._id)).fluxo_contratacao, undefined);
  });
  await t.test('propostas reais, notificacao de envio e leitura populada preservam propriedade', async () => {
    const winner = await createProposal(main);
    competing = await createProposal(main, accounts.concorrente);
    main.proposta = winner;
    assert.equal(winner.prestador_id, accounts.prestador.id);
    json(await request('POST', '/api/propostas', accounts.prestador.token, proposalBody(main)), 400);
    const list = json(await request('GET', `/api/propostas/pedido/${main._id}`, accounts.cliente.token), 200);
    assert.equal(list.length, 2); assert.ok(list.some(p => p.prestador_id.nome === accounts.prestador.nome));
    json(await request('GET', `/api/propostas/pedido/${main._id}`, accounts.outroCliente.token), 403);
    assert.equal(await models.Notificacao.countDocuments({ usuario_id: accounts.cliente.id, tipo: 'nova_proposta' }), 2);
  });
  await t.test('aceitacao bloqueada em preparacao; escritores incompatíveis preservam dados e propriedade', async () => {
    const before = await snapshot();
    json(await request('PUT', accept(main.proposta._id), accounts.cliente.token), 409);
    for (const [actor, expected] of [[accounts.cliente, 409], [accounts.outroCliente, 403], [accounts.prestador, 403]]) {
      json(await request('PUT', `/api/pedidos/${main._id}/cancelar`, actor.token), expected);
    }
    for (const [actor, expected] of [[accounts.prestador, 409], [accounts.concorrente, 403], [accounts.cliente, 403]]) {
      json(await request('DELETE', `/api/servicos/${service._id}`, actor.token), expected);
    }
    json(await request('POST', '/api/agendamentos', accounts.cliente.token, { servico_id: service._id, data: '2035-04-20', hora: '09:00' }), 409);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('prepara cenarios reais de rollback, concorrencia, legado, ausencia e ambiguidade', async () => {
    legacy.proposta = await createProposal(legacy);
    rollback = await createPedido('Rollback'); rollback.proposta = await createProposal(rollback);
    race = await createPedido('Disputa'); race.propostas = [await createProposal(race), await createProposal(race, accounts.concorrente)];
    missing = await createPedido('Sem servico'); missing.proposta = await createProposal(missing, accounts.semServico);
    ambiguous = await createPedido('Ambiguo', 'pintura'); ambiguous.proposta = await createProposal(ambiguous);
    for (let i = 0; i < 2; i++) json(await request('POST', '/api/servicos', accounts.prestador.token,
      { nome: `Pintura ${i}`, descricao: 'Ficticio', preco: 100, categoria: 'pintura' }), 201);
    json(await request('POST', '/api/servicos', accounts.concorrente.token,
      { nome: 'Faxina concorrente', descricao: 'Ficticio', preco: 110, categoria: 'faxina' }), 201);
  });
  await t.test('barreira drena escrita real admitida e rejeita proposta/servico tardios antes de liberar aceitacao', async () => {
    const pending = await createPedido('Proposta em andamento');
    const entered = deferred(), release = deferred(), original = models.Proposta.create;
    models.Proposta.create = async function (...args) {
      const document = await original.apply(this, args); // Gravacao real antes do atraso controlado.
      entered.resolve(); await release.promise; return document;
    };
    let inflight, transition;
    try {
      inflight = request('POST', '/api/propostas', accounts.prestador.token, proposalBody(pending));
      await entered.promise;
      assert.equal(local.preparacoesAtivas, 1);
      transition = local.iniciarAceitacao();
      assert.equal(local.fase, 'DRENANDO');
      const before = await snapshot();
      json(await request('POST', '/api/propostas', accounts.concorrente.token, proposalBody(pending)), 409);
      json(await request('POST', '/api/servicos', accounts.prestador.token, { nome: 'Tardio' }), 409);
      json(await request('PUT', accept(main.proposta._id), accounts.cliente.token), 409);
      assert.equal(local.fase, 'DRENANDO'); assert.equal(local.preparacoesAtivas, 1);
      assert.deepEqual(await snapshot(), before);
    } finally {
      release.resolve(); models.Proposta.create = original;
      if (inflight) json(await inflight, 201);
      if (transition) await transition;
    }
    assert.equal(local.fase, 'ACEITACAO'); assert.equal(local.preparacoesAtivas, 0);
    assert.equal(await models.Proposta.countDocuments({ pedido_id: pending._id }), 1);
    assert.equal(await models.Notificacao.countDocuments({ usuario_id: accounts.cliente.id, tipo: 'nova_proposta' }), 9);
    await local.iniciarAceitacao(); assert.equal(local.fase, 'ACEITACAO');
  });
  await t.test('outra conta nao aceita mesmo forjando cliente no body; nenhuma persistencia muda', async () => {
    const before = await snapshot();
    json(await request('PUT', accept(main.proposta._id), accounts.outroCliente.token, { clienteId: accounts.cliente.id }), 403);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('PUT usa novo service transacional real e persiste todos os vinculos coerentes', async () => {
    const result = json(await request('PUT', accept(main.proposta._id), accounts.cliente.token, { propostaId: competing._id }), 200);
    assert.equal(result.mensagem, 'Proposta aceita com sucesso');
    assert.deepEqual(Object.keys(result).sort(), ['agendamento', 'mensagem', 'proposta']);
    const pedido = await models.Pedido.findById(main._id).lean(), proposta = await models.Proposta.findById(main.proposta._id).lean();
    const agenda = await models.Agendamento.findById(result.agendamento._id).lean();
    assert.equal(pedido.status, 'em andamento'); assert.equal(proposta.status, 'aceita');
    assert.equal(String(pedido.contratacao.proposta_id), main.proposta._id);
    assert.equal(String(pedido.contratacao.agendamento_id), String(agenda._id));
    assert.equal(String(pedido.contratacao.servico_id), service._id); assert.equal(String(proposta.servico_id), service._id);
    assert.equal(agenda.origem, 'proposta'); assert.equal(String(agenda.pedido_id), main._id);
    assert.equal(String(agenda.proposta_id), main.proposta._id); assert.equal(String(agenda.servico_id), service._id);
    assert.equal(String(agenda.cliente_id), accounts.cliente.id); assert.equal(String(agenda.prestador_id), accounts.prestador.id);
    assert.equal(agenda.hora, '09:00'); assert.equal(agenda.data.toISOString(), new Date(main.data_desejada).toISOString());
    assert.equal((await models.Proposta.findById(competing._id)).status, 'recusada');
    assert.equal(await models.Proposta.countDocuments({ pedido_id: main._id, status: 'aceita' }), 1);
    main.agenda = String(agenda._id);
    const notas = await models.Notificacao.find({ pedido_id: main._id }); assert.equal(notas.length, 1);
    assert.equal(notas[0].evento_chave, `pedido:${main._id}:proposta_aceita:v1`);
    assert.equal(String(notas[0].usuario_id), accounts.prestador.id); main.nota = String(notas[0]._id);
  });
  await t.test('GETs reais preservam nomes, titulo, filtros de conta e notificacoes', async () => {
    const clienteAgenda = json(await request('GET', '/api/agendamentos/cliente', accounts.cliente.token), 200);
    assert.equal(clienteAgenda.length, 1); assert.equal(clienteAgenda[0].servico_id.nome, service.nome);
    assert.equal(clienteAgenda[0].prestador_id.nome, accounts.prestador.nome);
    const prestadorAgenda = json(await request('GET', '/api/agendamentos/prestador', accounts.prestador.token), 200);
    assert.equal(prestadorAgenda[0].cliente_id.nome, accounts.cliente.nome);
    assert.equal(prestadorAgenda[0].servico_id.nome, service.nome);
    const propostas = json(await request('GET', '/api/propostas/prestador', accounts.prestador.token), 200);
    assert.equal(propostas.find(p => p._id === main.proposta._id).pedido_id.titulo, main.titulo);
    const notas = json(await request('GET', '/api/notificacoes', accounts.prestador.token), 200);
    assert.equal(notas.length, 1); assert.equal(notas[0].link, '/dashboard-prestador.html');
    assert.equal(json(await request('GET', '/api/notificacoes/nao-lidas', accounts.prestador.token), 200).total, 1);
    for (const url of ['/api/pedidos/cliente', '/api/agendamentos/cliente', '/api/notificacoes']) {
      assert.deepEqual(json(await request('GET', url, accounts.outroCliente.token), 200), []);
    }
    assert.deepEqual(json(await request('GET', '/api/agendamentos/prestador', accounts.concorrente.token), 200), []);
    assert.ok(json(await request('GET', '/api/pedidos/abertos', accounts.prestador.token), 200).every(p => p.cliente_id.nome));
  });
  await t.test('lida respeita propriedade; replay preserva IDs, contagens e lida sem evento duplicado', async () => {
    json(await request('PUT', `/api/notificacoes/${main.nota}/lida`, accounts.outroCliente.token), 403);
    assert.equal((await models.Notificacao.findById(main.nota)).lida, false);
    json(await request('PUT', `/api/notificacoes/${main.nota}/lida`, accounts.prestador.token), 200);
    const before = await snapshot();
    const result = json(await request('PUT', accept(main.proposta._id), accounts.cliente.token), 200);
    assert.equal(result.mensagem, 'Contratacao existente recuperada com sucesso');
    assert.equal(result.proposta._id, main.proposta._id); assert.equal(result.agendamento._id, main.agenda);
    assert.deepEqual(await snapshot(), before);
    assert.equal(json(await request('GET', '/api/notificacoes/nao-lidas', accounts.prestador.token), 200).total, 0);
  });
  await t.test('legado e conflitos nao fazem fallback para aceitacao antiga nem alteram dados', async () => {
    const before = await snapshot();
    for (const [proposal, mensagem] of [[legacy.proposta, 'Este pedido precisa de revisao antes da contratacao'],
      [competing, 'Outra proposta ja foi aceita para este pedido'],
      [missing.proposta, 'Nao existe servico correspondente para aceitar esta proposta'],
      [ambiguous.proposta, 'Nao foi possivel determinar qual servico contratar']]) {
      assert.deepEqual(json(await request('PUT', accept(proposal._id), accounts.cliente.token), 409), { mensagem });
    }
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('falha apos escrita transacional real da notificacao aborta Pedido, propostas, agenda e evento', async () => {
    const before = await snapshot(), original = models.Notificacao.create;
    let injected = false;
    models.Notificacao.create = async function (...args) {
      const result = await original.apply(this, args);
      if (args[1]?.session) { injected = true; throw Error('Falha controlada apos insert real'); }
      return result;
    };
    try {
      assert.deepEqual(json(await request('PUT', accept(rollback.proposta._id), accounts.cliente.token), 500), { mensagem: 'Erro ao aceitar proposta' });
    } finally { models.Notificacao.create = original; }
    assert.equal(injected, true); assert.deepEqual(await snapshot(), before);
  });
  await t.test('duas aceitacoes HTTP concorrentes deixam somente um vencedor, agenda e evento', async () => {
    const results = await Promise.all(race.propostas.map(p => request('PUT', accept(p._id), accounts.cliente.token)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(await models.Proposta.countDocuments({ pedido_id: race._id, status: 'aceita' }), 1);
    assert.equal(await models.Agendamento.countDocuments({ pedido_id: race._id }), 1);
    assert.equal(await models.Notificacao.countDocuments({ pedido_id: race._id, tipo: 'proposta_aceita' }), 1);
    const winner = results.find(r => r.status === 200).body;
    const replay = json(await request('PUT', accept(winner.proposta._id), accounts.cliente.token), 200);
    assert.equal(replay.agendamento._id, winner.agendamento._id);
  });
  await t.test('bloqueios permanentes verificam JWT, papel e propriedade; nenhuma escrita mesmo apos contratar', async () => {
    const before = await snapshot();
    const cases = [
      ['PUT', `/api/pedidos/${main._id}/cancelar`, accounts.cliente, accounts.outroCliente, accounts.prestador],
      ['DELETE', `/api/servicos/${service._id}`, accounts.prestador, accounts.concorrente, accounts.cliente],
      ['PUT', `/api/agendamentos/${main.agenda}/cancelar`, accounts.cliente, accounts.outroCliente, accounts.prestador],
      ['PUT', `/api/agendamentos/${main.agenda}/status`, accounts.prestador, accounts.concorrente, accounts.cliente]
    ];
    for (const [method, url, owner, stranger, wrongRole] of cases) {
      for (const [token, status] of [[undefined, 401], ['invalido', 401], [wrongRole.token, 403], [stranger.token, 403], [owner.token, 409]]) {
        json(await request(method, url, token, { status: 'cancelado' }), status);
      }
      json(await request(method, url.replace(/\/[a-f0-9]{24}/, '/111111111111111111111111'), owner.token), 404);
    }
    json(await request('POST', '/api/agendamentos', accounts.cliente.token, {}), 409);
    json(await request('POST', '/api/agendamentos', accounts.prestador.token, {}), 403);
    json(await request('POST', '/api/propostas', accounts.prestador.token, proposalBody(main)), 409);
    json(await request('POST', '/api/servicos', accounts.prestador.token, {}), 409);
    json(await request('POST', '/api/pedidos', accounts.cliente.token, pedidoBody('Tardio')), 409);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('controle de fase nao possui endpoint publico; endpoints fora da jornada nao sao montados', async () => {
    for (const url of ['/api/iniciar-aceitacao', '/api/preparacao', '/api/chat']) assert.equal((await request('POST', url, accounts.cliente.token, {})).status, 404);
    assert.equal(local.fase, 'ACEITACAO');
  });
  await t.test('sessoes, HTTP, conexao, processo e diretorio exclusivos sao encerrados', async () => {
    assert.ok(sessions.length > 0); assert.ok(sessions.every(session => session.hasEnded));
    await local.encerrar();
    assert.equal(local.escutando, false); assert.equal(connection.readyState, 0);
    await assert.rejects(fs.stat(replica.directory), { code: 'ENOENT' });
    assert.throws(() => process.kill(replica.pid, 0));
    await assert.rejects(local.request('GET', '/api/servicos'));
    await assert.rejects(local.iniciarHttp());
  });
});
