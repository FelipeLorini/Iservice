const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CONTA = 'a'.repeat(24), OUTRA = 'b'.repeat(24);
const secret = 'chave-ficticia-portifolio-http', FALHA = 'falha-sintetica-usuario';
const plain = value => JSON.parse(JSON.stringify(value));
const original = { _id: CONTA, nome: 'Prestador ficticio', tipo: 'prestador', senha: 'valor-sintetico',
  portifolio: ['https://example.invalid/antiga.jpg'], descricao_detalhada: 'Descricao antiga' };
const other = { ...original, _id: OUTRA, nome: 'Outro prestador' };

async function fixture(t, { missing = false, failure } = {}) {
  const rows = plain(missing ? [other] : [original, other]), calls = [], saves = [], dispatches = [];
  const controllers = controllerStubs(dispatches);
  controllers.usuarioController = loadController('controllers/usuarioController.js', {
    '../Models/usuarioModel': {
      async findById(id) {
        calls.push({ findById: id });
        if (failure === 'findById') throw Error(FALHA);
        const row = rows.find(row => row._id === id);
        if (!row) return null;
        Object.defineProperty(row, 'save', { configurable: true, value: async () => {
          calls.push({ save: row._id });
          if (failure === 'save') throw Error(FALHA);
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
const result = row => ({ mensagem: 'Portifolio atualizado com sucesso',
  portifolio: row.portifolio, descricao_detalhada: row.descricao_detalhada });

for (const [label, status, mensagem] of [
  ['sem token', 401, 'Acesso negado. Token nao fornecido'],
  ['invalido', 401, 'Token invalido ou expirado'],
  ['cliente', 403, 'Acesso negado. Apenas prestadores podem realizar esta acao']
]) test(`PUT portifolio com controller real: ${label} nao consulta nem salva`, async t => {
  const f = await fixture(t);
  const headers = label === 'sem token' ? {} : label === 'invalido' ? { Authorization: 'Bearer invalido' } : f.headers(label);
  json(await f.request('PUT', '/api/usuario/portifolio', headers, { portifolio: [] }), status, { mensagem });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.rows, [original, other]);
  assert.deepEqual(f.dispatches, []);
});

test('PUT altera somente portifolio e descricao da identidade JWT e devolve contrato exato', async t => {
  const f = await fixture(t);
  const fields = { portifolio: ['https://example.invalid/nova.jpg'], descricao_detalhada: 'Descricao nova' };
  const expected = { ...original, ...fields };
  json(await f.request('PUT', '/api/usuario/portifolio?usuario_id=' + OUTRA, f.headers('prestador'),
    { ...fields, id: OUTRA, _id: OUTRA, usuario_id: OUTRA, nome: 'Nao alterar', tipo: 'cliente', senha: 'Nao alterar' }),
  200, result(expected));
  assert.deepEqual(f.calls, [{ findById: CONTA }, { save: CONTA }]);
  assert.deepEqual(f.saves, [expected]);
  assert.deepEqual(f.rows, [expected, other]);
  assert.deepEqual(f.dispatches, []);
});

for (const [label, body, fields] of [
  ['somente descricao', { descricao_detalhada: '' }, { descricao_detalhada: '' }],
  ['array vazio', { portifolio: [] }, { portifolio: [] }],
  ['portifolio nao array', { portifolio: 'ignorado' }, {}],
  ['corpo vazio', {}, {}],
  ['descricao nula', { descricao_detalhada: null }, { descricao_detalhada: null }]
]) test(`PUT parcial ${label}: preserva selecao de campos e save atuais`, async t => {
  const f = await fixture(t);
  const expected = { ...original, ...fields };
  json(await f.request('PUT', '/api/usuario/portifolio', f.headers('prestador'), body), 200, result(expected));
  assert.deepEqual(f.calls, [{ findById: CONTA }, { save: CONTA }]);
  assert.deepEqual(f.saves, [expected]);
  assert.deepEqual(f.rows[1], other);
});

test('PUT de usuario inexistente retorna 404 sem salvar', async t => {
  const f = await fixture(t, { missing: true });
  json(await f.request('PUT', '/api/usuario/portifolio', f.headers('prestador'), { portifolio: [] }),
    404, { mensagem: 'Usuario nao encontrado' });
  assert.deepEqual(f.calls, [{ findById: CONTA }]);
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.rows, [other]);
});

for (const failure of ['findById', 'save']) test(`PUT falha ${failure} preserva 500 com erro atual`, async t => {
  const f = await fixture(t, { failure });
  json(await f.request('PUT', '/api/usuario/portifolio', f.headers('prestador'), { descricao_detalhada: 'Nova' }),
    500, { mensagem: 'Erro ao atualizar portifolio', erro: FALHA });
  assert.deepEqual(f.calls, failure === 'findById' ? [{ findById: CONTA }] : [{ findById: CONTA }, { save: CONTA }]);
  assert.deepEqual(f.saves, []);
});

test('PUT com barra final funciona e grafia alternativa nao cria outro endpoint', async t => {
  const f = await fixture(t);
  json(await f.request('PUT', '/api/usuario/portifolio/', f.headers('prestador'), {}), 200, result(original));
  for (const [method, url] of [['PUT', '/api/usuario/portfolio'], ['PUT', '/api/usuario/' + OUTRA + '/portifolio'],
    ['POST', '/api/usuario/portifolio'], ['PATCH', '/api/usuario/portifolio']]) {
    assert.equal((await f.request(method, url, f.headers('prestador'), {})).status, 404, `${method} ${url}`);
  }
  assert.deepEqual(f.calls, [{ findById: CONTA }, { save: CONTA }]);
  assert.deepEqual(f.dispatches, []);
});
