const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

// Executa os controllers reais com banco e JWT simulados, sem rede ou .env.
function controller(file, dependencies) {
  const logs = [];
  const context = {
    exports: {},
    process: { env: { JWT_SECRET: 'segredo-exclusivo-do-teste' } },
    console: Object.fromEntries(['log', 'error', 'warn'].map(method => [method, (...args) => logs.push(args)])),
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Dependencia inesperada: ${name}`);
      return dependencies[name];
    }
  };
  vm.runInNewContext(read(`controllers/${file}`), context, { filename: file });
  return { handlers: context.exports, logs };
}

async function invoke(handler, body, extra = {}) {
  const response = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(value) { this.body = plain(value); return this; }
  };
  await handler({ body, ...extra }, response);
  return response;
}

for (const tipo of ['cliente', 'prestador']) {
  test(`cadastro de ${tipo} preserva entrada e resposta sem senha`, async () => {
    const input = { nome: 'Teste', email: 'teste@example.invalid', senha: 'senha-ficticia', tipo, telefone: '000000000' };
    const { handlers, logs } = controller('CadastroController.js', {
      '../Models/usuarioModel': {
        async findOne(query) { assert.deepEqual(plain(query), { email: input.email }); return null; },
        async create(data) { assert.deepEqual(plain(data), input); return { ...data, _id: 'usuario-teste' }; }
      }
    });
    const result = await invoke(handlers.cadastrar, input);
    assert.equal(result.code, 201);
    assert.deepEqual(result.body.usuario, { id: 'usuario-teste', nome: input.nome, email: input.email, tipo });
    assert.deepEqual(logs, []);
  });
}

test('cadastro duplicado preserva erro compreensivel', async () => {
  const { handlers } = controller('CadastroController.js', {
    '../Models/usuarioModel': { async findOne() { return {}; } }
  });
  const result = await invoke(handlers.cadastrar, { email: 'teste@example.invalid' });
  assert.equal(result.code, 400);
  assert.equal(result.body.mensagem, 'Email ja cadastrado');
});

test('login valido compara senha, atualiza acesso e solicita JWT de sete dias', async () => {
  let saved = false;
  const user = {
    _id: 'usuario-teste', nome: 'Teste', email: 'teste@example.invalid', tipo: 'cliente',
    async compararSenha(password) { assert.equal(password, 'senha-ficticia'); return true; },
    async save() { saved = true; }
  };
  const { handlers, logs } = controller('LoginController.js', {
    '../Models/usuarioModel': { async findOne(query) { assert.equal(query.email, user.email); return user; } },
    jsonwebtoken: { sign(payload, secret, options) {
      assert.deepEqual(plain(payload), { id: user._id, email: user.email, tipo: user.tipo });
      assert.equal(secret, 'segredo-exclusivo-do-teste');
      assert.equal(options.expiresIn, '7d');
      return 'token-ficticio';
    } }
  });
  const result = await invoke(handlers.login, { email: user.email, senha: 'senha-ficticia' });
  assert.equal(result.code, 200);
  assert.equal(result.body.token, 'token-ficticio');
  assert.deepEqual(result.body.usuario, { id: user._id, nome: user.nome, email: user.email, tipo: user.tipo });
  assert.ok(saved && user.ultimo_login);
  assert.deepEqual(logs, []);
});

for (const scenario of ['campos ausentes', 'usuario inexistente', 'senha incorreta']) {
  test(`login: ${scenario}`, async () => {
    const { handlers, logs } = controller('LoginController.js', {
      '../Models/usuarioModel': { async findOne() {
        assert.notEqual(scenario, 'campos ausentes');
        return scenario === 'usuario inexistente' ? null : { async compararSenha() { return false; } };
      } },
      jsonwebtoken: { sign() { assert.fail('Nao deve gerar token'); } }
    });
    const result = await invoke(handlers.login, scenario === 'campos ausentes' ? {} : { email: 'teste@example.invalid', senha: 'senha-ficticia' });
    assert.equal(result.code, scenario === 'campos ausentes' ? 400 : 401);
    assert.deepEqual(logs, []);
  });
}

for (const [file, handler, model, operation] of [
  ['CadastroController.js', 'cadastrar', '../Models/usuarioModel', 'cadastro'],
  ['LoginController.js', 'login', '../Models/usuarioModel', 'login'],
  ['chatController.js', 'sendMessage', '../Models/chatModel', 'chat']
]) {
  test(`${operation}: falhas nao vazam entrada, mensagem de erro ou stack`, async () => {
    const fail = async () => { throw new Error('DADO-SENSIVEL-FICTICIO'); };
    const { handlers, logs } = controller(file, { [model]: { findOne: fail, findById: fail }, jsonwebtoken: {} });
    const result = await invoke(handlers[handler], {
      email: 'teste@example.invalid', senha: 'senha-ficticia', chat_id: 'chat-teste', content: 'mensagem-privada-ficticia'
    }, { usuarioId: 'remetente-teste' });
    assert.equal(result.code, 500);
    assert.deepEqual(Object.keys(result.body), ['mensagem']);
    assert.deepEqual(logs, [[`Falha interna na operacao de ${operation}`]]);
    assert.doesNotMatch(JSON.stringify(result.body), /DADO-SENSIVEL|senha-ficticia|mensagem-privada-ficticia/);
  });
}

test('chat preserva envio autorizado e impede envio de nao participante', async () => {
  let saved = false;
  const chat = { participants: ['cliente-teste', 'prestador-teste'], messages: [], async save() { saved = true; } };
  const { handlers, logs } = controller('chatController.js', { '../Models/chatModel': { async findById() { return chat; } } });
  const input = { chat_id: 'chat-teste', content: 'mensagem-ficticia' };
  const denied = await invoke(handlers.sendMessage, input, { usuarioId: 'outro-teste' });
  assert.equal(denied.code, 403);
  assert.equal(saved, false);
  const sent = await invoke(handlers.sendMessage, input, { usuarioId: 'cliente-teste' });
  assert.equal(sent.code, 201);
  assert.deepEqual(sent.body.message, { sender: 'cliente-teste', receiver: 'prestador-teste', content: input.content, read: false });
  assert.equal(saved, true);
  assert.deepEqual(logs, []);
});

// Executa os scripts reais dos formularios com DOM, fetch e storage simulados.
for (const page of ['login', 'cadastro']) {
  for (const outcome of ['sucesso', 'erro HTTP', 'falha de rede']) {
    test(`formulario ${page}: ${outcome}`, async () => {
      let submit;
      let request;
      let message;
      const button = { disabled: false };
      const storage = new Map();
      const values = { nome: 'Teste', email: 'teste@example.invalid', registerEmail: 'teste@example.invalid', senha: 'senha-ficticia', registerSenha: 'senha-ficticia', telefone: '000000000' };
      const form = { addEventListener(event, callback) { submit = callback; }, querySelector() { return button; } };
      const context = {
        IS: { API_URL: '/api', msg(element, text) { message = text; } },
        document: {
          getElementById(id) { return /Form$/.test(id) ? form : { value: values[id] }; },
          querySelectorAll() { return []; },
          querySelector() { return { dataset: { tipo: 'cliente' } }; }
        },
        localStorage: { setItem(key, value) { storage.set(key, value); } },
        window: { location: { href: '' } },
        setTimeout(callback) { callback(); },
        async fetch(url, options) {
          request = { url, options: plain(options) };
          if (outcome === 'falha de rede') throw new Error('rede simulada');
          return { ok: outcome === 'sucesso', async json() {
            return outcome === 'sucesso' ? { token: 'token-ficticio', usuario: { id: 'usuario-teste', tipo: 'cliente' } } : { mensagem: 'Falha compreensivel' };
          } };
        }
      };
      const html = read(`site-iservice-main/${page}.html`);
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) vm.runInNewContext(match[1], context);
      }
      await submit.call(form, { preventDefault() {} });
      assert.equal(request.url, `/api/${page}`);
      assert.equal(request.options.method, 'POST');
      assert.equal(request.options.headers['Content-Type'], 'application/json');
      const expected = { email: values.email, senha: values.senha };
      if (page === 'cadastro') Object.assign(expected, { nome: values.nome, telefone: values.telefone, tipo: 'cliente' });
      assert.deepEqual(JSON.parse(request.options.body), expected);
      if (outcome === 'sucesso') {
        assert.equal(context.window.location.href, page === 'login' ? 'dashboard-cliente.html' : 'login.html');
        if (page === 'login') assert.equal(storage.get('token'), 'token-ficticio');
        assert.ok([...storage.values()].every(value => !value.includes('senha-ficticia')));
      } else {
        assert.equal(button.disabled, false);
        assert.equal(storage.size, 0);
        assert.equal(context.window.location.href, '');
        assert.equal(message, outcome === 'erro HTTP' ? 'Falha compreensivel' : 'Erro ao conectar com o servidor');
      }
    });
  }
}
