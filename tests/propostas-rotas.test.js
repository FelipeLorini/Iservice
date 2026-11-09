const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, loadService, controllerStubs, startHttp } = require('./helpers/httpApp');

const CLIENTE = 'a'.repeat(24), PRESTADOR = 'b'.repeat(24), OUTRO = 'c'.repeat(24);
const PEDIDO = 'abcdef0123456789abcdef01', PROPOSTA = 'abcdef0123456789abcdef02';
const OUTRA_PROPOSTA = 'd'.repeat(24), OUTRO_PEDIDO = 'e'.repeat(24), SERVICO = 'f'.repeat(24);
const NOVA = '1'.repeat(24), AGENDAMENTO = '2'.repeat(24);
const secret = 'chave-ficticia-propostas-http', FALHA = 'falha-sintetica-propostas';
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-01-01T12:00:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
const pedido = { _id: PEDIDO, cliente_id: CLIENTE, titulo: 'Pedido ficticio', categoria: 'faxina',
  data_desejada: '2026-12-10T00:00:00.000Z', status: 'aberto' };
const proposta = { _id: PROPOSTA, pedido_id: PEDIDO, prestador_id: PRESTADOR, valor: 100,
  prazo: 'Dois dias', descricao: 'Descricao ficticia', status: 'enviada', data_criacao: '2026-01-01' };
const other = { ...proposta, _id: OUTRA_PROPOSTA, prestador_id: OUTRO, data_criacao: '2026-01-02' };
const input = { pedido_id: PEDIDO, valor: 120, prazo: 'Tres dias', descricao: 'Proposta ficticia' };

