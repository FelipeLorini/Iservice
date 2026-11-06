const test = require('node:test');
const assert = require('node:assert/strict');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const PRESTADOR = 'a'.repeat(24), OUTRO = 'b'.repeat(24), ID = 'abcdef0123456789abcdef01';
const secret = 'chave-ficticia-servicos-protegidos', FALHA = 'falha-sintetica-modelo';
const plain = value => JSON.parse(JSON.stringify(value));
const proprio = { _id: ID, prestador_id: PRESTADOR, nome: 'Servico ficticio', descricao: 'Descricao',
  preco: 80, categoria: 'faxina', data_criacao: '2026-01-01', __v: 0 };
const alheio = { ...proprio, _id: '2'.repeat(24), prestador_id: OUTRO };

async function fixture(t, { records = [proprio, alheio], failure } = {}) {
  const rows = plain(records), calls = [], writes = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error(FALHA);
  }
  const controllers = controllerStubs(dispatches);
  controllers.ServicoController = loadController('controllers/ServicoController.js', {
    '../Models/servicoModel': {
      async find(filter) { record('find', filter); return rows.filter(row => row.prestador_id === filter.prestador_id); },
      async create(data) {
        record('create', data);
        const row = { _id: ID, ...plain(data) };
        writes.push(row);
        return row;
      },
      async findById(id) {
        record('findById', id);
        const row = rows.find(row => row._id === id.toLowerCase());
        if (!row) return null;
        return { ...row, async deleteOne() { record('deleteOne', id); writes.push({ deleted: row._id }); } };
      }
    }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId: PRESTADOR }), calls, writes, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

test('GET prestador filtra pela sessao e preserva documentos privados da propria conta', async t => {
  const f = await fixture(t);
  json(await f.request('GET', '/api/servicos/prestador?prestador_id=' + OUTRO, f.headers('prestador')),
    200, [proprio]);
  assert.deepEqual(f.calls, [{ op: 'find', value: { prestador_id: PRESTADOR } }]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.dispatches, []);
});

test('GET prestador sem servicos nao retorna registros de outra conta', async t => {
  const f = await fixture(t, { records: [alheio] });
  json(await f.request('GET', '/api/servicos/prestador', f.headers('prestador')), 200, []);
});

test('POST seleciona campos permitidos e ignora propriedade e ID enviados pelo cliente', async t => {
  const f = await fixture(t);
  const input = { nome: 'Novo servico', descricao: 'Descricao nova', preco: 90, categoria: 'faxina' };
  const expected = { ...input, prestador_id: PRESTADOR };
  json(await f.request('POST', '/api/servicos?prestador_id=' + OUTRO, f.headers('prestador'),
    { ...input, _id: '9'.repeat(24), prestador_id: OUTRO, campo_extra: 'ignorado' }), 201,
  { mensagem: 'Servico cadastrado com sucesso', servico: { _id: ID, ...expected } });
  assert.deepEqual(f.calls, [{ op: 'create', value: expected }]);
  assert.deepEqual(f.writes, [{ _id: ID, ...expected }]);
});

test('DELETE encaminha parametro id em maiusculas sem usar id ou proprietario do corpo', async t => {
  const f = await fixture(t);
  json(await f.request('DELETE', '/api/servicos/' + ID.toUpperCase() + '?id=' + alheio._id,
    f.headers('prestador'), { id: alheio._id, prestador_id: OUTRO }), 200,
  { mensagem: 'Servico deletado com sucesso' });
  assert.deepEqual(f.calls, [{ op: 'findById', value: ID.toUpperCase() }, { op: 'deleteOne', value: ID.toUpperCase() }]);
  assert.deepEqual(f.writes, [{ deleted: ID }]);
});

test('DELETE de outra conta continua proibido mesmo com proprietario forjado no corpo', async t => {
  const f = await fixture(t);
  json(await f.request('DELETE', '/api/servicos/' + alheio._id, f.headers('prestador'), { prestador_id: PRESTADOR }),
    403, { mensagem: 'Voce nao tem permissao para deletar este servico' });
  assert.deepEqual(f.calls, [{ op: 'findById', value: alheio._id }]);
  assert.deepEqual(f.writes, []);
});

for (const [method, url, failure, mensagem] of [
  ['POST', '/api/servicos', 'create', 'Erro ao cadastrar servico'],
  ['GET', '/api/servicos/prestador', 'find', 'Erro ao listar servicos'],
  ['DELETE', '/api/servicos/' + ID, 'findById', 'Erro ao deletar servico'],
  ['DELETE', '/api/servicos/' + ID, 'deleteOne', 'Erro ao deletar servico']
]) test(`${method} ${url}: falha ${failure} preserva 500 com detalhe`, async t => {
  const f = await fixture(t, { failure });
  json(await f.request(method, url, f.headers('prestador'), proprio), 500, { mensagem, erro: FALHA });
  assert.equal(f.calls.at(-1).op, failure);
  assert.deepEqual(f.writes, []);
});

test('DELETE sem validacao previa de ID preserva 500 quando o modelo rejeita a consulta', async t => {
  const f = await fixture(t, { failure: 'findById' });
  json(await f.request('DELETE', '/api/servicos/id-invalido', f.headers('prestador')), 500,
    { mensagem: 'Erro ao deletar servico', erro: FALHA });
  assert.deepEqual(f.calls, [{ op: 'findById', value: 'id-invalido' }]);
});
