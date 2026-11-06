const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CONTA = '1'.repeat(24), OUTRA = '2'.repeat(24), ID = '3'.repeat(24), ID_OUTRA = '4'.repeat(24);
const AUSENTE = '5'.repeat(24), FALHA = 'falha-sintetica-do-modelo';
const secret = 'chave-ficticia-notificacoes-http';
const plain = value => JSON.parse(JSON.stringify(value));
const mensagem = { _id: ID, usuario_id: CONTA, mensagem: 'Aviso ficticio', tipo: 'avaliacao',
  link: '/dashboard-prestador.html', lida: false, data_criacao: '2026-01-02', __v: 0 };
const foreign = { ...mensagem, _id: ID_OUTRA, usuario_id: OUTRA, mensagem: 'Aviso de outra conta' };
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);

async function fixture(t, { records = [mensagem, foreign], failure } = {}) {
  const rows = plain(records), calls = [], saves = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error(FALHA);
  }
  const controllers = controllerStubs(dispatches);
  controllers.notificacaoController = loadController('controllers/notificacaoController.js', {
    '../Models/notificacaoModel': {
      find(filter) {
        record('find', filter);
        return { sort(order) {
          record('sort', order);
          return { async limit(limit) {
            record('limit', limit);
            // A ordenacao e o limite sao verificados nos argumentos; os documentos
            // sao a resposta controlada do modelo, sem simular o motor MongoDB.
            return rows.filter(row => matches(row, filter));
          } };
        } };
      },
      async countDocuments(filter) { record('count', filter); return rows.filter(row => matches(row, filter)).length; },
      async findById(id) {
        record('findById', id);
        const row = rows.find(row => row._id === id);
        if (!row) return null;
        Object.defineProperty(row, 'save', { configurable: true, value: async () => {
          record('save', row._id);
          saves.push(plain(row));
        } });
        return row;
      }
    }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId: CONTA }), rows, calls, saves, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

for (const [method, url] of [['GET', '/api/notificacoes'], ['PUT', '/api/notificacoes/' + ID + '/lida'],
  ['GET', '/api/notificacoes/nao-lidas']]) test(`${method} ${url}: JWT obrigatorio antes do modelo`, async t => {
  const f = await fixture(t);
  for (const [headers, mensagem] of [[{}, 'Acesso negado. Token nao fornecido'],
    [{ Authorization: 'Bearer invalido' }, 'Token invalido ou expirado']]) {
    json(await f.request(method, url, headers), 401, { mensagem });
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.dispatches, []);
});

// Nao ha verificarCliente/verificarPrestador neste dominio. Ambos os papeis sao
// validos; introduzir 403 para prestador seria mudar o contrato.
for (const tipo of ['cliente', 'prestador']) test(`notificacoes de ${tipo}: lista, contagem e leitura da propria conta`, async t => {
  const f = await fixture(t);
  const headers = f.headers(tipo);
  json(await f.request('GET', '/api/notificacoes?usuario_id=' + OUTRA, headers), 200, [mensagem]);
  json(await f.request('GET', '/api/notificacoes/nao-lidas?usuario_id=' + OUTRA, headers), 200, { total: 1 });
  json(await f.request('PUT', '/api/notificacoes/' + ID + '/lida', headers,
    { usuario_id: OUTRA, lida: false }), 200,
  { mensagem: 'Notificacao marcada como lida', notificacao: { ...mensagem, lida: true } });
  json(await f.request('GET', '/api/notificacoes/nao-lidas', headers), 200, { total: 0 });
  assert.deepEqual(f.calls, [
    { op: 'find', value: { usuario_id: CONTA } }, { op: 'sort', value: { data_criacao: -1 } },
    { op: 'limit', value: 30 }, { op: 'count', value: { usuario_id: CONTA, lida: false } },
    { op: 'findById', value: ID }, { op: 'save', value: ID },
    { op: 'count', value: { usuario_id: CONTA, lida: false } }
  ]);
  assert.deepEqual(f.saves, [{ ...mensagem, lida: true }]);
  assert.deepEqual(f.rows[1], foreign);
  assert.deepEqual(f.dispatches, []);
});