async function fixture(t, { usuarioId = CLIENTE, pedidos = [pedido], propostas = [proposta, other],
  service = true, failure, errorCode } = {}) {
  const state = { pedidos: plain(pedidos), propostas: plain(propostas), agendamentos: [], notificacoes: [] };
  const calls = [], effects = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Object.assign(Error(FALHA), errorCode ? { code: errorCode } : {});
  }
  function pedidoDoc(row) {
    if (!row) return null;
    const doc = plain(row);
    Object.defineProperty(doc, 'save', { value: async () => {
      record('pedido.save', doc);
      state.pedidos[state.pedidos.findIndex(item => item._id === doc._id)] = plain(doc);
      effects.push('pedido.save');
    } });
    return doc;
  }
  const controllers = controllerStubs(dispatches);
  const dependencies = {
    '../Models/pedidoModel': { async findById(id) {
      record('pedido.findById', id);
      return pedidoDoc(state.pedidos.find(row => row._id === id?.toLowerCase()));
    } },
    '../Models/propostaModel': {
      async findOne(filter) {
        record('proposta.findOne', filter);
        return state.propostas.find(row => row.pedido_id === filter.pedido_id && row.prestador_id === filter.prestador_id) || null;
      },
      async create(data) {
        record('proposta.create', data);
        const row = { _id: NOVA, ...plain(data), status: 'enviada' };
        state.propostas.push(row); effects.push('proposta.create'); return row;
      },
      find(filter) {
        record('proposta.find', filter);
        let population;
        return { populate(...args) {
          record('proposta.populate', args); population = args[0]; return this;
        }, async sort(order) {
          record('proposta.sort', order);
          return state.propostas.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value.toLowerCase()))
            .sort((a, b) => b.data_criacao.localeCompare(a.data_criacao)).map(row => ({ ...plain(row),
              ...(population === 'pedido_id' ? { pedido_id: plain(state.pedidos.find(item => item._id === row.pedido_id) || null) } :
                { prestador_id: { _id: row.prestador_id, nome: 'Prestador ficticio', telefone: '000000000' } })
            }));
        } };
      },
      findById(id) {
        record('proposta.findById', id);
        return { async populate(field) {
          record('proposta.populate', [field]);
          const row = state.propostas.find(item => item._id === id.toLowerCase());
          if (!row) return null;
          const doc = { ...plain(row), pedido_id: pedidoDoc(state.pedidos.find(item => item._id === row.pedido_id)) };
          Object.defineProperty(doc, 'save', { value: async () => {
            const saved = { ...plain(doc), pedido_id: doc.pedido_id._id };
            record('proposta.save', saved);
            state.propostas[state.propostas.findIndex(item => item._id === doc._id)] = saved;
            effects.push('proposta.save');
          } });
          return doc;
        } };
      },
      async updateMany(filter, update) {
        record('proposta.updateMany', { filter, update });
        for (const row of state.propostas) if (row.pedido_id === filter.pedido_id && row._id !== filter._id.$ne) {
          Object.assign(row, plain(update));
        }
        effects.push('proposta.updateMany');
      }
    },
    '../Models/servicoModel': { async findOne(filter) {
      record('servico.findOne', filter); return service ? { _id: SERVICO } : null;
    } },
    '../Models/agendamentoModel': { async create(data) {
      record('agendamento.create', data);
      const row = { _id: String(state.agendamentos.length + 2).repeat(24), ...plain(data) };
      state.agendamentos.push(row); effects.push('agendamento.create'); return row;
    } },
    '../utils/notificacaoHelper': { async criarNotificacao(...args) {
      record('notify', args); state.notificacoes.push(plain(args)); effects.push('notify');
    } }
  };
  const options = { secret, clock: Clock };
  const serviceReal = loadService('services/propostaService.js', dependencies, options);
  controllers.propostaController = loadController('controllers/propostaController.js', {
    ...dependencies, '../services/propostaService': serviceReal
  }, options);
  return { ...await startHttp(t, { controllers, secret, usuarioId }), state, calls, effects, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  const result = JSON.parse(res.text);
  if (body !== undefined) assert.deepEqual(result, body);
  return result;
}
const notifyAccepted = [PRESTADOR, 'Sua proposta foi aceita pelo cliente', 'proposta_aceita', '/dashboard-prestador.html'];
const acceptedEffects = ['proposta.save', 'pedido.save', 'proposta.updateMany', 'agendamento.create', 'notify'];
const endpoints = [['POST', '/api/propostas', 'prestador'], ['GET', '/api/propostas/pedido/' + PEDIDO, 'cliente'],
  ['GET', '/api/propostas/prestador', 'prestador'], ['PUT', '/api/propostas/' + PROPOSTA + '/aceitar', 'cliente']];

for (const [method, url, role] of endpoints) test(`${method} ${url}: JWT e papel antes de modelos e notificacoes`, async t => {
  const f = await fixture(t);
  const before = plain(f.state);
  for (const [headers, status, mensagem] of [
    [{}, 401, 'Acesso negado. Token nao fornecido'],
    [{ Authorization: 'Bearer invalido' }, 401, 'Token invalido ou expirado'],
    [f.headers(role === 'cliente' ? 'prestador' : 'cliente'), 403,
      `Acesso negado. Apenas ${role === 'cliente' ? 'clientes' : 'prestadores'} podem realizar esta acao`]
  ]) json(await f.request(method, url, headers, input), status, { mensagem });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, []);
  assert.deepEqual(f.state, before); assert.deepEqual(f.dispatches, []);
});

test('POST proposta usa prestador JWT e notifica cliente do pedido apos criar', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, propostas: [] });
  const row = { _id: NOVA, ...input, prestador_id: PRESTADOR, status: 'enviada' };
  const notification = [CLIENTE, 'Voce recebeu uma nova proposta para o seu pedido', 'nova_proposta', '/dashboard-cliente.html'];
  json(await f.request('POST', '/api/propostas', f.headers('prestador'),
    { ...input, prestador_id: OUTRO, cliente_id: OUTRO, status: 'aceita', _id: OUTRO }),
  201, { mensagem: 'Proposta enviada com sucesso', proposta: row });
  assert.deepEqual(f.calls, [
    { op: 'pedido.findById', value: PEDIDO },
    { op: 'proposta.findOne', value: { pedido_id: PEDIDO, prestador_id: PRESTADOR } },
    { op: 'proposta.create', value: { ...input, prestador_id: PRESTADOR } }, { op: 'notify', value: notification }
  ]);
  assert.deepEqual(f.state.propostas, [row]); assert.deepEqual(f.state.notificacoes, [notification]);
  assert.deepEqual(f.effects, ['proposta.create', 'notify']);
});

