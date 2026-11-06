const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CLIENTE = 'a'.repeat(24), PRESTADOR = 'b'.repeat(24), OUTRO = 'c'.repeat(24);
const ID = 'abcdef0123456789abcdef01', SERVICO = 'd'.repeat(24), NOVO = 'e'.repeat(24);
const secret = 'chave-exclusivamente-ficticia-agendamentos-http', FALHA = 'falha-sintetica-agendamentos';
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const input = { servico_id: SERVICO, data: '2026-12-10', hora: '10:00' };
const appointment = { _id: ID, cliente_id: CLIENTE, prestador_id: PRESTADOR, ...input, status: 'pendente', __v: 0 };
const other = { ...appointment, _id: '2'.repeat(24), cliente_id: OUTRO, prestador_id: OUTRO };

async function fixture(t, { usuarioId = CLIENTE, records = [appointment, other], missingService = false,
  failure, beforeAvailability } = {}) {
  // Estado persistido simulado separado dos documentos mutaveis retornados por findById.
  const rows = plain(records), calls = [], writes = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error(FALHA);
  }
  const controllers = controllerStubs(dispatches);
  controllers.agendamentoController = loadController('controllers/agendamentoController.js', {
    '../Models/servicoModel': { async findById(id) {
      record('servico.findById', id);
      return missingService ? null : { _id: SERVICO, prestador_id: PRESTADOR };
    } },
    '../Models/agendamentoModel': {
      async findOne(filter) {
        record('findOne', filter);
        const result = rows.find(row => row.prestador_id === filter.prestador_id &&
          row.data === filter.data && row.hora === filter.hora && filter.status.$in.includes(row.status));
        if (beforeAvailability) await beforeAvailability();
        return result || null;
      },
      async create(data) {
        record('create', data);
        const row = { _id: NOVO, ...plain(data), status: 'pendente' };
        rows.push(row);
        writes.push({ op: 'create', row: plain(row) });
        return row;
      },
      find(filter) {
        record('find', filter);
        const matches = plain(rows.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)));
        const query = { populate(field, fields) {
          record('populate', [field, fields]);
          return query;
        }, then(resolve, reject) {
          try { record('list', null); return Promise.resolve(matches).then(resolve, reject); }
          catch (error) { return Promise.reject(error).then(resolve, reject); }
        } };
        return query;
      },
      async findById(id) {
        record('findById', id);
        const index = rows.findIndex(row => row._id === id.toLowerCase());
        if (index === -1) return null;
        const doc = plain(rows[index]);
        Object.defineProperty(doc, 'save', { value: async () => {
          record('save', doc);
          rows[index] = plain(doc);
          writes.push({ op: 'save', row: plain(doc) });
        } });
        return doc;
      }
    }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId }), rows, calls, writes, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

const endpoints = [
  ['POST', '/api/agendamentos', 'cliente'],
  ['GET', '/api/agendamentos/cliente', 'cliente'],
  ['GET', '/api/agendamentos/prestador', 'prestador'],
  ['PUT', '/api/agendamentos/' + ID + '/status', 'prestador'],
  ['PUT', '/api/agendamentos/' + ID + '/cancelar', 'cliente']
];

for (const [method, url, role] of endpoints) test(`${method} ${url}: JWT e papel antes de qualquer acesso ao modelo`, async t => {
  const f = await fixture(t);
  const wrongRole = role === 'cliente' ? 'prestador' : 'cliente';
  for (const [headers, status, mensagem] of [
    [{}, 401, 'Acesso negado. Token nao fornecido'],
    [{ Authorization: 'Bearer invalido' }, 401, 'Token invalido ou expirado'],
    [f.headers(wrongRole), 403, `Acesso negado. Apenas ${role === 'cliente' ? 'clientes' : 'prestadores'} podem realizar esta acao`]
  ]) json(await f.request(method, url, headers, { ...input, status: 'confirmado' }), status, { mensagem });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.rows, [appointment, other]);
  assert.deepEqual(f.dispatches, []);
});

