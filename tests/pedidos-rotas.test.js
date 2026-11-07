const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CLIENTE = 'a'.repeat(24), OUTRO = 'b'.repeat(24), ID = 'abcdef0123456789abcdef01';
const NOVO = 'c'.repeat(24), secret = 'chave-ficticia-pedidos-http', FALHA = 'falha-sintetica-pedidos';
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const input = { titulo: 'Servico ficticio', descricao: 'Descricao ficticia', categoria: 'faxina', data_desejada: '2026-12-10' };
const pedido = { _id: ID, cliente_id: CLIENTE, ...input, status: 'aberto', data_criacao: '2026-01-01', __v: 0 };
const other = { ...pedido, _id: '2'.repeat(24), cliente_id: OUTRO, categoria: 'pintura', data_criacao: '2026-01-02' };

async function fixture(t, { records = [pedido, other], failure } = {}) {
  const rows = plain(records), calls = [], writes = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error(FALHA);
  }
  const controllers = controllerStubs(dispatches);
  controllers.pedidoController = loadController('controllers/pedidoController.js', {
    '../Models/pedidoModel': {
      async create(data) {
        record('create', data);
        const row = { _id: NOVO, ...plain(data), status: 'aberto' };
        rows.push(row); writes.push(plain(row)); return row;
      },
      find(filter) {
        record('find', filter);
        const query = { populate(...args) { record('populate', args); return query; },
          async sort(order) {
            record('sort', order);
            return rows.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value))
              .sort((a, b) => b.data_criacao.localeCompare(a.data_criacao));
          }
        };
        return query;
      },
      async findById(id) {
        record('findById', id);
        const index = rows.findIndex(row => row._id === id.toLowerCase());
        if (index === -1) return null;
        const doc = plain(rows[index]);
        Object.defineProperty(doc, 'save', { value: async () => {
          record('save', doc); rows[index] = plain(doc); writes.push(plain(doc));
        } });
        return doc;
      }
    }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId: CLIENTE }), rows, calls, writes, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

const endpoints = [['POST', '/api/pedidos', 'cliente'], ['GET', '/api/pedidos/cliente', 'cliente'],
  ['GET', '/api/pedidos/abertos', 'prestador'], ['PUT', '/api/pedidos/' + ID + '/cancelar', 'cliente']];

for (const [method, url, role] of endpoints) test(`${method} ${url}: JWT e papel antes do controller real`, async t => {
  const f = await fixture(t);
  for (const [headers, status, mensagem] of [
    [{}, 401, 'Acesso negado. Token nao fornecido'],
    [{ Authorization: 'Bearer invalido' }, 401, 'Token invalido ou expirado'],
    [f.headers(role === 'cliente' ? 'prestador' : 'cliente'), 403,
      `Acesso negado. Apenas ${role === 'cliente' ? 'clientes' : 'prestadores'} podem realizar esta acao`]
  ]) json(await f.request(method, url, headers, input), status, { mensagem });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  assert.deepEqual(f.rows, [pedido, other]); assert.deepEqual(f.dispatches, []);
});

test('POST pedidos usa cliente JWT, seleciona campos e preserva resposta 201', async t => {
  const f = await fixture(t);
  const row = { _id: NOVO, cliente_id: CLIENTE, ...input, status: 'aberto' };
  json(await f.request('POST', '/api/pedidos?cliente_id=' + OUTRO, f.headers('cliente'),
    { ...input, cliente_id: OUTRO, _id: OUTRO, status: 'finalizado', extra: true }), 201,
  { mensagem: 'Pedido criado com sucesso', pedido: row });
  assert.deepEqual(f.calls, [{ op: 'create', value: { cliente_id: CLIENTE, ...input } }]);
  assert.deepEqual(f.writes, [row]); assert.deepEqual(f.rows, [pedido, other, row]);
});

test('GET cliente filtra somente pela sessao e solicita ordem decrescente', async t => {
  const newer = { ...pedido, _id: NOVO, status: 'cancelado', data_criacao: '2026-01-03' };
  const f = await fixture(t, { records: [pedido, other, newer] });
  json(await f.request('GET', '/api/pedidos/cliente?cliente_id=' + OUTRO + '&status=aberto', f.headers('cliente')),
    200, [newer, pedido]);
  assert.deepEqual(f.calls, [{ op: 'find', value: { cliente_id: CLIENTE } }, { op: 'sort', value: { data_criacao: -1 } }]);
  assert.deepEqual(f.writes, []);
});

for (const categoria of [undefined, 'faxina', 'inexistente', '']) test(`GET abertos preserva filtro categoria=${categoria}`, async t => {
  const closed = { ...pedido, _id: NOVO, status: 'cancelado' };
  const f = await fixture(t, { records: [pedido, other, closed] });
  const suffix = categoria === undefined ? '' : '?categoria=' + categoria;
  const expected = categoria === 'faxina' ? [pedido] : categoria === 'inexistente' ? [] : [other, pedido];
  json(await f.request('GET', '/api/pedidos/abertos' + suffix, f.headers('prestador')), 200, expected);
  assert.deepEqual(f.calls, [{ op: 'find', value: { status: 'aberto', ...(categoria ? { categoria } : {}) } },
    { op: 'populate', value: ['cliente_id', 'nome'] }, { op: 'sort', value: { data_criacao: -1 } }]);
  assert.deepEqual(f.writes, []);
});