for (const status of ['em andamento', 'finalizado', 'cancelado']) test(`POST proposta rejeita pedido ${status} antes de criar`, async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, pedidos: [{ ...pedido, status }], propostas: [] });
  json(await f.request('POST', '/api/propostas', f.headers('prestador'), input),
    400, { mensagem: 'Este pedido nao esta mais aberto para propostas' });
  assert.deepEqual(f.calls, [{ op: 'pedido.findById', value: PEDIDO }]); assert.deepEqual(f.effects, []);
});

test('POST proposta rejeita pedido inexistente e duplicidade da mesma sessao', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, pedidos: [] });
  json(await f.request('POST', '/api/propostas', f.headers('prestador'), input), 404, { mensagem: 'Pedido nao encontrado' });
  assert.deepEqual(f.effects, []);
  const g = await fixture(t, { usuarioId: PRESTADOR });
  json(await g.request('POST', '/api/propostas', g.headers('prestador'), input),
    400, { mensagem: 'Voce ja enviou uma proposta para este pedido' });
  assert.deepEqual(g.calls.map(call => call.op), ['pedido.findById', 'proposta.findOne']);
  assert.deepEqual(g.effects, []);
});

test('GET por pedido verifica propriedade e parametro antes de consultar propostas', async t => {
  const unrelated = { ...proposta, _id: NOVA, pedido_id: OUTRO_PEDIDO };
  const f = await fixture(t, { propostas: [proposta, other, unrelated] });
  const expected = [other, proposta].map(row => ({ ...row, prestador_id: {
    _id: row.prestador_id, nome: 'Prestador ficticio', telefone: '000000000' } }));
  json(await f.request('GET', '/api/propostas/pedido/' + PEDIDO.toUpperCase() + '?pedido_id=' + OUTRO_PEDIDO,
    f.headers('cliente')), 200, expected);
  assert.deepEqual(f.calls, [{ op: 'pedido.findById', value: PEDIDO.toUpperCase() },
    { op: 'proposta.find', value: { pedido_id: PEDIDO.toUpperCase() } },
    { op: 'proposta.populate', value: ['prestador_id', 'nome telefone'] }, { op: 'proposta.sort', value: { data_criacao: -1 } }]);
  assert.deepEqual(f.effects, []);
});

for (const missing of [false, true]) test(`GET por pedido nega outra conta ou inexistente: ausente=${missing}`, async t => {
  const f = await fixture(t, { pedidos: missing ? [] : [{ ...pedido, cliente_id: OUTRO }] });
  json(await f.request('GET', '/api/propostas/pedido/' + PEDIDO, f.headers('cliente')),
    missing ? 404 : 403, { mensagem: missing ? 'Pedido nao encontrado' : 'Voce nao tem permissao para ver estas propostas' });
  assert.deepEqual(f.calls, [{ op: 'pedido.findById', value: PEDIDO }]); assert.deepEqual(f.effects, []);
});

test('GET prestador filtra sessao e popula campos publicos do pedido, sem aceitar identidade na query', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR });
  json(await f.request('GET', '/api/propostas/prestador?prestador_id=' + OUTRO, f.headers('prestador')),
    200, [{ ...proposta, pedido_id: pedido }]);
  assert.deepEqual(f.calls, [{ op: 'proposta.find', value: { prestador_id: PRESTADOR } },
    { op: 'proposta.populate', value: ['pedido_id', '_id cliente_id titulo descricao categoria data_desejada status data_criacao __v'] },
    { op: 'proposta.sort', value: { data_criacao: -1 } }]);
  assert.deepEqual(f.effects, []);
});

