const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CLIENTE = '1'.repeat(24), OUTRO = '2'.repeat(24), PRESTADOR = 'a'.repeat(24), ID = '3'.repeat(24);
const AUSENTE = '4'.repeat(24), PRIVADO = 'DADO-PRIVADO-SINTETICO';
const secret = 'chave-ficticia-favoritos-http';
const plain = value => JSON.parse(JSON.stringify(value));
const prestador = { _id: PRESTADOR, tipo: 'prestador', nome: 'Profissional ficticio',
  descricao_detalhada: 'Descricao publica', email: PRIVADO, telefone: PRIVADO, senha: PRIVADO };
const relacao = { _id: ID, cliente_id: CLIENTE, prestador_id: PRESTADOR, data_criacao: '2026-01-01' };
const matches = (record, filter) => Object.entries(filter).every(([key, value]) => record[key] === value);

async function fixture(t, { records = [], failure } = {}) {
  const rows = plain(records), calls = [], dispatches = [];
  const users = [prestador, { _id: OUTRO, tipo: 'cliente', nome: PRIVADO }];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error(PRIVADO);
  }
  const controllers = controllerStubs(dispatches);
  controllers.favoritoController = loadController('controllers/favoritoController.js', {
    '../Models/usuarioModel': {
      findOne(filter) {
        record('usuario', filter);
        return { async select(fields) {
          record('select', fields);
          return users.find(user => matches(user, filter)) || null;
        } };
      }
    },
    '../Models/favoritoModel': {
      async findOne(filter) { record('findOne', filter); return rows.find(row => matches(row, filter)) || null; },
      async create(data) {
        record('create', data);
        if (failure === 'duplicidade') throw Object.assign(Error(PRIVADO), { code: 11000 });
        const row = { _id: ID, ...plain(data) };
        rows.push(row);
        return row;
      },
      async findOneAndDelete(filter) {
        record('delete', filter);
        const index = rows.findIndex(row => matches(row, filter));
        return index < 0 ? null : rows.splice(index, 1)[0];
      },
      find(filter) {
        record('find', filter);
        return { async populate(options) {
          record('populate', options);
          // Devolve campos extras e referencias nao prestadoras para exercitar
          // a projecao/filtro do controller; nao pretende reproduzir o Mongoose.
          return rows.filter(row => matches(row, filter)).map(row => ({ ...row,
            prestador_id: users.find(user => user._id === row.prestador_id) || null }));
        } };
      }
    }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId: CLIENTE }), rows, calls, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

const routes = [['POST', '/api/favoritos'], ['DELETE', '/api/favoritos/' + PRESTADOR],
  ['GET', '/api/favoritos'], ['GET', '/api/favoritos/verificar/' + PRESTADOR]];

for (const [method, url] of routes) test(`${method} ${url}: JWT e papel de cliente antes do modelo`, async t => {
  const f = await fixture(t, { records: [relacao] });
  for (const [headers, status, mensagem] of [
    [{}, 401, 'Acesso negado. Token nao fornecido'],
    [{ Authorization: 'Bearer invalido' }, 401, 'Token invalido ou expirado'],
    [f.headers('prestador'), 403, 'Acesso negado. Apenas clientes podem realizar esta acao']
  ]) json(await f.request(method, url, headers, { prestador_id: PRESTADOR }), status, { mensagem });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.rows, [relacao]);
  assert.deepEqual(f.dispatches, []);
});

test('POST favorito usa identidade do JWT e devolve documento criado com 201', async t => {
  const f = await fixture(t);
  const data = { cliente_id: CLIENTE, prestador_id: PRESTADOR };
  json(await f.request('POST', '/api/favoritos?cliente_id=' + OUTRO, f.headers('cliente'),
    { cliente_id: OUTRO, prestador_id: PRESTADOR }), 201,
  { mensagem: 'Adicionado aos favoritos', favorito: { _id: ID, ...data } });
  assert.deepEqual(f.calls, [
    { op: 'usuario', value: { _id: PRESTADOR, tipo: 'prestador' } }, { op: 'select', value: '_id' },
    { op: 'findOne', value: data }, { op: 'create', value: data }
  ]);
  assert.deepEqual(f.rows, [{ _id: ID, ...data }]);
});

for (const failure of ['preexistente', 'duplicidade']) test(`POST duplicado: ${failure} retorna 400`, async t => {
  const records = failure === 'preexistente' ? [relacao] : [];
  const f = await fixture(t, { records, failure });
  json(await f.request('POST', '/api/favoritos', f.headers('cliente'), { prestador_id: PRESTADOR }),
    400, { mensagem: 'Prestador ja esta nos favoritos' });
  assert.equal(f.calls.filter(call => call.op === 'create').length, failure === 'preexistente' ? 0 : 1);
  assert.deepEqual(f.rows, records);
});

