const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { criarContratacaoLocalApp } = require('./helpers/contratacaoLocalApp');
const root = path.resolve(__dirname, '..'), script = path.join(root, 'scripts/demoContratacaoLocal.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function terminal() {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', data => { text += data; });
  return { input, output, get text() { return text; },
    wait(pattern) {
      if (pattern.test(text)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { output.off('data', read); reject(Error('Terminal nao atingiu ' + pattern + ': ' + text)); }, 15000);
        function read() { if (pattern.test(text)) { clearTimeout(timer); output.off('data', read); resolve(text); } }
        output.on('data', read);
      });
    } };
}
function loadLauncher(create) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { module, exports: module.exports, process, console,
    require(name) {
      if (name === 'node:readline') return require(name);
      assert.equal(name, '../tests/helpers/contratacaoLocalApp');
      return { criarContratacaoLocalApp: create };
    }
  }, { filename: script });
  return module.exports.iniciarDemo;
}
async function removed(local) {
  assert.equal(local.escutando, false); assert.equal(local.connection.readyState, 0);
  assert.equal(fs.existsSync(local.replica.directory), false);
  assert.throws(() => process.kill(local.replica.pid, 0));
}
function rawGet(url, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: new URL(url).port, path: pathname, agent: false }, res => {
      const chunks = []; const address = res.socket.remoteAddress;
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), address, headers: res.headers }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('Timeout HTTP local')));
  });
}