test('listagens de propostas vazias preservam arrays', async t => {
  const f = await fixture(t, { propostas: [] });
  json(await f.request('GET', '/api/propostas/pedido/' + PEDIDO, f.headers('cliente')), 200, []);
  json(await f.request('GET', '/api/propostas/prestador', f.headers('prestador')), 200, []);
});

test('aceitacao valida consulta servico antes das escritas e preserva parametros, vinculos e notificacao', async t => {
  const unrelated = { ...other, _id: NOVA, pedido_id: OUTRO_PEDIDO };
  const f = await fixture(t, { propostas: [proposta, { ...other, status: 'aceita' }, unrelated] });
  const accepted = { ...proposta, status: 'aceita' }, underway = { ...pedido, status: 'em andamento' };
  const data = { cliente_id: CLIENTE, prestador_id: PRESTADOR, servico_id: SERVICO,
    data: pedido.data_desejada, hora: '09:00', status: 'pendente' };
  const agendamento = { _id: AGENDAMENTO, ...data };
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA.toUpperCase() + '/aceitar?id=' + other._id,
    f.headers('cliente'), { id: other._id, prestador_id: OUTRO, cliente_id: OUTRO, status: 'recusada' }),
  200, { mensagem: 'Proposta aceita com sucesso', proposta: { ...accepted, pedido_id: underway }, agendamento });
  assert.deepEqual(f.calls, [
    { op: 'proposta.findById', value: PROPOSTA.toUpperCase() }, { op: 'proposta.populate', value: ['pedido_id'] },
    { op: 'servico.findOne', value: { prestador_id: PRESTADOR, categoria: pedido.categoria } },
    { op: 'proposta.save', value: accepted }, { op: 'pedido.save', value: underway },
    { op: 'proposta.updateMany', value: { filter: { pedido_id: PEDIDO, _id: { $ne: PROPOSTA } }, update: { status: 'recusada' } } },
    { op: 'agendamento.create', value: data }, { op: 'notify', value: notifyAccepted }
  ]);
  assert.deepEqual(f.effects, acceptedEffects);
  assert.deepEqual(f.state, { pedidos: [underway], propostas: [accepted, { ...other, status: 'recusada' }, unrelated],
    agendamentos: [agendamento], notificacoes: [notifyAccepted] });
  assert.deepEqual(f.dispatches, []);
});

// Historico 288fa65: estes cenarios aceitavam estados encerrados e servico ausente.
test('FUNC-006: sem servico correspondente retorna 409 antes de gravar ou notificar', async t => {
  const f = await fixture(t, { service: false });
  const before = plain(f.state);
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}),
    409, { mensagem: 'Nao existe servico correspondente para aceitar esta proposta' });
  assert.deepEqual(f.calls.map(call => call.op), ['proposta.findById', 'proposta.populate', 'servico.findOne']);
  assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

test('aceitacao sem data desejada usa data atual controlada e hora fixa', async t => {
  const noDate = { ...pedido }; delete noDate.data_desejada;
  const f = await fixture(t, { pedidos: [noDate] });
  assert.equal((await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {})).status, 200);
  assert.deepEqual(f.state.agendamentos, [{ _id: AGENDAMENTO, cliente_id: CLIENTE, prestador_id: PRESTADOR,
    servico_id: SERVICO, data: new Date(now).toISOString(), hora: '09:00', status: 'pendente' }]);
});

test('FUNC-001: proposta recusada de pedido cancelado retorna 409 sem efeitos', async t => {
  const f = await fixture(t, { pedidos: [{ ...pedido, status: 'cancelado' }], propostas: [{ ...proposta, status: 'recusada' }, other] });
  const before = plain(f.state);
  for (let n = 0; n < 2; n++) json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar',
    f.headers('cliente'), {}), 409, { mensagem: 'Este pedido nao esta aberto para aceitar propostas' });
  assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