test('POST deriva cliente do JWT e prestador do servico, sem aceitar propriedade ou status forjados', async t => {
  const f = await fixture(t, { records: [other] });
  const row = { _id: NOVO, cliente_id: CLIENTE, prestador_id: PRESTADOR, ...input, status: 'pendente' };
  json(await f.request('POST', '/api/agendamentos?cliente_id=' + OUTRO, f.headers('cliente'),
    { ...input, cliente_id: OUTRO, prestador_id: OUTRO, _id: OUTRO, status: 'finalizado', campo_extra: true }),
  201, { mensagem: 'Servico agendado com sucesso', agendamento: row });
  assert.deepEqual(f.calls, [
    { op: 'servico.findById', value: SERVICO },
    { op: 'findOne', value: { prestador_id: PRESTADOR, data: input.data, hora: input.hora,
      status: { $in: ['pendente', 'confirmado'] } } },
    { op: 'create', value: { cliente_id: CLIENTE, prestador_id: PRESTADOR, ...input } }
  ]);
  assert.deepEqual(f.writes, [{ op: 'create', row }]);
  assert.deepEqual(f.rows, [other, row]);
  assert.deepEqual(f.dispatches, []);
});

test('POST de servico inexistente retorna 404 antes de consultar disponibilidade', async t => {
  const f = await fixture(t, { missingService: true });
  json(await f.request('POST', '/api/agendamentos', f.headers('cliente'), input), 404, { mensagem: 'Servico nao encontrado' });
  assert.deepEqual(f.calls, [{ op: 'servico.findById', value: SERVICO }]);
  assert.deepEqual(f.writes, []);
});

for (const status of ['pendente', 'confirmado']) test(`disponibilidade bloqueia ${status} de outro cliente e servico do mesmo prestador`, async t => {
  const occupied = { ...appointment, cliente_id: OUTRO, servico_id: OUTRO, status };
  const f = await fixture(t, { records: [occupied] });
  json(await f.request('POST', '/api/agendamentos', f.headers('cliente'), input),
    400, { mensagem: 'Horario indisponivel para este prestador' });
  assert.deepEqual(f.calls.map(call => call.op), ['servico.findById', 'findOne']);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.rows, [occupied]);
});

for (const [label, changes] of [
  ['cancelado', { status: 'cancelado' }], ['finalizado', { status: 'finalizado' }],
  ['outro prestador', { prestador_id: OUTRO }], ['outra data', { data: '2026-12-11' }], ['outra hora', { hora: '11:00' }]
]) test(`disponibilidade nao bloqueia registro ${label}`, async t => {
  const existing = { ...appointment, ...changes };
  const f = await fixture(t, { records: [existing] });
  const row = { _id: NOVO, cliente_id: CLIENTE, prestador_id: PRESTADOR, ...input, status: 'pendente' };
  json(await f.request('POST', '/api/agendamentos', f.headers('cliente'), input),
    201, { mensagem: 'Servico agendado com sucesso', agendamento: row });
  assert.deepEqual(f.rows, [existing, row]);
  assert.deepEqual(f.writes, [{ op: 'create', row }]);
});

for (const [role, field, population] of [
  ['cliente', 'cliente_id', 'prestador_id'], ['prestador', 'prestador_id', 'cliente_id']
]) {
  test(`GET ${role} usa somente a identidade JWT e preserva documentos e populate`, async t => {
    const usuarioId = role === 'cliente' ? CLIENTE : PRESTADOR;
    const f = await fixture(t, { usuarioId });
    json(await f.request('GET', '/api/agendamentos/' + role + '?' + field + '=' + OUTRO, f.headers(role)), 200, [appointment]);
    assert.deepEqual(f.calls, [{ op: 'find', value: { [field]: usuarioId } },
      { op: 'populate', value: [population, 'nome telefone'] },
      { op: 'populate', value: ['servico_id', 'nome preco'] }, { op: 'list', value: null }]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.dispatches, []);
  });

  test(`GET ${role} vazio nao inclui registros de outra conta`, async t => {
    const f = await fixture(t, { usuarioId: role === 'cliente' ? CLIENTE : PRESTADOR, records: [other] });
    json(await f.request('GET', '/api/agendamentos/' + role, f.headers(role)), 200, []);
    assert.deepEqual(f.writes, []);
  });
}