test('listas vazias mantem array e nao confundem pedidos de outro cliente', async t => {
  const f = await fixture(t, { records: [{ ...other, status: 'cancelado' }] });
  json(await f.request('GET', '/api/pedidos/cliente', f.headers('cliente')), 200, []);
  json(await f.request('GET', '/api/pedidos/abertos', f.headers('prestador')), 200, []);
});

test('cancelamento usa parametro original e altera apenas status do proprio pedido', async t => {
  const f = await fixture(t);
  const row = { ...pedido, status: 'cancelado' };
  json(await f.request('PUT', '/api/pedidos/' + ID.toUpperCase() + '/cancelar?id=' + other._id,
    f.headers('cliente'), { id: other._id, cliente_id: OUTRO, status: 'finalizado', titulo: 'ignorado' }),
  200, { mensagem: 'Pedido cancelado com sucesso', pedido: row });
  assert.deepEqual(f.calls, [{ op: 'findById', value: ID.toUpperCase() }, { op: 'save', value: row }]);
  assert.deepEqual(f.rows, [row, other]); assert.deepEqual(f.writes, [row]);
});

for (const missing of [false, true]) test(`cancelamento nega outra conta ou inexistente: ausente=${missing}`, async t => {
  const f = await fixture(t, { records: missing ? [] : [other] });
  const id = missing ? ID : other._id;
  json(await f.request('PUT', '/api/pedidos/' + id + '/cancelar', f.headers('cliente'), { cliente_id: CLIENTE }),
    missing ? 404 : 403, { mensagem: missing ? 'Pedido nao encontrado' : 'Voce nao tem permissao para cancelar este pedido' });
  assert.deepEqual(f.calls, [{ op: 'findById', value: id }]);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.rows, missing ? [] : [other]);
});

test('cancelamento nao restringe status anterior inclusive finalizado e em andamento', async t => {
  for (const status of ['aberto', 'em andamento', 'finalizado', 'cancelado']) {
    const f = await fixture(t, { records: [{ ...pedido, status }] });
    const row = { ...pedido, status: 'cancelado' };
    json(await f.request('PUT', '/api/pedidos/' + ID + '/cancelar', f.headers('cliente'), {}),
      200, { mensagem: 'Pedido cancelado com sucesso', pedido: row });
    assert.deepEqual(f.writes, [row]);
  }
});

for (const [method, url, role, failure, mensagem] of [
  ['POST', '/api/pedidos', 'cliente', 'create', 'Erro ao criar pedido'],
  ['GET', '/api/pedidos/cliente', 'cliente', 'find', 'Erro ao listar pedidos'],
  ['GET', '/api/pedidos/cliente', 'cliente', 'sort', 'Erro ao listar pedidos'],
  ['GET', '/api/pedidos/abertos', 'prestador', 'populate', 'Erro ao listar pedidos abertos'],
  ['PUT', '/api/pedidos/' + ID + '/cancelar', 'cliente', 'findById', 'Erro ao cancelar pedido'],
  ['PUT', '/api/pedidos/' + ID + '/cancelar', 'cliente', 'save', 'Erro ao cancelar pedido']
]) test(`${method} ${url}: erro ${failure} preserva 500 sem escrita simulada`, async t => {
  const f = await fixture(t, { failure });
  json(await f.request(method, url, f.headers(role), input), 500, { mensagem, erro: FALHA });
  assert.equal(f.calls.at(-1).op, failure);
  assert.deepEqual(f.rows, [pedido, other]); assert.deepEqual(f.writes, []);
});

test('pedidos delegam validacao de campos e ID ao modelo', async t => {
  const f = await fixture(t, { failure: 'create' });
  json(await f.request('POST', '/api/pedidos', f.headers('cliente'), {}), 500, { mensagem: 'Erro ao criar pedido', erro: FALHA });
  assert.deepEqual(f.calls, [{ op: 'create', value: { cliente_id: CLIENTE } }]);
  const g = await fixture(t, { failure: 'findById' });
  json(await g.request('PUT', '/api/pedidos/invalido/cancelar', g.headers('cliente'), {}),
    500, { mensagem: 'Erro ao cancelar pedido', erro: FALHA });
  assert.deepEqual(g.calls, [{ op: 'findById', value: 'invalido' }]);
});

test('pedidos preservam barra final, HEAD, OPTIONS e rejeicao de metodos e caminhos semelhantes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/pedidos/', f.headers('cliente'), input)).status, 201);
  for (const [suffix, role] of [['cliente', 'cliente'], ['abertos', 'prestador']]) {
    assert.equal((await f.request('GET', '/api/pedidos/' + suffix + '/', f.headers(role))).status, 200);
    const head = await f.request('HEAD', '/api/pedidos/' + suffix, f.headers(role));
    assert.equal(head.status, 200); assert.equal(head.text, '');
  }
  assert.equal((await f.request('PUT', '/api/pedidos/' + ID + '/cancelar/', f.headers('cliente'), {})).status, 200);
  const before = plain(f.calls);
  for (const [method, url, role] of endpoints) {
    assert.equal((await f.request('OPTIONS', url)).status, 204);
    assert.equal((await f.request(method, url + '/extra', f.headers(role), input)).status, 404);
  }
  assert.equal((await f.request('DELETE', '/api/pedidos/' + ID, f.headers('cliente'))).status, 404);
  assert.deepEqual(f.calls, before); assert.deepEqual(f.dispatches, []);
});
