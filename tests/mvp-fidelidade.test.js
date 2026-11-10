const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../site-iservice-main', name), 'utf8');

test('home substitui reputacao ficticia e seis destaques por catalogo real', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /\+300|4\.9 de avaliação|32 avaliações|Hoje, 09:30|Amanhã, 14:00|pro-card|pro-rating/);
  assert.doesNotMatch(html, /Maria Silva|João Mendes|Carlos Souza|Ana Oliveira|Roberto Silva|Patrícia Lima/);
  assert.doesNotMatch(html, /contratar\.html|href="(?:faxina|jardinagem|Reparos|eletrica|pintura|encanamento)\.html"/);
  assert.ok((html.match(/href="profissionais.html"/g) || []).length >= 8);
  assert.match(html, /window.location.href='profissionais.html'/);
});

test('home e contratar nao coletam endereco nem simulam gravacao local ou sucesso', () => {
  for (const file of ['index.html', 'contratar.html']) {
    const html = read(file);
    assert.doesNotMatch(html, /<form\b|<input\b|<select\b|<textarea\b|localStorage|Solicitação enviada com sucesso|Agendamento realizado com sucesso/);
    assert.match(html, /href="profissionais.html"/);
    assert.match(html, /não (?:registra agendamentos|recebe solicitações)/);
  }
  assert.doesNotMatch(read('script.js'), /localStorage|startAgendamento|msgAgendamento/);
});

test('script legado encaminha CTA ao catalogo sem consultar nem apagar registros antigos', () => {
  const listeners = {};
  const button = { addEventListener(event, fn) { listeners[event] = fn; } };
  const context = { document: {
    addEventListener(event, fn) { if (event === 'DOMContentLoaded') fn(); },
    querySelectorAll() { return []; },
    getElementById(id) { return id === 'btnContratar' ? button : null; }
  }, location: { href: 'index.html' }, addEventListener() {},
  localStorage: new Proxy({}, { get() { throw Error('Acesso indevido a dados antigos'); } }) };
  context.window = context;
  vm.runInNewContext(read('script.js'), context);
  listeners.click();
  assert.equal(context.location.href, 'profissionais.html');
});

function catalog({ authenticated = true, status = 201, network = false, brokenJson = false } = {}) {
  const nodes = new Map(), calls = [], messages = [], success = [], redirects = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; } });
    return nodes.get(id);
  };
  const context = {
    document: { getElementById: node, querySelectorAll() { return []; } },
    IS: { API_URL: '/api', token: 'jwt-sintetico', usuario: { tipo: 'cliente' }, esc: String,
      exigirSessao() { if (!authenticated) redirects.push('login.html'); return authenticated; },
      vazio() { return 'Nenhum profissional encontrado'; },
      msg(el, text, type) { messages.push({ text, type }); }, abrirModal() {}, fecharModal() {},
      toast(text) { success.push(text); } },
    location: { href: '' }, setTimeout(fn) { fn(); }, console: { error() {} },
    async fetch(url, options = {}) {
      calls.push({ url, ...options });
      if (!options.method) return { ok: true, json: async () => [] };
      if (network) throw Error('Falha simulada');
      return { ok: status >= 200 && status < 300, status,
        async json() { if (brokenJson) throw Error('JSON invalido'); return { mensagem: status === 201 ? 'Servico agendado com sucesso' : 'Horario indisponivel' }; } };
    }
  };
  context.window = context;
  for (const [, script] of read('profissionais.html').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (script.trim()) vm.runInNewContext(script, context);
  }
  return { node, context, calls, messages, success, redirects };
}

test('catalogo exige sessao antes de consultar servicos ou permitir contratacao', () => {
  const f = catalog({ authenticated: false });
  assert.deepEqual(f.redirects, ['login.html']);
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.contratar, undefined);
});

for (const [label, options, succeeds] of [
  ['sucesso confirmado', {}, true], ['erro HTTP', { status: 400 }, false],
  ['falha de rede', { network: true }, false], ['resposta invalida', { brokenJson: true }, false]
]) {
  test('catalogo real: ' + label + ', sem falso sucesso ou repeticao automatica', async () => {
    const f = catalog(options);
    await new Promise(resolve => setImmediate(resolve));
    f.context.contratar('servico-real-selecionado');
    f.node('contratarData').value = '2035-05-20';
    f.node('contratarHora').value = '14:00';
    await f.node('btnConfirmarContratar').listeners.click();
    const posts = f.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/api/agendamentos');
    assert.equal(posts[0].headers.Authorization, 'Bearer jwt-sintetico');
    assert.deepEqual(JSON.parse(posts[0].body), { servico_id: 'servico-real-selecionado', data: '2035-05-20', hora: '14:00' });
    assert.equal(f.success.length, succeeds ? 1 : 0);
    assert.equal(f.context.location.href, succeeds ? 'dashboard-cliente.html' : '');
    if (!succeeds) assert.ok(f.messages.some(m => m.type === 'error'));
  });
}

test('catalogo real exige data e horario antes de enviar a API', async () => {
  const f = catalog();
  f.context.contratar('servico');
  await f.node('btnConfirmarContratar').listeners.click();
  assert.equal(f.calls.filter(c => c.method).length, 0);
  assert.equal(f.success.length, 0);
  assert.ok(f.messages.some(m => m.type === 'error'));
});