test('launcher CLI real: estaticos restritos, jornada autenticada, comando aceitar e sair', { timeout: 90000 }, async t => {
  const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const term = terminal(); child.stdout.on('data', data => term.output.write(data)); child.stderr.on('data', data => term.output.write(data));
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null) child.stdin.end('sair\n'); await exited; });
  await term.wait(/Fase: PREPARACAO/);
  const url = /URL: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(term.text)[1];
  const info = JSON.parse(/Recursos exclusivos: (.+)/.exec(term.text)[1]);
  assert.notEqual(info.port, 27017); assert.ok(info.pid > 0); assert.ok(fs.existsSync(info.directory));
  assert.match(info.databaseName, /^iservice_tx_[a-f0-9]{32}$/);
  assert.ok(term.text.indexOf('indices I1-I5 verificados') < term.text.indexOf('URL:'));
  for (const file of ['index.html', 'login.html', 'cadastro.html', 'dashboard-cliente.html', 'dashboard-prestador.html', 'home.css', 'app.css', 'app.js', 'logo-mark.png']) {
    await t.test('frontend real servido: ' + file, async () => {
      const res = await rawGet(url, '/' + file); assert.equal(res.status, 200); assert.equal(res.address, '127.0.0.1');
      if (!file.endsWith('.png')) assert.equal(res.text, fs.readFileSync(path.join(root, 'site-iservice-main', file), 'utf8'));
    });
  }
  await t.test('raiz publica e arquivos privados/traversal inacessiveis', async () => {
    assert.equal((await rawGet(url, '/')).text, fs.readFileSync(path.join(root, 'site-iservice-main/index.html'), 'utf8'));
    for (const pathname of ['/.env', '/%2eenv', '/server.js', '/controllers/pedidoController.js', '/tests/helpers/httpApp.js',
      '/.git/config', '/Backup_iService_Pre_MVC/', '/README.md', '/workspace.code-workspace', '/..%2fserver.js',
      '/%2e%2e/server.js', '/%2e%2e%5cserver.js', '/scripts/demoContratacaoLocal.js', '/site-iservice-main/']) {
      assert.equal((await rawGet(url, pathname)).status, 404, pathname);
    }
  });
  const request = async (method, endpoint, token, body) => {
    const res = await fetch(url + 'api/' + endpoint, { method, headers: { Connection: 'close', 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text() };
  };
  const actors = {};
  let pedido, proposta;
  await t.test('mesma origem usa cadastro/login/servico/pedido/proposta reais em preparacao', async () => {
    for (const tipo of ['cliente', 'prestador']) {
      const body = { nome: 'Demo ' + tipo, email: tipo + '@example.invalid', senha: 'Senha-ficticia-123!', telefone: '00000000000', tipo };
      assert.equal((await request('POST', 'cadastro', null, body)).status, 201);
      const login = await request('POST', 'login', null, { email: body.email, senha: body.senha }); assert.equal(login.status, 200);
      actors[tipo] = login.body.token;
    }
    assert.equal((await request('POST', 'servicos', actors.prestador, { nome: 'Faxina ficticia', descricao: 'Ensaio', categoria: 'faxina', preco: 100 })).status, 201);
    const p = await request('POST', 'pedidos', actors.cliente, { titulo: 'Faxina de ensaio', descricao: 'Ficticio', categoria: 'faxina', data_desejada: '2035-05-20' });
    assert.equal(p.status, 201); pedido = p.body.pedido; assert.equal(pedido.fluxo_contratacao, 1);
    const offer = await request('POST', 'propostas', actors.prestador, { pedido_id: pedido._id, valor: 100, prazo: 'Dois dias' });
    assert.equal(offer.status, 201); proposta = offer.body.proposta;
    assert.equal((await request('PUT', `propostas/${proposta._id}/aceitar`, actors.cliente)).status, 409);
  });
  await t.test('fase e controlada somente pelo terminal, sem habilitar dominios fora do escopo', async () => {
    for (const endpoint of ['aceitar', 'iniciar-aceitacao', 'preparacao', 'chat', 'favoritos', 'avaliacoes/cliente']) {
      assert.equal((await request('POST', endpoint, actors.cliente, {})).status, 404);
    }
    child.stdin.write('estado\naceitar\n'); await term.wait(/Fase: ACEITACAO/);
    assert.ok(term.text.indexOf('Fase: DRENANDO') < term.text.indexOf('Fase: ACEITACAO'));
    assert.equal((await request('POST', 'login', null, { email: 'cliente@example.invalid', senha: 'Senha-ficticia-123!' })).status, 409);
    assert.equal((await request('POST', 'servicos', actors.prestador, {})).status, 409);
  });
  await t.test('aceitacao/replay e GETs reais mantem unica agenda e notificacao', async () => {
    const result = await request('PUT', `propostas/${proposta._id}/aceitar`, actors.cliente); assert.equal(result.status, 200);
    assert.equal(result.body.mensagem, 'Proposta aceita com sucesso');
    const replay = await request('PUT', `propostas/${proposta._id}/aceitar`, actors.cliente); assert.equal(replay.status, 200);
    assert.equal(replay.body.mensagem, 'Contratacao existente recuperada com sucesso');
    assert.equal(replay.body.agendamento._id, result.body.agendamento._id);
    const agendas = await request('GET', 'agendamentos/cliente', actors.cliente); assert.equal(agendas.body.length, 1);
    assert.equal(agendas.body[0].servico_id.nome, 'Faxina ficticia'); assert.equal(agendas.body[0].prestador_id.nome, 'Demo prestador');
    const notas = await request('GET', 'notificacoes', actors.prestador); assert.equal(notas.body.length, 1);
    assert.equal(notas.body[0].tipo, 'proposta_aceita');
  });
  await t.test('sair fecha HTTP e remove somente diretorio/processo proprios', async () => {
    child.stdin.write('sair\nsair\n'); const exit = await exited;
    assert.equal(exit.code, 0); assert.equal(fs.existsSync(info.directory), false);
    assert.throws(() => process.kill(info.pid, 0));
    await assert.rejects(rawGet(url, '/'));
    assert.equal((term.text.match(/Encerrado\. HTTP/g) || []).length, 1);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`terminal ${signal} e repeticao encerram uma unica instancia propria`, { timeout: 30000 }, async () => {
  const term = terminal(), signals = new EventEmitter(); let local, calls = 0;
  const start = loadLauncher(async options => {
    local = await criarContratacaoLocalApp(options);
    const close = local.encerrar; local.encerrar = () => { calls++; return close(); }; return local;
  });
  const demo = await start({ entrada: term.input, saida: term.output, sinais: signals });
  try {
    signals.emit(signal); signals.emit(signal); await demo.concluido; await demo.encerrar();
    assert.equal(calls, 1);
  }
  finally { await local.encerrar(); }
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  await removed(local);
});
test('falha real de prontidao na inicializacao nao abre HTTP e limpa recursos', { timeout: 30000 }, async () => {
  const term = terminal(), signals = new EventEmitter(); let local;
  const start = loadLauncher(async options => {
    local = await criarContratacaoLocalApp(options);
    local.models.Agendamento.collection.indexes = async () => [];
    return local;
  });
  await assert.rejects(start({ entrada: term.input, saida: term.output, sinais: signals }), /Indice I1 invalido/);
  assert.doesNotMatch(term.text, /URL:/); await removed(local);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
test('terminal drena cadastro real pendente, rejeita nova admissao e permite sair durante drenagem', { timeout: 30000 }, async () => {
  const term = terminal(), signals = new EventEmitter(), entered = deferred(), release = deferred(); let local;
  const start = loadLauncher(async options => { local = await criarContratacaoLocalApp(options); return local; });
  const demo = await start({ entrada: term.input, saida: term.output, sinais: signals });
  const original = local.models.Usuario.create;
  local.models.Usuario.create = async function (...args) { const result = await original.apply(this, args); entered.resolve(); await release.promise; return result; };
  let pending;
  try {
    pending = local.request('POST', '/api/cadastro', null, { nome: 'Pendente ficticio', email: 'pendente@example.invalid', senha: 'Ficticia-123!', telefone: '00000000000', tipo: 'cliente' });
    await entered.promise; term.input.write('aceitar\n'); await term.wait(/DRENANDO/);
    assert.equal(local.fase, 'DRENANDO'); assert.equal(local.preparacoesAtivas, 1);
    assert.equal((await local.request('POST', '/api/cadastro', null, {})).status, 409);
    term.input.write('sair\n'); await term.wait(/Encerrando:/);
    assert.doesNotMatch(term.text, /Fase: ACEITACAO/);
  } finally {
    release.resolve(); local.models.Usuario.create = original;
    if (pending) assert.equal((await pending).status, 201);
    await demo.encerrar();
  }
  await removed(local); assert.doesNotMatch(term.text, /Fase: ACEITACAO/);
});
test('falha na transicao permanece fechada e modo padrao nao serve frontend', { timeout: 30000 }, async () => {
  const local = await criarContratacaoLocalApp();
  try {
    await local.iniciarHttp(); assert.equal((await rawGet(local.url, '/')).status, 404);
    const original = local.models.Pedido.collection.indexes;
    local.models.Pedido.collection.indexes = async () => [];
    await assert.rejects(local.iniciarAceitacao(), /Indice I3 invalido/);
    assert.equal(local.fase, 'DRENANDO');
    assert.equal((await local.request('POST', '/api/cadastro', null, {})).status, 409);
    local.models.Pedido.collection.indexes = original;
  } finally { await local.encerrar(); }
  await removed(local);
});