test('listagem preserva documentos retornados e solicita ordem descendente e limite fixo 30', async t => {
  const older = { ...mensagem, _id: '6'.repeat(24), data_criacao: '2026-01-01', lida: true };
  const f = await fixture(t, { records: [mensagem, older, foreign] });
  json(await f.request('GET', '/api/notificacoes?limit=100&sort=asc&usuario_id=' + OUTRA,
    f.headers('cliente')), 200, [mensagem, older]);
  assert.deepEqual(f.calls, [{ op: 'find', value: { usuario_id: CONTA } },
    { op: 'sort', value: { data_criacao: -1 } }, { op: 'limit', value: 30 }]);
});

test('lista vazia e contagem zero nao incluem notificacoes da outra conta', async t => {
  const f = await fixture(t, { records: [foreign] });
  json(await f.request('GET', '/api/notificacoes', f.headers('cliente')), 200, []);
  json(await f.request('GET', '/api/notificacoes/nao-lidas', f.headers('cliente')), 200, { total: 0 });
});

test('contagem de nao lidas e independente do limite 30 da listagem', async t => {
  const records = Array.from({ length: 31 }, (_, i) => ({ ...mensagem, _id: String(i + 10).padStart(24, '0') }));
  const f = await fixture(t, { records: [...records, { ...mensagem, lida: true }, foreign] });
  json(await f.request('GET', '/api/notificacoes/nao-lidas', f.headers('cliente')), 200, { total: 31 });
  assert.deepEqual(f.calls, [{ op: 'count', value: { usuario_id: CONTA, lida: false } }]);
});

for (const tipo of ['cliente', 'prestador']) test(`${tipo} nao marca notificacao de outra conta nem recebe seu documento`, async t => {
  const f = await fixture(t);
  json(await f.request('PUT', '/api/notificacoes/' + ID_OUTRA + '/lida', f.headers(tipo), { usuario_id: CONTA }),
    403, { mensagem: 'Voce nao tem permissao para alterar esta notificacao' });
  assert.deepEqual(f.calls, [{ op: 'findById', value: ID_OUTRA }]);
  assert.deepEqual(f.rows, [mensagem, foreign]);
  assert.deepEqual(f.saves, []);
});

test('PUT inexistente retorna 404 sem salvar', async t => {
  const f = await fixture(t);
  json(await f.request('PUT', '/api/notificacoes/' + AUSENTE + '/lida', f.headers('cliente')),
    404, { mensagem: 'Notificacao nao encontrada' });
  assert.deepEqual(f.saves, []);
});

test('marcar notificacao ja lida preserva resposta e chamada save existentes', async t => {
  const f = await fixture(t, { records: [{ ...mensagem, lida: true }] });
  json(await f.request('PUT', '/api/notificacoes/' + ID + '/lida', f.headers('cliente')), 200,
    { mensagem: 'Notificacao marcada como lida', notificacao: { ...mensagem, lida: true } });
  assert.deepEqual(f.saves, [{ ...mensagem, lida: true }]);
});

for (const [method, url, failure, mensagem] of [
  ['GET', '/api/notificacoes', 'find', 'Erro ao listar notificacoes'],
  ['GET', '/api/notificacoes', 'limit', 'Erro ao listar notificacoes'],
  ['GET', '/api/notificacoes/nao-lidas', 'count', 'Erro ao contar notificacoes'],
  ['PUT', '/api/notificacoes/' + ID + '/lida', 'findById', 'Erro ao marcar notificacao'],
  ['PUT', '/api/notificacoes/' + ID + '/lida', 'save', 'Erro ao marcar notificacao']
]) test(`${method} ${url}: erro ${failure} preserva 500 com detalhe atual`, async t => {
  const f = await fixture(t, { failure });
  // Divulgacao de error.message preexistente: caracterizada, nao corrigida aqui.
  json(await f.request(method, url, f.headers('cliente')), 500, { mensagem, erro: FALHA });
  assert.deepEqual(f.saves, []);
});
