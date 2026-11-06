const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const ID = 'a'.repeat(24);
const secret = 'chave-exclusivamente-ficticia-auth-http';
const input = { nome: 'Pessoa ficticia', email: 'fixture@example.invalid', senha: 'senha-ficticia',
  tipo: 'cliente', telefone: '000000000' };
const plain = value => JSON.parse(JSON.stringify(value));
const publicUser = tipo => ({ id: ID, nome: input.nome, email: input.email, tipo });
const now = Date.parse('2026-01-01T12:00:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }

async function fixture(t, { tipo = 'cliente', duplicate = false, missing = false,
  passwordValid = true, failure } = {}) {
  const calls = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error('detalhe-interno-sintetico');
  }
  const user = { ...input, _id: ID, tipo, campo_privado: 'nao-expor',
    async compararSenha(password) { record('compare', password); return passwordValid; },
    async save() { record('save', this.ultimo_login); }
  };
  const controllers = controllerStubs(dispatches);
  controllers.CadastroController = loadController('controllers/CadastroController.js', {
    '../Models/usuarioModel': {
      async findOne(query) { record('cadastro.findOne', query); return duplicate ? user : null; },
      async create(data) { record('create', data); return { ...user, ...data }; }
    }
  }, { secret });
  controllers.LoginController = loadController('controllers/LoginController.js', {
    '../Models/usuarioModel': {
      async findOne(query) { record('login.findOne', query); return missing ? null : user; }
    },
    jsonwebtoken: { sign(payload, key, options) {
      record('sign', { payload, options });
      assert.equal(key, secret);
      return jwt.sign(payload, key, options);
    } }
  }, { secret, clock: Clock });
  return { ...await startHttp(t, { controllers, secret, usuarioId: ID }), calls, dispatches, user };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  const parsed = JSON.parse(res.text);
  if (body !== undefined) assert.deepEqual(parsed, body);
  return parsed;
}

for (const tipo of ['cliente', 'prestador']) {
  for (const invalidToken of [false, true]) {
    test(`cadastro HTTP publico de ${tipo}, token invalido=${invalidToken}`, async t => {
      const f = await fixture(t);
      const data = { ...input, tipo };
      json(await f.request('POST', '/api/cadastro', invalidToken ? { Authorization: 'Bearer invalido' } : {},
        { ...data, _id: 'b'.repeat(24), campo_extra: 'ignorado' }), 201,
      { mensagem: 'Usuario cadastrado com sucesso', usuario: publicUser(tipo) });
      assert.deepEqual(f.calls, [{ op: 'cadastro.findOne', value: { email: input.email } },
        { op: 'create', value: data }]);
      assert.deepEqual(f.dispatches, []);
    });

    test(`login HTTP publico de ${tipo}, token invalido=${invalidToken}`, async t => {
      const f = await fixture(t, { tipo });
      const body = json(await f.request('POST', '/api/login', invalidToken ? { Authorization: 'Bearer invalido' } : {},
        { email: input.email, senha: input.senha, tipo: 'forjado', id: 'b'.repeat(24) }), 200);
      assert.deepEqual(Object.keys(body).sort(), ['mensagem', 'token', 'usuario']);
      assert.equal(body.mensagem, 'Login realizado com sucesso');
      assert.deepEqual(body.usuario, publicUser(tipo));
      const claims = jwt.verify(body.token, secret, { algorithms: ['HS256'] });
      assert.deepEqual(Object.keys(claims).sort(), ['email', 'exp', 'iat', 'id', 'tipo']);
      assert.equal(claims.id, ID);
      assert.equal(claims.email, input.email);
      assert.equal(claims.tipo, tipo);
      assert.equal(claims.exp - claims.iat, 7 * 24 * 60 * 60);
      assert.deepEqual(f.calls, [
        { op: 'login.findOne', value: { email: input.email } },
        { op: 'compare', value: input.senha }, { op: 'save', value: new Date(now).toISOString() },
        { op: 'sign', value: { payload: { id: ID, email: input.email, tipo }, options: { expiresIn: '7d' } } }
      ]);
      assert.deepEqual(f.dispatches, []);
    });
  }
}

test('cadastro duplicado retorna 400 e nao tenta criar usuario', async t => {
  const f = await fixture(t, { duplicate: true });
  json(await f.request('POST', '/api/cadastro', {}, input), 400, { mensagem: 'Email ja cadastrado' });
  assert.deepEqual(f.calls, [{ op: 'cadastro.findOne', value: { email: input.email } }]);
});

test('login exige email e senha antes de consultar o modelo', async t => {
  const f = await fixture(t);
  for (const body of [{}, { email: input.email }, { senha: input.senha }, { email: '', senha: input.senha }]) {
    json(await f.request('POST', '/api/login', {}, body), 400, { mensagem: 'Email e senha sao obrigatorios' });
  }
  assert.deepEqual(f.calls, []);
});

for (const missing of [false, true]) test(`login nega credenciais: usuario ausente=${missing}`, async t => {
  const f = await fixture(t, { missing, passwordValid: false });
  json(await f.request('POST', '/api/login', {}, input), 401, { mensagem: 'Email ou senha invalidos' });
  assert.deepEqual(f.calls.map(call => call.op), missing ? ['login.findOne'] : ['login.findOne', 'compare']);
});

for (const [url, failure, mensagem] of [
  ['cadastro', 'cadastro.findOne', 'Erro ao cadastrar usuario'],
  ['cadastro', 'create', 'Erro ao cadastrar usuario'],
  ['login', 'login.findOne', 'Erro interno do servidor'],
  ['login', 'compare', 'Erro interno do servidor'],
  ['login', 'save', 'Erro interno do servidor'],
  ['login', 'sign', 'Erro interno do servidor']
]) test(`${url} HTTP sanitiza falha de ${failure}`, async t => {
  const f = await fixture(t, { failure });
  json(await f.request('POST', '/api/' + url, {}, input), 500, { mensagem });
  assert.equal(f.calls.at(-1).op, failure);
});

test('cadastro delega validacao de campos ao modelo e preserva seu erro 500', async t => {
  const f = await fixture(t, { failure: 'create' });
  json(await f.request('POST', '/api/cadastro', {}, {}), 500, { mensagem: 'Erro ao cadastrar usuario' });
  assert.deepEqual(f.calls, [{ op: 'cadastro.findOne', value: {} }, { op: 'create', value: {} }]);
});

test('auth preserva barra final, OPTIONS e rejeicao de caminhos e metodos alternativos', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/cadastro/', {}, input)).status, 201);
  assert.equal((await f.request('POST', '/api/login/', {}, input)).status, 200);
  const before = plain(f.calls);
  for (const url of ['/api/cadastro', '/api/login']) {
    assert.equal((await f.request('OPTIONS', url)).status, 204);
    for (const method of ['GET', 'HEAD', 'PUT']) assert.equal((await f.request(method, url)).status, 404);
    assert.equal((await f.request('POST', url + '/extra', {}, input)).status, 404);
  }
  assert.deepEqual(f.calls, before);
  assert.deepEqual(f.dispatches, []);
});