for (const id of [OUTRO, AUSENTE]) test(`destino ${id}: POST 404 e verificacao false`, async t => {
  const f = await fixture(t);
  json(await f.request('POST', '/api/favoritos', f.headers('cliente'), { prestador_id: id }),
    404, { mensagem: 'Prestador nao encontrado' });
  json(await f.request('GET', '/api/favoritos/verificar/' + id, f.headers('cliente')), 200, { favorito: false });
  assert.ok(f.calls.every(call => ['usuario', 'select'].includes(call.op)));
  assert.deepEqual(f.rows, []);
});

test('IDs HTTP invalidos retornam 400 antes de consultas ou exclusoes', async t => {
  const f = await fixture(t);
  for (const [method, url, body] of [
    ['POST', '/api/favoritos', { prestador_id: { $ne: null } }],
    ['GET', '/api/favoritos/verificar/invalido'], ['DELETE', '/api/favoritos/invalido']
  ]) json(await f.request(method, url, f.headers('cliente'), body), 400, { mensagem: 'Informe um prestador valido' });
  assert.deepEqual(f.calls, []);
});

test('GET favoritos limita consulta a sessao, filtra referencias e projeta campos publicos', async t => {
  const records = [{ ...relacao, campo_futuro: PRIVADO },
    { ...relacao, _id: '5'.repeat(24), cliente_id: OUTRO },
    { ...relacao, _id: '6'.repeat(24), prestador_id: AUSENTE },
    { ...relacao, _id: '7'.repeat(24), prestador_id: OUTRO }];
  const f = await fixture(t, { records });
  const res = await f.request('GET', '/api/favoritos?cliente_id=' + OUTRO, f.headers('cliente'));
  json(res, 200, [{ ...relacao, prestador_id: {
    _id: PRESTADOR, nome: prestador.nome, descricao_detalhada: prestador.descricao_detalhada
  } }]);
  assert.ok(!res.text.includes(PRIVADO));
  assert.deepEqual(f.calls, [{ op: 'find', value: { cliente_id: CLIENTE } }, { op: 'populate', value: {
    path: 'prestador_id', match: { tipo: 'prestador' }, select: 'nome tipo descricao_detalhada', skipInvalidIds: true
  } }]);
  assert.deepEqual(f.rows, records);
});

test('GET favoritos vazio preserva array sem envelope', async t => {
  const f = await fixture(t);
  json(await f.request('GET', '/api/favoritos', f.headers('cliente')), 200, []);
});

test('verificacao e DELETE nao usam relacao de outra conta; :id e o prestador', async t => {
  const foreign = { ...relacao, _id: '5'.repeat(24), cliente_id: OUTRO };
  const f = await fixture(t, { records: [foreign] });
  json(await f.request('GET', '/api/favoritos/verificar/' + PRESTADOR + '?cliente_id=' + OUTRO,
    f.headers('cliente')), 200, { favorito: false });
  json(await f.request('DELETE', '/api/favoritos/' + PRESTADOR, f.headers('cliente'), { cliente_id: OUTRO }),
    404, { mensagem: 'Favorito nao encontrado' });
  assert.deepEqual(f.calls.filter(call => ['findOne', 'delete'].includes(call.op)), [
    { op: 'findOne', value: { cliente_id: CLIENTE, prestador_id: PRESTADOR } },
    { op: 'delete', value: { prestador_id: PRESTADOR, cliente_id: CLIENTE } }
  ]);
  assert.deepEqual(f.rows, [foreign]);
});

test('verificacao propria true; DELETE aceita ID do prestador, nao ID da relacao', async t => {
  const f = await fixture(t, { records: [relacao] });
  json(await f.request('GET', '/api/favoritos/verificar/' + PRESTADOR, f.headers('cliente')), 200, { favorito: true });
  json(await f.request('DELETE', '/api/favoritos/' + ID, f.headers('cliente')), 404, { mensagem: 'Favorito nao encontrado' });
  assert.deepEqual(f.rows, [relacao]);
  json(await f.request('DELETE', '/api/favoritos/' + PRESTADOR, f.headers('cliente')), 200, { mensagem: 'Removido dos favoritos' });
  assert.deepEqual(f.calls.filter(call => call.op === 'delete').map(call => call.value), [
    { prestador_id: ID, cliente_id: CLIENTE }, { prestador_id: PRESTADOR, cliente_id: CLIENTE }
  ]);
  assert.deepEqual(f.rows, []);
});

for (const [method, url, failure, mensagem] of [
  ['POST', '/api/favoritos', 'create', 'Erro ao adicionar favorito'],
  ['GET', '/api/favoritos', 'populate', 'Erro ao listar favoritos'],
  ['GET', '/api/favoritos/verificar/' + PRESTADOR, 'findOne', 'Erro ao verificar favorito'],
  ['DELETE', '/api/favoritos/' + PRESTADOR, 'delete', 'Erro ao remover favorito']
]) test(`${method} ${url}: falha retorna 500 sanitizado`, async t => {
  const f = await fixture(t, { failure });
  const res = await f.request(method, url, f.headers('cliente'), { prestador_id: PRESTADOR });
  json(res, 500, { mensagem });
  assert.ok(!res.text.includes(PRIVADO));
});
