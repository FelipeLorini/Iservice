const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const ID = '1'.repeat(24);
const OUTRO_ID = '2'.repeat(24);
const CLIENTE = '3'.repeat(24);
const PRESTADOR = '4'.repeat(24);
const SERVICO = '5'.repeat(24);

// Carrega codigo real com dependencias controladas: nenhuma conexao, .env ou servidor.
function load(file, dependencies) {
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, process: { env: {} },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Dependencia inesperada: ${name}`);
      return dependencies[name];
    }
  };
  vm.runInNewContext(read(file), context, { filename: file });
  return module.exports;
}

function response() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = plain(body); return this; }
  };
}

function backend(options = {}) {
  const calls = { creates: [], notifications: [], queries: [], lookups: [] };
  const appointment = { cliente_id: CLIENTE, prestador_id: PRESTADOR, servico_id: SERVICO, status: 'finalizado', ...options.appointment };
  const model = {
    async findOne(query) { calls.queries.push(plain(query)); return options.duplicate ? { _id: ID } : null; },
    async create(data) {
      calls.creates.push(plain(data));
      if (options.createError) throw options.createError;
      return { _id: OUTRO_ID, ...data };
    },
    find(query) {
      calls.queries.push(plain(query));
      return {
        select(fields) {
          assert.equal(fields, 'agendamento_id');
          return { async lean() {
            if (options.listError) throw options.listError;
            return (options.records || []).filter(record => record.cliente_id === query.cliente_id);
          } };
        },
        populate(field, fields) {
          assert.equal(field, 'cliente_id');
          assert.equal(fields, 'nome');
          return { async sort(order) {
            assert.deepEqual(plain(order), { data_criacao: -1 });
            return options.records || [];
          } };
        }
      };
    },
    async aggregate(pipeline) { calls.pipeline = plain(pipeline); return options.aggregate || []; }
  };
  const handlers = load('controllers/avaliacaoController.js', {
    '../Models/avaliacaoModel': model,
    '../Models/agendamentoModel': { async findById(id) {
      calls.lookups.push(id);
      if (options.lookupError) throw options.lookupError;
      return options.missing ? null : appointment;
    } },
    '../utils/notificacaoHelper': { async criarNotificacao(...args) { calls.notifications.push(args); } },
    mongoose: { Types: { ObjectId: class { constructor(id) { this.id = id; } } } }
  });
  return {
    handlers, calls, model,
    async create(body = {}) {
      const res = response();
      await handlers.criarAvaliacao({ usuarioId: CLIENTE, body: { agendamento_id: ID, nota: 5, comentario: 'Bom trabalho', ...body } }, res);
      return res;
    }
  };
}

test('criacao deriva cliente, prestador e servico de fontes autorizadas e preserva comentario/notificacao', async () => {
  const api = backend();
  const res = await api.create({ cliente_id: OUTRO_ID, prestador_id: OUTRO_ID, servico_id: OUTRO_ID });
  assert.equal(res.code, 201);
  assert.deepEqual(api.calls.creates, [{ cliente_id: CLIENTE, prestador_id: PRESTADOR, servico_id: SERVICO, agendamento_id: ID, nota: 5, comentario: 'Bom trabalho' }]);
  assert.deepEqual(api.calls.notifications, [[PRESTADOR, 'Voce recebeu uma nova avaliacao', 'avaliacao', '/perfil_prestador.html']]);
  assert.equal(res.body.avaliacao.comentario, 'Bom trabalho');
});

for (const [label, value] of [['ausente', undefined], ['nulo', null], ['vazio', ''], ['malformado', 'invalido'], ['objeto', { $ne: null }]]) {
  test(`criacao rejeita agendamento ${label} antes de consultar`, async () => {
    const api = backend();
    const res = await api.create({ agendamento_id: value });
    assert.equal(res.code, 400);
    assert.equal(api.calls.lookups.length, 0);
    assert.equal(api.calls.creates.length, 0);
    assert.equal(api.calls.notifications.length, 0);
  });
}

for (const [label, options, code] of [
  ['inexistente', { missing: true }, 404],
  ['de outro cliente', { appointment: { cliente_id: OUTRO_ID } }, 403],
  ...['pendente', 'confirmado', 'cancelado'].map(status => [status, { appointment: { status } }, 400])
]) {
  test(`criacao rejeita agendamento ${label}`, async () => {
    const api = backend(options);
    assert.equal((await api.create()).code, code);
    assert.equal(api.calls.creates.length, 0);
    assert.equal(api.calls.notifications.length, 0);
  });
}

for (const nota of [0, 6, null, 'abc', '5', {}, NaN]) {
  test(`criacao rejeita nota invalida ${JSON.stringify(nota)}`, async () => {
    const api = backend();
    assert.equal((await api.create({ nota })).code, 400);
    assert.equal(api.calls.creates.length, 0);
  });
}

for (const field of ['cliente_id', 'prestador_id', 'servico_id']) {
  for (const [label, value] of [['ausente', undefined], ['nulo', null], ['vazio', '']]) {
    test(`agendamento com ${field} ${label} retorna conflito controlado`, async () => {
      const api = backend({ appointment: { [field]: value } });
      const res = await api.create();
      assert.equal(res.code, 409);
      assert.deepEqual(res.body, { mensagem: 'Este agendamento possui dados incompletos e nao pode ser avaliado' });
      assert.equal(api.calls.creates.length, 0);
      assert.equal(api.calls.notifications.length, 0);
      assert.equal(api.calls.queries.length, 0);
    });
  }
}

test('agendamento de outro cliente continua proibido mesmo com servico e prestador ausentes', async () => {
  const api = backend({ appointment: { cliente_id: OUTRO_ID, prestador_id: null, servico_id: null } });
  const res = await api.create();
  assert.equal(res.code, 403);
  assert.equal(api.calls.creates.length, 0);
  assert.equal(api.calls.notifications.length, 0);
});

test('avaliacao aceita IDs historicos sem consultar existencia atual de servico ou prestador', async () => {
  // O carregador falha se o controller tentar importar modelos/consultas adicionais.
  const api = backend();
  const res = await api.create();
  assert.equal(res.code, 201);
  assert.deepEqual(api.calls.lookups, [ID]);
  assert.equal(api.calls.creates[0].prestador_id, PRESTADOR);
  assert.equal(api.calls.creates[0].servico_id, SERVICO);
  assert.equal(api.calls.notifications.length, 1);
});

test('duplicidade preexistente e erro 11000 retornam o mesmo erro publico sem notificacao', async () => {
  const duplicate = backend({ duplicate: true });
  const race = backend({ createError: Object.assign(new Error('detalhe interno simulado'), { code: 11000 }) });
  const first = await duplicate.create();
  const second = await race.create();
  assert.equal(first.code, 400);
  assert.equal(second.code, 400);
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(first.body, { mensagem: 'Este agendamento ja foi avaliado', codigo: 'AVALIACAO_DUPLICADA' });
  assert.equal(duplicate.calls.creates.length, 0);
  assert.equal(duplicate.calls.notifications.length + race.calls.notifications.length, 0);
});

test('duas criacoes concorrentes lidam com conflito de unicidade simulado', async () => {
  const api = backend();
  let checks = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  api.model.findOne = async () => { if (++checks === 2) release(); await gate; return null; };
  let saved = false;
  api.model.create = async data => {
    if (saved) throw Object.assign(new Error('conflito simulado'), { code: 11000 });
    saved = true;
    return data;
  };
  const results = await Promise.all([api.create(), api.create()]);
  assert.deepEqual(results.map(result => result.code).sort(), [201, 400]);
  assert.equal(api.calls.notifications.length, 1);
});

test('falha interna na criacao nao expoe detalhes', async () => {
  const api = backend({ lookupError: new Error('detalhe interno simulado') });
  const res = await api.create();
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { mensagem: 'Erro ao criar avaliacao' });
});

test('consulta filtra pela sessao, conta legadas e retorna vinculos sem repeticao', async () => {
  const api = backend({ records: [
    { cliente_id: CLIENTE, agendamento_id: ID },
    { cliente_id: CLIENTE, agendamento_id: ID },
    { cliente_id: CLIENTE },
    { cliente_id: CLIENTE, agendamento_id: null },
    { cliente_id: OUTRO_ID, agendamento_id: OUTRO_ID }
  ] });
  const res = response();
  await api.handlers.listarAvaliacoesCliente({ usuarioId: CLIENTE, query: { cliente_id: OUTRO_ID }, body: { cliente_id: OUTRO_ID } }, res);
  assert.deepEqual(api.calls.queries, [{ cliente_id: CLIENTE }]);
  assert.deepEqual(res.body, { total: 4, agendamentos_avaliados: [ID] });
});

test('consulta vazia retorna zero e falha retorna 500 sem simular lista vazia', async () => {
  for (const fail of [false, true]) {
    const api = backend({ listError: fail ? new Error('detalhe interno simulado') : null });
    const res = response();
    await api.handlers.listarAvaliacoesCliente({ usuarioId: CLIENTE }, res);
    assert.equal(res.code, fail ? 500 : 200);
    assert.deepEqual(res.body, fail ? { mensagem: 'Erro ao consultar suas avaliacoes' } : { total: 0, agendamentos_avaliados: [] });
  }
});

test('listagem e media do prestador preservam comentarios, filtro e arredondamento', async () => {
  const api = backend({ records: [{ comentario: 'Bom trabalho', nota: 5 }], aggregate: [{ media: 4.666, total: 3 }] });
  const list = response();
  await api.handlers.listarAvaliacoesPorPrestador({ params: { id: PRESTADOR } }, list);
  assert.equal(list.body[0].comentario, 'Bom trabalho');
  assert.deepEqual(api.calls.queries, [{ prestador_id: PRESTADOR }]);
  const average = response();
  await api.handlers.calcularMedia({ params: { id: PRESTADOR } }, average);
  assert.deepEqual(average.body, { media: 4.7, total: 3 });
  assert.deepEqual(api.calls.pipeline, [
    { $match: { prestador_id: { id: PRESTADOR } } },
    { $group: { _id: '$prestador_id', media: { $avg: '$nota' }, total: { $sum: 1 } } }
  ]);
});

test('media sem avaliacoes continua retornando zero', async () => {
  const api = backend();
  const res = response();
  await api.handlers.calcularMedia({ params: { id: PRESTADOR } }, res);
  assert.deepEqual(res.body, { media: 0, total: 0 });
});

test('schema exige vinculo novo e preserva validacao de documento legado e indice unico', () => {
  // Apenas validacao em memoria: nao conecta, salva ou cria indices.
  const Avaliacao = require('../Models/avaliacaoModel');
  const data = { cliente_id: CLIENTE, prestador_id: PRESTADOR, servico_id: SERVICO, nota: 5 };
  assert.equal(new Avaliacao(data).validateSync().errors.agendamento_id.kind, 'required');
  assert.equal(new Avaliacao({ ...data, agendamento_id: ID }).validateSync(), undefined);
  assert.equal(Avaliacao.hydrate({ _id: OUTRO_ID, ...data }).validateSync(), undefined);
  assert.ok(Avaliacao.schema.indexes().some(([fields, options]) => fields.agendamento_id === 1 && options.unique && options.sparse));
});

function registeredRoutes() {
  const routes = [];
  const middleware = load('middleware/auth.js', { jsonwebtoken: { verify(value) {
    if (value === 'invalido-simulado') throw new Error('invalido');
    return { id: CLIENTE, tipo: value === 'prestador-simulado' ? 'prestador' : 'cliente' };
  } } });
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (url, ...handlers) => { routes.push({ method, url, handlers }); };
  }
  const dependencies = { express: { Router: () => router }, '../middleware/auth': middleware };
  for (const match of read('routes/userRoutes.js').matchAll(/require\('(\.\.\/controllers\/[^']+)'\)/g)) {
    dependencies[match[1]] = new Proxy({}, { get: (_, name) => async (req, res) => res.json({ handler: name, cliente: req.usuarioId }) });
  }
  load('routes/userRoutes.js', dependencies);
  return routes;
}

for (const method of ['get', 'post']) {
  for (const [label, credential, expected] of [
    ['sem autenticacao', null, 401], ['autenticacao invalida', 'invalido-simulado', 401],
    ['prestador', 'prestador-simulado', 403], ['cliente', 'cliente-simulado', 200]
  ]) {
    test(`rota ${method} de avaliacoes: ${label}`, async () => {
      const routes = registeredRoutes();
      const route = routes.find(item => item.method === method && item.url === (method === 'get' ? '/avaliacoes/cliente' : '/avaliacoes'));
      assert.ok(route);
      const req = { headers: credential ? { authorization: `Bearer ${credential}` } : {} };
      const res = response();
      for (const handler of route.handlers) {
        let next = false;
        await handler(req, res, () => { next = true; });
        if (!next) break;
      }
      assert.equal(res.code, expected);
      if (expected === 200) assert.equal(res.body.cliente, CLIENTE);
    });
  }
}

test('rota estatica do cliente precede rotas de prestador e preserva ambas', () => {
  const paths = registeredRoutes().filter(route => route.method === 'get').map(route => route.url);
  assert.ok(paths.indexOf('/avaliacoes/cliente') < paths.indexOf('/avaliacoes/prestador/:id'));
  assert.ok(paths.includes('/avaliacoes/prestador/:id/media'));
});

const ok = data => ({ ok: true, async json() { return data; } });
const flush = () => new Promise(resolve => setImmediate(resolve));
const appointment = (id = ID, status = 'finalizado') => ({
  _id: id, status, data: '2026-10-01', hora: '10:00',
  prestador_id: { _id: PRESTADOR, nome: 'Prestador' }, servico_id: { _id: SERVICO, nome: 'Servico' }
});

// Executa o script completo do Dashboard com DOM, storage e fetch simulados.
async function dashboard(options = {}) {
  const nodes = new Map();
  let buttons = [];
  function element(id) {
    if (!nodes.has(id)) {
      let html = '', text = '';
      nodes.set(id, {
        value: '', disabled: false, title: '', listeners: {}, dataset: {}, classList: { toggle() {} },
        addEventListener(event, callback) { this.listeners[event] = callback; },
        get textContent() { return text; }, set textContent(value) { text = String(value); },
        get innerHTML() { return html; }, set innerHTML(value) {
          html = value;
          if (id === 'listaServicos') buttons = [...html.matchAll(/class="[^"]*btn-avaliar[^"]*"/g)].map(() => ({ disabled: false }));
        }
      });
    }
    return nodes.get(id);
  }
  const stars = [1, 2, 3, 4, 5].map(value => { const node = element(`star-${value}`); node.dataset.valor = String(value); return node; });
  const state = { summary: { total: 0, agendamentos_avaliados: [] }, appointments: [appointment()], ...options };
  const requests = [], messages = [], modals = [];
  const context = vm.createContext({
    console: { error() {} },
    localStorage: { getItem(key) { return key === 'usuario' ? JSON.stringify({ id: CLIENTE, nome: 'Cliente', tipo: 'cliente' }) : 'sessao-simulada'; } },
    window: { location: { href: '' } },
    document: {
      getElementById: element,
      querySelectorAll(selector) { return selector === '#modalEstrelas i' ? stars : selector === '.btn-avaliar' ? buttons : []; }
    },
    IS: {
      exigirSessao: () => true, token: 'sessao-simulada',
      usuario: { id: CLIENTE, nome: 'Cliente', tipo: 'cliente' },
      API_URL: '/api', esc: value => String(value), inicial: value => value[0],
      vazio: () => '<div>Vazio</div>', dataTile: () => ({ dia: '01', mes: 'out' }), data: value => value, badge: value => value,
      msg(node, text) { messages.push(text); }, toast() {},
      abrirModal(id) { modals.push(['abrir', id]); }, fecharModal(id) { modals.push(['fechar', id]); }
    },
    async fetch(url, config = {}) {
      requests.push({ url, config });
      if (url === '/api/avaliacoes/cliente') return state.summaryFetch ? state.summaryFetch() : ok(state.summary);
      if (url === '/api/agendamentos/cliente') return state.appointmentsFetch ? state.appointmentsFetch() : ok(state.appointments);
      if (url === '/api/avaliacoes') return state.post ? state.post(config) : ok({});
      assert.ok(['/api/favoritos', '/api/pedidos/cliente'].includes(url));
      return ok([]);
    }
  });
  for (const match of read('site-iservice-main/dashboard-cliente.html').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) vm.runInContext(match[1], context);
  }
  await flush();
  return {
    state, requests, messages, modals, element, context,
    refresh: () => context.carregarAgendamentos(),
    prepare(id = ID) {
      context.abrirModalAvaliacao(id);
      stars[4].listeners.click();
      element('modalComentario').value = ' Bom trabalho ';
    },
    submit() { const button = element('btnConfirmarAvaliacao'); return button.listeners.click.call(button); },
    buttons: () => buttons
  };
}

for (const total of [0, 1, 4]) {
  test(`dashboard mostra total real ${total}, inclusive ao carregar novamente`, async () => {
    const summary = { total, agendamentos_avaliados: total ? [ID] : [] };
    for (let load = 0; load < 2; load++) {
      const page = await dashboard({ summary });
      assert.equal(page.element('totalAvaliacoes').textContent, String(total));
      assert.equal(page.buttons().length, total ? 0 : 1);
    }
  });
}

test('dashboard diferencia agendamentos do mesmo prestador/servico e respeita status', async () => {
  const page = await dashboard({
    summary: { total: 1, agendamentos_avaliados: [ID] },
    appointments: [appointment(), appointment(OUTRO_ID), appointment('cancelado', 'cancelado'), appointment('pendente', 'pendente'), appointment('confirmado', 'confirmado')]
  });
  assert.equal(page.buttons().length, 1);
  assert.ok(page.element('listaServicos').innerHTML.includes(`abrirModalAvaliacao('${OUTRO_ID}')`));
  assert.ok(!page.element('listaServicos').innerHTML.includes(`abrirModalAvaliacao('${ID}')`));
  assert.equal(page.element('pendentes').textContent, '2');
  assert.equal(page.element('totalServicos').textContent, '5');
});

test('contador inclui legadas mesmo sem agendamentos no dashboard', async () => {
  const page = await dashboard({ summary: { total: 3, agendamentos_avaliados: [] }, appointments: [] });
  assert.equal(page.element('totalAvaliacoes').textContent, '3');
  assert.equal(page.buttons().length, 0);
});

for (const failure of ['HTTP', 'rede', 'JSON', 'contrato']) {
  test(`falha ${failure} na consulta bloqueia avaliacao sem zerar contador`, async () => {
    const page = await dashboard({ summaryFetch: async () => {
      if (failure === 'rede') throw new Error('rede simulada');
      if (failure === 'JSON') return { ok: true, async json() { throw new Error('JSON invalido'); } };
      if (failure === 'contrato') return ok({ total: 0 });
      return { ok: false };
    } });
    assert.equal(page.element('totalAvaliacoes').textContent, '—');
    assert.equal(page.buttons().length, 0);
    assert.match(page.element('listaServicos').innerHTML, /Avaliações indisponíveis/);
    page.prepare();
    await page.submit();
    assert.equal(page.modals.length, 0);
    assert.equal(page.requests.filter(request => request.url === '/api/avaliacoes').length, 0);
    page.state.summaryFetch = null;
    await page.refresh();
    assert.equal(page.element('totalAvaliacoes').textContent, '0');
    assert.equal(page.buttons().length, 1);
  });
}

test('consulta de avaliacoes funciona mesmo quando agendamentos falham', async () => {
  const page = await dashboard({ summary: { total: 2, agendamentos_avaliados: [ID] }, appointmentsFetch: async () => { throw new Error('falha simulada'); } });
  assert.equal(page.element('totalAvaliacoes').textContent, '2');
});

test('envio bem-sucedido atualiza contador/historico e bloqueia cliques simultaneos', async () => {
  const page = await dashboard();
  let release;
  page.state.post = () => new Promise(resolve => { release = resolve; });
  page.prepare();
  const sending = page.submit();
  assert.equal(page.element('btnConfirmarAvaliacao').disabled, true);
  await page.submit();
  const posts = page.requests.filter(request => request.url === '/api/avaliacoes');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].config.body), { agendamento_id: ID, nota: 5, comentario: 'Bom trabalho' });
  page.state.summary = { total: 1, agendamentos_avaliados: [ID] };
  release(ok({ avaliacao: { agendamento_id: ID } }));
  await sending;
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.buttons().length, 0);
  assert.match(page.element('listaServicos').innerHTML, /Avaliado/);
  assert.equal(page.element('btnConfirmarAvaliacao').disabled, false);
  assert.deepEqual(page.modals.at(-1), ['fechar', 'modalAvaliacao']);
});

for (const failure of ['HTTP', 'rede']) {
  test(`falha ${failure} no envio libera botao e preserva contador`, async () => {
    const page = await dashboard({ post: async () => {
      if (failure === 'rede') throw new Error('falha simulada');
      return { ok: false, async json() { return { mensagem: 'Falha simulada' }; } };
    } });
    page.prepare();
    await page.submit();
    assert.equal(page.element('btnConfirmarAvaliacao').disabled, false);
    assert.equal(page.element('totalAvaliacoes').textContent, '0');
    assert.equal(page.buttons().length, 1);
    assert.ok(page.messages.at(-1));
  });
}

test('duplicidade informada pela API sincroniza avaliacao feita em outra aba', async () => {
  const page = await dashboard();
  page.prepare();
  page.state.post = async () => {
    page.state.summary = { total: 1, agendamentos_avaliados: [ID] };
    return { ok: false, async json() { return { codigo: 'AVALIACAO_DUPLICADA', mensagem: 'Este agendamento ja foi avaliado' }; } };
  };
  await page.submit();
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.buttons().length, 0);
  assert.equal(page.element('btnConfirmarAvaliacao').disabled, false);
});

test('falha de consulta depois de salvar bloqueia novo envio', async () => {
  const page = await dashboard();
  page.prepare();
  page.state.post = async () => {
    page.state.summaryFetch = async () => { throw new Error('falha simulada'); };
    return ok({});
  };
  await page.submit();
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '—');
  assert.equal(page.buttons().length, 0);
  await page.submit();
  assert.equal(page.requests.filter(request => request.url === '/api/avaliacoes').length, 1);
});

test('resposta antiga nao reabilita botao nem sobrescreve contador recente', async () => {
  const page = await dashboard();
  let release;
  page.state.summaryFetch = () => new Promise(resolve => { release = resolve; });
  const old = page.refresh();
  assert.ok(page.buttons().every(button => button.disabled));
  page.state.summaryFetch = null;
  page.state.summary = { total: 1, agendamentos_avaliados: [ID] };
  await page.refresh();
  release(ok({ total: 0, agendamentos_avaliados: [] }));
  await old;
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.buttons().length, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('agendamentos aparecem antes das avaliacoes lentas e sincronizam ao receber a resposta', async () => {
  const pending = deferred();
  const page = await dashboard({
    summaryFetch: () => pending.promise,
    appointments: [appointment(), appointment(OUTRO_ID), appointment('ativo', 'confirmado')]
  });
  assert.equal(page.element('totalServicos').textContent, '3');
  assert.equal(page.element('pendentes').textContent, '1');
  assert.match(page.element('listaAgendamentos').innerHTML, /Cancelar/);
  assert.match(page.element('listaServicos').innerHTML, /Consultando avaliações/);
  assert.equal(page.element('totalAvaliacoes').textContent, '—');
  assert.equal(page.buttons().length, 0);
  page.prepare();
  await page.submit();
  assert.equal(page.modals.length, 0);
  assert.equal(page.requests.filter(request => request.url === '/api/avaliacoes').length, 0);
  pending.resolve(ok({ total: 1, agendamentos_avaliados: [ID] }));
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.element('avisoAvaliacoes').textContent, '');
  assert.equal(page.buttons().length, 1);
  assert.ok(page.element('listaServicos').innerHTML.includes(`abrirModalAvaliacao('${OUTRO_ID}')`));
  assert.ok(!page.element('listaServicos').innerHTML.includes(`abrirModalAvaliacao('${ID}')`));
});

for (const failure of ['HTTP', 'rede']) {
  test(`falha ${failure} tardia das avaliacoes preserva agendamentos e exibe aviso`, async () => {
    const pending = deferred();
    const page = await dashboard({ summaryFetch: () => pending.promise });
    assert.equal(page.element('totalServicos').textContent, '1');
    assert.match(page.element('listaServicos').innerHTML, /Consultando avaliações/);
    if (failure === 'HTTP') pending.resolve({ ok: false });
    else pending.reject(new Error('falha simulada'));
    await flush();
    assert.equal(page.element('totalServicos').textContent, '1');
    assert.equal(page.element('totalAvaliacoes').textContent, '—');
    assert.match(page.element('avisoAvaliacoes').textContent, /Não foi possível consultar/);
    assert.match(page.element('listaServicos').innerHTML, /Avaliações indisponíveis/);
    assert.equal(page.buttons().length, 0);
  });
}

test('aviso de falha aparece mesmo sem agendamentos finalizados', async () => {
  const page = await dashboard({ appointments: [], summaryFetch: async () => ({ ok: false }) });
  assert.equal(page.element('totalAvaliacoes').textContent, '—');
  assert.match(page.element('avisoAvaliacoes').textContent, /Não foi possível consultar/);
});

test('avaliacoes chegam antes dos agendamentos sem habilitar acoes antigas', async () => {
  const page = await dashboard();
  const pending = deferred();
  page.state.appointmentsFetch = () => pending.promise;
  page.state.summary = { total: 1, agendamentos_avaliados: [ID] };
  const refresh = page.refresh();
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.buttons().length, 0);
  page.prepare(OUTRO_ID);
  assert.equal(page.modals.length, 0);
  pending.resolve(ok([appointment(), appointment(OUTRO_ID)]));
  await refresh;
  assert.equal(page.element('totalServicos').textContent, '2');
  assert.equal(page.buttons().length, 1);
  page.prepare(OUTRO_ID);
  assert.equal(page.modals.length, 1);
});

test('falha antiga das avaliacoes nao substitui estado atual bem-sucedido', async () => {
  const page = await dashboard();
  const pending = deferred();
  page.state.summaryFetch = () => pending.promise;
  const old = page.refresh();
  page.state.summaryFetch = null;
  page.state.summary = { total: 1, agendamentos_avaliados: [ID] };
  await page.refresh();
  pending.reject(new Error('falha antiga simulada'));
  await old;
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.element('avisoAvaliacoes').textContent, '');
  assert.equal(page.buttons().length, 0);
});

test('sucesso antigo das avaliacoes nao libera botoes depois de falha atual', async () => {
  const page = await dashboard();
  const pending = deferred();
  page.state.summaryFetch = () => pending.promise;
  const old = page.refresh();
  page.state.summaryFetch = async () => ({ ok: false });
  await page.refresh();
  pending.resolve(ok({ total: 0, agendamentos_avaliados: [] }));
  await old;
  assert.equal(page.element('totalAvaliacoes').textContent, '—');
  assert.match(page.element('avisoAvaliacoes').textContent, /Não foi possível consultar/);
  assert.equal(page.buttons().length, 0);
});

test('resposta antiga dos agendamentos nao substitui a lista atual', async () => {
  const page = await dashboard();
  const pending = deferred();
  page.state.appointmentsFetch = () => pending.promise;
  const old = page.refresh();
  page.state.appointmentsFetch = null;
  page.state.appointments = [appointment(OUTRO_ID)];
  await page.refresh();
  pending.resolve(ok([appointment(ID, 'cancelado')]));
  await old;
  assert.ok(page.element('listaServicos').innerHTML.includes(`abrirModalAvaliacao('${OUTRO_ID}')`));
  assert.equal(page.buttons().length, 1);
});

test('consulta lenta apos salvar nao mantem trava de envio e continua impedindo nova avaliacao', async () => {
  const page = await dashboard();
  const pending = deferred();
  page.prepare();
  page.state.post = async () => {
    page.state.summaryFetch = () => pending.promise;
    return ok({});
  };
  await page.submit();
  await flush();
  assert.equal(page.element('btnConfirmarAvaliacao').disabled, false);
  assert.equal(page.element('totalServicos').textContent, '1');
  assert.equal(page.element('totalAvaliacoes').textContent, '—');
  assert.equal(page.buttons().length, 0);
  await page.submit();
  assert.equal(page.requests.filter(request => request.url === '/api/avaliacoes').length, 1);
  pending.resolve(ok({ total: 1, agendamentos_avaliados: [ID] }));
  await flush();
  assert.equal(page.element('totalAvaliacoes').textContent, '1');
  assert.equal(page.buttons().length, 0);
});
