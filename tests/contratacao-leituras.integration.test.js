const test = require('node:test');
const assert = require('node:assert/strict');
const { criarContratacaoLocalApp } = require('./helpers/contratacaoLocalApp');
const plain = value => JSON.parse(JSON.stringify(value));
// Contratos anteriores explicitos, independentes das constantes dos controllers.
const fields = {
  pedido: ['_id', 'cliente_id', 'titulo', 'descricao', 'categoria', 'data_desejada', 'status', 'data_criacao', '__v'],
  proposta: ['_id', 'pedido_id', 'prestador_id', 'valor', 'prazo', 'descricao', 'status', 'data_criacao', '__v'],
  agenda: ['_id', 'cliente_id', 'prestador_id', 'servico_id', 'data', 'hora', 'status', 'data_criacao', '__v'],
  nota: ['_id', 'usuario_id', 'mensagem', 'tipo', 'lida', 'link', 'data_criacao', '__v']
};
const pick = (document, names) => Object.fromEntries(names.map(name => [name, plain(document)[name]]));
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }

test('GETs reais preservam contratos legados e ocultam coordenacao de documentos vinculados', { timeout: 90000 }, async t => {
  const local = await criarContratacaoLocalApp(); t.after(() => local.encerrar());
  await local.iniciarHttp();
  const { models, request } = local;
  const accounts = {};
  for (const [name, tipo] of [['cliente', 'cliente'], ['prestador', 'prestador'], ['outroCliente', 'cliente'], ['outroPrestador', 'prestador']]) {
    const data = { nome: `Fixture ${name}`, email: `${name}@example.invalid`, senha: 'Senha-Ficticia-123!', telefone: '00000000000', tipo };
    const registered = await request('POST', '/api/cadastro', undefined, data); assert.equal(registered.status, 201);
    const login = await request('POST', '/api/login', undefined, { email: data.email, senha: data.senha }); assert.equal(login.status, 200);
    accounts[name] = { ...data, id: registered.body.usuario.id, token: login.body.token };
  }
  async function fixture(certified, foreign = false) {
    const cliente = accounts[foreign ? 'outroCliente' : 'cliente'], prestador = accounts[foreign ? 'outroPrestador' : 'prestador'];
    const servico = await models.Servico.create({ nome: 'Servico ficticio', descricao: 'Descricao publica', preco: 100, categoria: 'faxina', prestador_id: prestador.id });
    const pedido = await models.Pedido.create({ cliente_id: cliente.id, titulo: 'Pedido ficticio', descricao: 'Descricao publica',
      categoria: 'faxina', data_desejada: new Date('2035-04-20'), status: 'em andamento', ...(certified ? { fluxo_contratacao: 1 } : {}) });
    const proposta = await models.Proposta.create({ pedido_id: pedido._id, prestador_id: prestador.id, valor: 100, prazo: 'Dois dias', descricao: 'Termos publicos',
      status: 'aceita', ...(certified ? { servico_id: servico._id } : {}) });
    const agenda = await models.Agendamento.create({ cliente_id: cliente.id, prestador_id: prestador.id, servico_id: servico._id,
      data: pedido.data_desejada, hora: '09:00', status: 'pendente', ...(certified ? { origem: 'proposta', pedido_id: pedido._id, proposta_id: proposta._id } : {}) });
    if (certified) {
      pedido.contratacao = { proposta_id: proposta._id, servico_id: servico._id, agendamento_id: agenda._id }; await pedido.save();
    }
    const nota = await models.Notificacao.create({ usuario_id: prestador.id, mensagem: 'Sua proposta foi aceita pelo cliente', tipo: 'proposta_aceita',
      link: '/dashboard-prestador.html', lida: certified,
      ...(certified ? { pedido_id: pedido._id, evento_chave: `pedido:${pedido._id}:proposta_aceita:v1` } : {}) });
    return { servico, pedido, proposta, agenda, nota, cliente, prestador };
  }
  const fixtures = [await fixture(false), await fixture(true)], foreign = await fixture(true, true);
  const aberto = await models.Pedido.create({ cliente_id: accounts.cliente.id, titulo: 'Pedido aberto', descricao: 'Publico',
    categoria: 'pintura', data_desejada: new Date('2035-05-01'), fluxo_contratacao: 1 });
  const snapshot = async () => plain(await Promise.all(Object.values(models).map(model => model.find().sort({ _id: 1 }).lean())));
  const before = await snapshot();
  async function get(url, actor, status = 200) {
    const res = await request('GET', url, actor?.token); assert.equal(res.status, status, JSON.stringify(res.body)); return res.body;
  }
  for (const [index, label] of ['legado', 'vinculado'].entries()) {
    const f = fixtures[index];
    await t.test(`${label}: pedidos mantem campos publicos e filtro JWT`, async () => {
      const rows = await get('/api/pedidos/cliente?cliente_id=' + accounts.outroCliente.id, accounts.cliente);
      const row = rows.find(row => row._id === String(f.pedido._id));
      keys(row, fields.pedido); assert.deepEqual(row, pick(f.pedido, fields.pedido));
      assert.ok(!rows.some(row => row._id === String(foreign.pedido._id)));
    });
    await t.test(`${label}: propostas do cliente preservam prestador populado sem ampliar dados pessoais`, async () => {
      const rows = await get(`/api/propostas/pedido/${f.pedido._id}`, accounts.cliente);
      assert.equal(rows.length, 1); keys(rows[0], fields.proposta);
      assert.deepEqual(rows[0], { ...pick(f.proposta, fields.proposta),
        prestador_id: { _id: f.prestador.id, nome: f.prestador.nome, telefone: f.prestador.telefone } });
      await get(`/api/propostas/pedido/${f.pedido._id}`, accounts.outroCliente, 403);
    });
    await t.test(`${label}: propostas do prestador preservam pedido_id.titulo e campos anteriores`, async () => {
      const rows = await get('/api/propostas/prestador?prestador_id=' + accounts.outroPrestador.id, accounts.prestador);
      assert.equal(rows.length, 2);
      const row = rows.find(row => row._id === String(f.proposta._id));
      keys(row, fields.proposta); keys(row.pedido_id, fields.pedido);
      assert.deepEqual(row, { ...pick(f.proposta, fields.proposta), pedido_id: pick(f.pedido, fields.pedido) });
    });
    for (const role of ['cliente', 'prestador']) await t.test(`${label}: agenda de ${role} preserva nomes, servico, horario e status`, async () => {
      const rows = await get(`/api/agendamentos/${role}?${role}_id=${accounts[role === 'cliente' ? 'outroCliente' : 'outroPrestador'].id}`, accounts[role]);
      assert.equal(rows.length, 2);
      const row = rows.find(row => row._id === String(f.agenda._id));
      const participant = role === 'cliente' ? 'prestador' : 'cliente', person = f[participant];
      keys(row, fields.agenda);
      assert.deepEqual(row, { ...pick(f.agenda, fields.agenda),
        [participant + '_id']: { _id: person.id, nome: person.nome, telefone: person.telefone },
        servico_id: { _id: String(f.servico._id), nome: f.servico.nome, preco: f.servico.preco } });
    });
    await t.test(`${label}: notificacoes preservam mensagem, link e lida sem evento/vinculo interno`, async () => {
      const rows = await get('/api/notificacoes?usuario_id=' + accounts.outroPrestador.id, accounts.prestador);
      assert.equal(rows.length, 2);
      const row = rows.find(row => row._id === String(f.nota._id)); keys(row, fields.nota);
      assert.deepEqual(row, pick(f.nota, fields.nota));
    });
  }
  await t.test('pedidos abertos preservam filtro de categoria e cliente populado somente com nome', async () => {
    const rows = await get('/api/pedidos/abertos?categoria=pintura', accounts.prestador);
    assert.equal(rows.length, 1); keys(rows[0], fields.pedido);
    assert.deepEqual(rows[0], { ...pick(aberto, fields.pedido), cliente_id: { _id: accounts.cliente.id, nome: accounts.cliente.nome } });
    assert.deepEqual(await get('/api/pedidos/abertos?categoria=eletrica', accounts.prestador), []);
  });
  await t.test('outras contas recebem somente seus registros e contagem nao muda', async () => {
    for (const [url, actor, id] of [
      ['/api/pedidos/cliente', accounts.outroCliente, foreign.pedido._id],
      ['/api/propostas/prestador', accounts.outroPrestador, foreign.proposta._id],
      ['/api/agendamentos/cliente', accounts.outroCliente, foreign.agenda._id],
      ['/api/agendamentos/prestador', accounts.outroPrestador, foreign.agenda._id],
      ['/api/notificacoes', accounts.outroPrestador, foreign.nota._id]
    ]) {
      const rows = await get(url, actor); assert.deepEqual(rows.map(row => row._id), [String(id)]);
    }
    assert.deepEqual(await get('/api/notificacoes/nao-lidas', accounts.prestador), { total: 1 });
    assert.deepEqual(await get('/api/notificacoes/nao-lidas', accounts.outroPrestador), { total: 0 });
  });
  await t.test('JWT e papeis continuam obrigatorios nas leituras', async () => {
    for (const [url, wrong] of [['/api/pedidos/cliente', accounts.prestador], ['/api/pedidos/abertos', accounts.cliente],
      ['/api/propostas/prestador', accounts.cliente], [`/api/propostas/pedido/${aberto._id}`, accounts.prestador],
      ['/api/agendamentos/cliente', accounts.prestador], ['/api/agendamentos/prestador', accounts.cliente]]) {
      await get(url, undefined, 401); await get(url, { token: 'invalido' }, 401); await get(url, wrong, 403);
    }
    await get('/api/notificacoes', undefined, 401); await get('/api/notificacoes', { token: 'invalido' }, 401);
  });
  await t.test('projecoes de leitura nao removem metadados persistidos nem alteram dados', async () => {
    assert.deepEqual(await snapshot(), before);
    const stored = await models.Pedido.findById(fixtures[1].pedido._id);
    assert.equal(stored.fluxo_contratacao, 1); assert.ok(stored.contratacao.agendamento_id);
    assert.ok((await models.Notificacao.findById(fixtures[1].nota._id)).evento_chave);
  });
});