for (const [suffix, role, usuarioId, status, mensagem] of [
  ['status', 'prestador', PRESTADOR, 'confirmado', 'Status atualizado com sucesso'],
  ['cancelar', 'cliente', CLIENTE, 'cancelado', 'Agendamento cancelado com sucesso']
]) {
  test(`PUT ${suffix} usa parametro da URL e altera somente status do recurso proprio`, async t => {
    const f = await fixture(t, { usuarioId });
    const row = { ...appointment, status };
    json(await f.request('PUT', '/api/agendamentos/' + ID.toUpperCase() + '/' + suffix + '?id=' + other._id,
      f.headers(role), { id: other._id, _id: other._id, cliente_id: OUTRO, prestador_id: OUTRO,
        servico_id: OUTRO, data: 'forjada', hora: 'forjada', status: 'confirmado' }), 200, { mensagem, agendamento: row });
    assert.deepEqual(f.calls, [{ op: 'findById', value: ID.toUpperCase() }, { op: 'save', value: row }]);
    assert.deepEqual(f.writes, [{ op: 'save', row }]);
    assert.deepEqual(f.rows, [row, other]);
    assert.deepEqual(f.dispatches, []);
  });

  test(`PUT ${suffix} inexistente retorna 404 sem salvar`, async t => {
    const f = await fixture(t, { usuarioId, records: [other] });
    json(await f.request('PUT', '/api/agendamentos/' + ID + '/' + suffix, f.headers(role), { status }),
      404, { mensagem: 'Agendamento nao encontrado' });
    assert.deepEqual(f.calls, [{ op: 'findById', value: ID }]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.rows, [other]);
  });

  test(`PUT ${suffix} de outra conta retorna 403 mesmo com propriedade forjada`, async t => {
    const f = await fixture(t, { usuarioId });
    json(await f.request('PUT', '/api/agendamentos/' + other._id + '/' + suffix,
      f.headers(role), { cliente_id: CLIENTE, prestador_id: PRESTADOR, status }),
    403, { mensagem: suffix === 'status' ? 'Voce nao tem permissao para alterar este agendamento' :
      'Voce nao tem permissao para cancelar este agendamento' });
    assert.deepEqual(f.calls, [{ op: 'findById', value: other._id }]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.rows, [appointment, other]);
  });
}

test('PUT status nao restringe transicoes e nao reconsulta disponibilidade ao reabrir finalizado', async t => {
  for (const status of ['pendente', 'confirmado', 'cancelado', 'finalizado']) {
    const f = await fixture(t, { usuarioId: PRESTADOR, records: [{ ...appointment, status: 'finalizado' }] });
    const row = { ...appointment, status };
    json(await f.request('PUT', '/api/agendamentos/' + ID + '/status', f.headers('prestador'), { status }),
      200, { mensagem: 'Status atualizado com sucesso', agendamento: row });
    assert.deepEqual(f.calls, [{ op: 'findById', value: ID }, { op: 'save', value: row }]);
    assert.deepEqual(f.writes, [{ op: 'save', row }]);
  }
});

test('PUT cancelar aceita inclusive finalizado ou ja cancelado, ignorando status do corpo', async t => {
  for (const status of ['pendente', 'confirmado', 'cancelado', 'finalizado']) {
    const f = await fixture(t, { records: [{ ...appointment, status }] });
    const row = { ...appointment, status: 'cancelado' };
    json(await f.request('PUT', '/api/agendamentos/' + ID + '/cancelar', f.headers('cliente'), { status: 'finalizado' }),
      200, { mensagem: 'Agendamento cancelado com sucesso', agendamento: row });
    assert.deepEqual(f.calls, [{ op: 'findById', value: ID }, { op: 'save', value: row }]);
    assert.deepEqual(f.writes, [{ op: 'save', row }]);
  }
});

for (const [method, url, role, usuarioId, failure, mensagem] of [
  ['POST', '/api/agendamentos', 'cliente', CLIENTE, 'servico.findById', 'Erro ao agendar servico'],
  ['POST', '/api/agendamentos', 'cliente', CLIENTE, 'findOne', 'Erro ao agendar servico'],
  ['POST', '/api/agendamentos', 'cliente', CLIENTE, 'create', 'Erro ao agendar servico'],
  ['GET', '/api/agendamentos/cliente', 'cliente', CLIENTE, 'list', 'Erro ao listar agendamentos'],
  ['GET', '/api/agendamentos/prestador', 'prestador', PRESTADOR, 'find', 'Erro ao listar agendamentos'],
  ['PUT', '/api/agendamentos/' + ID + '/status', 'prestador', PRESTADOR, 'findById', 'Erro ao atualizar status'],
  ['PUT', '/api/agendamentos/' + ID + '/status', 'prestador', PRESTADOR, 'save', 'Erro ao atualizar status'],
  ['PUT', '/api/agendamentos/' + ID + '/cancelar', 'cliente', CLIENTE, 'findById', 'Erro ao cancelar agendamento'],
  ['PUT', '/api/agendamentos/' + ID + '/cancelar', 'cliente', CLIENTE, 'save', 'Erro ao cancelar agendamento']
]) test(`${method} ${url}: falha ${failure} preserva 500 e estado persistido simulado`, async t => {
  const f = await fixture(t, { usuarioId, failure, records: failure === 'create' ? [other] : [appointment, other] });
  const before = plain(f.rows);
  json(await f.request(method, url, f.headers(role), { ...input, status: 'confirmado' }), 500, { mensagem, erro: FALHA });
  assert.equal(f.calls.at(-1).op, failure);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.rows, before);
});