for (const [entity, status] of [['pedido', 'cancelado'], ['pedido', 'finalizado'], ['pedido', 'em andamento'],
  ['proposta', 'recusada'], ['proposta', 'aceita']]) test(`FUNC-001: ${entity} ${status} retorna 409 sem alteracoes`, async t => {
  const f = await fixture(t, { pedidos: [{ ...pedido, ...(entity === 'pedido' ? { status } : {}) }],
    propostas: [{ ...proposta, ...(entity === 'proposta' ? { status } : {}) }, other] });
  const before = plain(f.state);
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}), 409,
    { mensagem: entity === 'pedido' ? 'Este pedido nao esta aberto para aceitar propostas' : 'Esta proposta nao esta disponivel para aceitacao' });
  assert.deepEqual(f.calls.map(call => call.op), ['proposta.findById', 'proposta.populate']);
  assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

test('autorizacao precede conflitos de estado e consulta de servico', async t => {
  const f = await fixture(t, { pedidos: [{ ...pedido, cliente_id: OUTRO, status: 'cancelado' }],
    propostas: [{ ...proposta, status: 'recusada' }], service: false });
  const before = plain(f.state);
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}),
    403, { mensagem: 'Voce nao tem permissao para aceitar esta proposta' });
  assert.deepEqual(f.calls.map(call => call.op), ['proposta.findById', 'proposta.populate']);
  assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

test('repeticao sequencial recebe 409 e preserva a unica contratacao anterior', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {})).status, 200);
  const before = plain(f.state), effects = plain(f.effects), previousCalls = f.calls.length;
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}),
    409, { mensagem: 'Este pedido nao esta aberto para aceitar propostas' });
  assert.deepEqual(f.calls.slice(previousCalls).map(call => call.op), ['proposta.findById', 'proposta.populate']);
  assert.deepEqual(f.state, before); assert.deepEqual(f.effects, effects);
  assert.equal(f.state.agendamentos.length, 1); assert.equal(f.state.notificacoes.length, 1);
});

for (const missing of [false, true]) test(`aceitacao nega outra conta ou inexistente: ausente=${missing}`, async t => {
  const f = await fixture(t, { pedidos: [{ ...pedido, cliente_id: OUTRO }], propostas: missing ? [] : [proposta] });
  const before = plain(f.state);
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), { cliente_id: CLIENTE }),
    missing ? 404 : 403, { mensagem: missing ? 'Proposta nao encontrada' : 'Voce nao tem permissao para aceitar esta proposta' });
  assert.deepEqual(f.calls.map(call => call.op), ['proposta.findById', 'proposta.populate']);
  assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

test('aceitacao com pedido removido retorna 500 antes de qualquer escrita', async t => {
  const f = await fixture(t, { pedidos: [] });
  const body = json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}), 500);
  assert.deepEqual(Object.keys(body).sort(), ['erro', 'mensagem']);
  assert.equal(body.mensagem, 'Erro ao aceitar proposta'); assert.match(body.erro, /cliente_id/);
  assert.deepEqual(f.effects, []);
});

// Fase 6C.1 antecipou servico.findOne: sua falha agora ocorre antes de qualquer escrita.
// As demais falhas continuam verificando os efeitos parciais historicamente caracterizados.
for (const [failure, completed] of [
  ['proposta.findById', 0], ['proposta.populate', 0], ['proposta.save', 0], ['pedido.save', 1],
  ['proposta.updateMany', 2], ['servico.findOne', 0], ['agendamento.create', 3]
]) test(`aceitacao falha em ${failure}: preserva efeitos parciais anteriores sem rollback`, async t => {
  const f = await fixture(t, { failure });
  json(await f.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar', f.headers('cliente'), {}),
    500, { mensagem: 'Erro ao aceitar proposta', erro: FALHA });
  assert.equal(f.calls.at(-1).op, failure);
  assert.deepEqual(f.effects, acceptedEffects.slice(0, completed));
  assert.deepEqual(f.state, {
    pedidos: [{ ...pedido, status: completed >= 2 ? 'em andamento' : pedido.status }],
    propostas: [{ ...proposta, status: completed >= 1 ? 'aceita' : proposta.status },
      { ...other, status: completed >= 3 ? 'recusada' : other.status }],
    agendamentos: [], notificacoes: []
  });
});