test('POST delega campos ausentes ao modelo sem nova validacao HTTP', async t => {
  const f = await fixture(t, { failure: 'servico.findById' });
  json(await f.request('POST', '/api/agendamentos', f.headers('cliente'), {}),
    500, { mensagem: 'Erro ao agendar servico', erro: FALHA });
  assert.deepEqual(f.calls, [{ op: 'servico.findById', value: undefined }]);
  assert.deepEqual(f.writes, []);
});

test('PUT status delega valor fora do enum ao save e preserva falha do modelo', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR, failure: 'save' });
  json(await f.request('PUT', '/api/agendamentos/' + ID + '/status', f.headers('prestador'), { status: 'invalido' }),
    500, { mensagem: 'Erro ao atualizar status', erro: FALHA });
  assert.deepEqual(f.calls, [{ op: 'findById', value: ID }, { op: 'save', value: { ...appointment, status: 'invalido' } }]);
  assert.deepEqual(f.rows, [appointment, other]);
  assert.deepEqual(f.writes, []);
});

test('PUTs encaminham ID malformado ao modelo, preservando 500 quando a consulta falha', async t => {
  for (const [suffix, role, usuarioId, mensagem] of [
    ['status', 'prestador', PRESTADOR, 'Erro ao atualizar status'],
    ['cancelar', 'cliente', CLIENTE, 'Erro ao cancelar agendamento']
  ]) {
    const f = await fixture(t, { usuarioId, failure: 'findById' });
    json(await f.request('PUT', '/api/agendamentos/invalido/' + suffix, f.headers(role), { status: 'confirmado' }),
      500, { mensagem, erro: FALHA });
    assert.deepEqual(f.calls, [{ op: 'findById', value: 'invalido' }]);
    assert.deepEqual(f.writes, []);
  }
});

test('concorrencia simulada evidencia consulta e criacao separadas sem reserva atomica', async t => {
  let checks = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { records: [], async beforeAvailability() {
    if (++checks === 2) release();
    await gate;
  } });
  const results = await Promise.all([1, 2].map(() => f.request('POST', '/api/agendamentos', f.headers('cliente'), input)));
  assert.deepEqual(results.map(res => res.status), [201, 201]);
  assert.equal(f.calls.filter(call => call.op === 'findOne').length, 2);
  assert.equal(f.calls.filter(call => call.op === 'create').length, 2);
  assert.equal(f.writes.length, 2);
});

test('rotas preservam barra final, HEAD e rejeitam caminhos e metodos alternativos', async t => {
  const f = await fixture(t, { usuarioId: PRESTADOR });
  const head = await f.request('HEAD', '/api/agendamentos/prestador', f.headers('prestador'));
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal((await f.request('HEAD', '/api/agendamentos/prestador')).status, 401);
  const g = await fixture(t, { records: [] });
  assert.equal((await g.request('POST', '/api/agendamentos/', g.headers('cliente'), input)).status, 201);
  assert.equal((await g.request('GET', '/api/agendamentos/cliente/', g.headers('cliente'))).status, 200);
  assert.equal((await f.request('GET', '/api/agendamentos/prestador/', f.headers('prestador'))).status, 200);
  assert.equal((await f.request('PUT', '/api/agendamentos/' + ID + '/status/', f.headers('prestador'), { status: 'confirmado' })).status, 200);
  assert.equal((await g.request('PUT', '/api/agendamentos/' + NOVO + '/cancelar/', g.headers('cliente'), {})).status, 200);
  const before = plain(f.calls);
  for (const [method, url, role] of endpoints) {
    assert.equal((await f.request('OPTIONS', url)).status, 204);
    assert.equal((await f.request(method, url + '/extra', f.headers(role), input)).status, 404);
  }
  for (const [method, url] of [['GET', '/api/agendamentos'], ['DELETE', '/api/agendamentos/' + ID],
    ['POST', '/api/agendamentos/cliente'], ['PATCH', '/api/agendamentos/' + ID + '/status']]) {
    assert.equal((await f.request(method, url, f.headers('prestador'), input)).status, 404);
  }
  assert.deepEqual(f.calls, before);
  assert.deepEqual(f.dispatches, []);
});