for (const [method, url, role, usuarioId, failure, mensagem] of [
  ['POST', '/api/propostas', 'prestador', PRESTADOR, 'pedido.findById', 'Erro ao criar proposta'],
  ['POST', '/api/propostas', 'prestador', PRESTADOR, 'proposta.findOne', 'Erro ao criar proposta'],
  ['POST', '/api/propostas', 'prestador', PRESTADOR, 'proposta.create', 'Erro ao criar proposta'],
  ['GET', '/api/propostas/pedido/' + PEDIDO, 'cliente', CLIENTE, 'proposta.sort', 'Erro ao listar propostas'],
  ['GET', '/api/propostas/prestador', 'prestador', PRESTADOR, 'proposta.find', 'Erro ao listar propostas']
]) test(`${method} ${url}: falha ${failure} preserva 500 sem efeitos`, async t => {
  const f = await fixture(t, { usuarioId, failure, propostas: method === 'POST' ? [] : [proposta, other] });
  const before = plain(f.state);
  json(await f.request(method, url, f.headers(role), input), 500, { mensagem, erro: FALHA });
  assert.equal(f.calls.at(-1).op, failure); assert.deepEqual(f.effects, []); assert.deepEqual(f.state, before);
});

test('erro de indice unico na criacao de proposta conserva 500 atual', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, propostas: [], failure: 'proposta.create', errorCode: 11000 });
  json(await f.request('POST', '/api/propostas', f.headers('prestador'), input),
    500, { mensagem: 'Erro ao criar proposta', erro: FALHA });
  assert.deepEqual(f.effects, []);
});

test('IDs invalidos continuam delegados aos modelos nas tres operacoes por identificador', async t => {
  for (const [method, url, role, failure, mensagem] of [
    ['POST', '/api/propostas', 'prestador', 'pedido.findById', 'Erro ao criar proposta'],
    ['GET', '/api/propostas/pedido/invalido', 'cliente', 'pedido.findById', 'Erro ao listar propostas'],
    ['PUT', '/api/propostas/invalido/aceitar', 'cliente', 'proposta.findById', 'Erro ao aceitar proposta']
  ]) {
    const f = await fixture(t, { failure });
    json(await f.request(method, url, f.headers(role), { ...input, pedido_id: 'invalido' }), 500, { mensagem, erro: FALHA });
    assert.deepEqual(f.calls, [{ op: failure, value: 'invalido' }]); assert.deepEqual(f.effects, []);
  }
});

test('propostas preservam barra final, HEAD, OPTIONS e rejeicao de metodos e caminhos semelhantes', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, propostas: [] });
  assert.equal((await f.request('POST', '/api/propostas/', f.headers('prestador'), input)).status, 201);
  const g = await fixture(t);
  for (const [url, role] of [['/api/propostas/pedido/' + PEDIDO, 'cliente'], ['/api/propostas/prestador', 'prestador']]) {
    assert.equal((await g.request('GET', url + '/', g.headers(role))).status, 200);
    const head = await g.request('HEAD', url, g.headers(role));
    assert.equal(head.status, 200); assert.equal(head.text, '');
  }
  assert.equal((await g.request('PUT', '/api/propostas/' + PROPOSTA + '/aceitar/', g.headers('cliente'), {})).status, 200);
  const before = plain(g.calls);
  for (const [method, url, role] of endpoints) {
    assert.equal((await g.request('OPTIONS', url)).status, 204);
    assert.equal((await g.request(method, url + '/extra', g.headers(role), input)).status, 404);
  }
  assert.equal((await g.request('DELETE', '/api/propostas/' + PROPOSTA, g.headers('prestador'))).status, 404);
  assert.deepEqual(g.calls, before); assert.deepEqual(g.dispatches, []);
});
