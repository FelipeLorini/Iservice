const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'site-iservice-main');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pages = fs.readdirSync(root).filter(file => file.endsWith('.html'));
const protectedPages = ['chat.html', 'dashboard-cliente.html', 'dashboard-prestador.html',
  'faxina.html', 'perfil_cliente.html', 'perfil_prestador.html', 'profissionais.html'];
const now = Date.now();
const user = tipo => ({ id: tipo === 'prestador' ? '2'.repeat(24) : '1'.repeat(24), nome: 'Pessoa', tipo });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
// JWT propositalmente sem assinatura válida: o frontend só lê metadados.
const token = (tipo = 'cliente', payload = {}, header = {}) =>
  `${encode({ alg: 'HS256', typ: 'JWT', ...header })}.${encode({ ...user(tipo), exp: Math.floor(now / 1000) + 3600, ...payload })}.assinatura`;
function storage(tipo = 'cliente') {
  return new Map([['token', token(tipo)], ['usuario', JSON.stringify(user(tipo))]]);
}

// DOM mínimo construído a partir do HTML real, sem dependências ou acesso à rede.
class Element {
  constructor(tag, attrs = {}, parent = null) {
    this.tag = tag; this.attrs = attrs; this.parent = parent; this.children = [];
    this.listeners = {}; this.value = ''; this.innerHTML = ''; this.textContent = '';
    this.offsetTop = 0; this.offsetHeight = 100;
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); return force; }
    };
  }
  get id() { return this.attrs.id; }
  set id(value) { this.attrs.id = value; }
  get dataset() {
    return Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  }
  get innerHTML() { return this.html || ''; }
  set innerHTML(value) {
    this.html = value;
    this.children = value ? dom(value).children : [];
    for (const child of this.children) child.parent = this;
  }
  get href() { return this.attrs.href; }
  set href(value) { this.attrs.href = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) {
    const e = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...event };
    for (const fn of this.listeners[name] || []) fn(e);
    return e;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  click() { this.emit('click'); }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrolled = options; }
  matches(selector) {
    const parts = selector.trim().split(/\s+/); const last = parts.pop();
    const attrs = [...last.matchAll(/\[([^=\]^]+)(\^?=)?(?:"([^"]*)")?\]/g)];
    const simple = last.replace(/\[[^\]]*\]/g, '');
    const tag = simple.match(/^[a-z]+/i)?.[0];
    if (tag && tag !== this.tag) return false;
    const id = simple.match(/#([\w-]+)/)?.[1];
    if (id && id !== this.id) return false;
    if ([...simple.matchAll(/\.([\w-]+)/g)].some(m => !this.classList.contains(m[1]))) return false;
    if (attrs.some(([, key, op, value]) => !Object.hasOwn(this.attrs, key) ||
      (op === '=' && this.attrs[key] !== value) || (op === '^=' && !this.attrs[key].startsWith(value)))) return false;
    if (!parts.length) return true;
    for (let p = this.parent; p; p = p.parent) if (p.matches(parts.join(' '))) return true;
    return false;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (selector.split(',').some(s => child.matches(s))) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function dom(html) {
  const doc = new Element('document'); const stack = [doc];
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of clean.matchAll(/<(\/)?([a-z][\w-]*)\b([^>]*?)>/gi)) {
    const [, closing, tag, attributes] = match;
    if (closing) { while (stack.length > 1 && stack.pop().tag !== tag) {} continue; }
    const attrs = Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] || '']));
    const el = new Element(tag, attrs, stack.at(-1)); stack.at(-1).children.push(el);
    if (!['meta', 'link', 'img', 'input', 'br', 'hr', 'source'].includes(tag)) stack.push(el);
  }
  doc.documentElement = doc.querySelector('html'); doc.body = doc.querySelector('body');
  doc.getElementById = id => doc.querySelector('#' + id);
  return doc;
}
function page(file = 'index.html', options = {}) {
  const html = read(file); const document = dom(html); const data = options.storage || new Map();
  const events = {}; const requests = []; const redirects = []; const timers = new Map(); const intervals = [];
  let clock = now; let timerId = 0; let reloads = 0;
  const url = new URL(file, 'https://iservice.test/');
  const location = { href: url.href, pathname: url.pathname, origin: url.origin,
    replace(value) { redirects.push(value); }, reload() { reloads++; } };
  const context = vm.createContext({
    document, location, URL, URLSearchParams, Headers, Request, Response,
    setInterval(fn, ms) { intervals.push({ fn, ms }); }, console: { error() {} },
    Date: class extends Date { static now() { return clock; } },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    localStorage: {
      getItem(key) { if (options.blockedStorage) throw Error('Storage bloqueado'); return data.get(key) ?? null; },
      removeItem(key) { if (options.blockedStorage) throw Error('Storage bloqueado'); data.delete(key); },
      setItem(key, value) { data.set(key, value); }
    },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { (events[name] ||= []).push(fn); },
    scrollY: 0,
    async fetch(...args) { requests.push(args); return options.fetch ? options.fetch(...args) : new Response('{}'); }
  });
  context.window = context;
  const run = source => vm.runInContext(source, context);
  run(read('app.js'));
  if (file === 'index.html') {
    run(read('script.js'));
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) run(m[1]);
  }
  // Os testes de navegação isolam o cabeçalho; os de integração abaixo carregam
  // também o script real de notificações, antes do mesmo DOMContentLoaded.
  if (options.notifications) {
    assert.equal([...html.matchAll(/<script src="notificacoes.js"><\/script>/g)].length, 1);
    run(read('notificacoes.js'));
  }
  document.emit('DOMContentLoaded');
  function visible(el) {
    for (let p = el; p; p = p.parent) {
      if (p.attrs['data-auth'] === 'in' && !context.IS.logado) return false;
      if (p.attrs['data-auth'] === 'out' && context.IS.logado) return false;
    }
    return true;
  }
  return { context, document, data, requests, redirects, timers, intervals, run, visible,
    get reloads() { return reloads; }, setTime(value) { clock = value; },
    event(name, event = {}) { for (const fn of events[name] || []) fn(event); },
    links: () => document.querySelectorAll('header a').filter(visible),
    inline() { for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) run(m[1]); }
  };
}

test('home visitante: login/cadastro visíveis, painel/perfil/sair ocultos, nenhuma requisição extra', () => {
  const p = page(); const hrefs = p.links().map(a => a.href);
  assert.ok(hrefs.includes('login.html') && hrefs.includes('cadastro.html'));
  assert.ok(!hrefs.some(h => /dashboard|perfil/.test(h)));
  assert.equal(p.visible(p.document.querySelector('[data-logout]')), false);
  assert.equal(p.requests.length, 0);
  assert.ok(p.document.documentElement.classList.contains('is-guest'));
});

for (const tipo of ['cliente', 'prestador']) {
  test(`home ${tipo}: destinos e visibilidade do cabeçalho/rodapé`, () => {
    const p = page('index.html', { storage: storage(tipo) });
    for (const a of p.document.querySelectorAll('[data-link="dashboard"]')) {
      assert.equal(a.href, `dashboard-${tipo}.html`); assert.ok(p.visible(a));
    }
    for (const a of p.document.querySelectorAll('[data-link="perfil"]')) assert.equal(a.href, `perfil_${tipo}.html`);
    assert.ok(p.visible(p.document.querySelector('[data-logout]')));
    assert.ok(!p.links().some(a => a.href === 'cadastro.html' || (a.href === 'login.html' && !Object.hasOwn(a.attrs, 'data-logout'))));
    assert.equal(p.requests.length, 0);
  });
  test(`jornada ${tipo}: Início → Profissionais → Perfil → Dashboard → Início`, () => {
    const data = storage(tipo); let p = page('index.html', { storage: data });
    const files = ['profissionais.html', `perfil_${tipo}.html`, `dashboard-${tipo}.html`, 'index.html'];
    for (const file of files) {
      assert.ok(p.links().some(a => a.href === file), `Link ausente: ${file}`);
      p = page(file, { storage: data });
      assert.ok(p.context.IS.logado);
      if (file !== 'index.html') assert.ok(p.document.querySelector(`.menu a[href="${file}"]`).classList.contains('active'));
    }
    assert.equal(data.get('token'), token(tipo));
  });
}

test('logout limpa apenas sessão, muda o menu imediatamente e persiste após atualizar', () => {
  const data = storage(); data.set('preferencia', 'preservada');
  const p = page('index.html', { storage: data });
  p.document.querySelector('[data-logout]').emit('click');
  assert.equal(p.context.IS.logado, false); assert.equal(p.context.IS.usuario, null);
  assert.equal(data.get('preferencia'), 'preservada'); assert.equal(data.has('token'), false);
  assert.deepEqual(p.redirects, ['login.html']); assert.equal(p.timers.size, 0);
  assert.equal(page('index.html', { storage: data }).context.IS.logado, false);
});

const invalid = [
  ['ausente', new Map()],
  ['sem usuário', new Map([['token', token()]])],
  ['sem token', new Map([['usuario', JSON.stringify(user('cliente'))]])],
  ['JSON corrompido', new Map([['token', token()], ['usuario', '{']])],
  ['usuário nulo', new Map([['token', token()], ['usuario', 'null']])],
  ['usuário array', new Map([['token', token()], ['usuario', '[]']])],
  ['token malformado', new Map([['token', 'qualquer-token'], ['usuario', JSON.stringify(user('cliente'))]])],
  ['payload corrompido', new Map([['token', 'e30.e30.a'], ['usuario', JSON.stringify(user('cliente'))]])],
  ...[
    ['expirada', { exp: now / 1000 - 1 }], ['sem expiração', { exp: undefined }],
    ['expiração string', { exp: '9999999999' }], ['outro usuário', { id: 'outro' }],
    ['outro papel', { tipo: 'prestador' }], ['ainda não válida', { nbf: now / 1000 + 30 }]
  ].map(([label, claims]) => [label, new Map([['token', token('cliente', claims)], ['usuario', JSON.stringify(user('cliente'))]])])
];
for (const [label, data] of invalid) {
  test(`sessão ${label}: visitante sem exceção`, () => {
    const p = page('index.html', { storage: new Map(data) });
    assert.equal(p.context.IS.logado, false); assert.equal(p.data.has('token'), false);
    assert.equal(p.requests.length, 0);
  });
}
test('storage indisponível não interrompe cabeçalho ou notificações', () => {
  const p = page('index.html', { blockedStorage: true });
  p.run(read('notificacoes.js')); assert.equal(p.context.IS.logado, false);
});

for (const file of protectedPages) {
  test(`${file}: sessão corrompida interrompe script antes de inicializar funcionalidades`, () => {
    const p = page(file, { storage: new Map([['token', token()], ['usuario', '{']]) });
    p.inline(); p.run(read('notificacoes.js'));
    assert.deepEqual(p.redirects, ['login.html']); assert.equal(p.requests.length, 0);
  });
  test(`${file}: sessão aceita preserva handlers globais usados pelos botões`, () => {
    const tipo = file.includes('prestador') ? 'prestador' : 'cliente';
    // Mantém as respostas pendentes para testar a inicialização sem simular dados de negócio.
    const p = page(file, { storage: storage(tipo), fetch: () => new Promise(() => {}) });
    p.inline();
    for (const match of read(file).matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) {
      assert.equal(typeof p.context[match[1]], 'function', `${file}: ${match[1]}`);
    }
    assert.equal(p.redirects.length, 0);
  });
}
test('papel incorreto redireciona para o painel correspondente sem inicializar a página', () => {
  for (const tipo of ['cliente', 'prestador']) {
    const other = tipo === 'cliente' ? 'prestador' : 'cliente';
    for (const file of [`dashboard-${other}.html`, `perfil_${other}.html`]) {
      const p = page(file, { storage: storage(tipo) }); p.inline();
      assert.deepEqual(p.redirects, [`dashboard-${tipo}.html`]); assert.equal(p.requests.length, 0);
    }
  }
});

test('expiração durante a página remove sessão visual sem consultar API', () => {
  const p = page('index.html', { storage: storage() });
  const timer = [...p.timers.values()][0]; p.setTime(now + 3601000); timer.fn();
  assert.equal(p.context.IS.logado, false); assert.equal(p.requests.length, 0);
});
test('logout em outra aba e retorno pelo histórico atualizam a sessão', () => {
  for (const event of ['storage', 'pageshow']) {
    const data = storage(); const home = page('index.html', { storage: data });
    const privatePage = page('profissionais.html', { storage: data }); privatePage.context.IS.exigirSessao();
    data.clear(); home.event(event, { key: 'token' }); privatePage.event(event, { key: null });
    assert.equal(home.context.IS.logado, false); assert.equal(privatePage.context.IS.logado, false);
    assert.deepEqual(privatePage.redirects, ['login.html']);
  }
});
test('troca de conta em outra aba atualiza links e recarrega scripts com a nova identidade', () => {
  const data = storage(); const p = page('index.html', { storage: data });
  for (const [key, value] of storage('prestador')) data.set(key, value);
  p.event('storage', { key: 'usuario' });
  assert.equal(p.context.IS.dashboardUrl(), 'dashboard-prestador.html'); assert.equal(p.reloads, 1);
});

test('401 autenticado é autoridade mesmo para token com metadados plausíveis; Response preservada', async () => {
  const response = new Response('{"mensagem":"Token invalido"}', { status: 401 });
  const p = page('index.html', { storage: storage(), fetch: () => response });
  assert.ok(p.context.IS.logado); // não é prova de assinatura válida
  const result = await p.context.fetch('/api/agendamentos/cliente', { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(result, response); assert.equal((await result.json()).mensagem, 'Token invalido');
  assert.equal(p.context.IS.logado, false); assert.deepEqual(p.redirects, ['login.html']);
  assert.equal(p.requests.length, 1);
});
test('observador de 401 aceita Request e preserva argumentos sem acrescentar headers', async () => {
  const p = page('index.html', { storage: storage(), fetch: () => new Response('', { status: 401 }) });
  const request = new Request('https://iservice.test/api/notificacoes', { headers: new Headers({ authorization: `Bearer ${token()}` }) });
  await p.context.fetch(request); assert.equal(p.requests[0][0], request); assert.equal(p.requests[0].length, 1);
  assert.equal(p.context.IS.logado, false);
});
for (const [label, url, headers, status] of [
  ['login incorreto', '/api/login', { Authorization: `Bearer ${token()}` }, 401],
  ['cadastro', '/api/cadastro', { Authorization: `Bearer ${token()}` }, 401],
  ['requisição pública', '/api/servicos', {}, 401],
  ['outra origem', 'https://external.invalid/api/servicos', { Authorization: `Bearer ${token()}` }, 401],
  ['fora da API', '/arquivo', { Authorization: `Bearer ${token()}` }, 401],
  ['papel negado', '/api/servicos', { Authorization: `Bearer ${token()}` }, 403]
]) {
  test(`${label}: não encerra a sessão`, async () => {
    const p = page('index.html', { storage: storage(), fetch: () => new Response('', { status }) });
    await p.context.fetch(url, { headers }); assert.ok(p.context.IS.logado); assert.equal(p.redirects.length, 0);
  });
}
test('401 antigo não apaga sessão nova; rejeição de rede é preservada', async () => {
  let release; const data = storage();
  const p = page('index.html', { storage: data, fetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = p.context.fetch('/api/notificacoes', { headers: { Authorization: `Bearer ${token()}` } });
  data.set('token', token('cliente', { exp: now / 1000 + 7200 }));
  release(new Response('', { status: 401 })); await pending;
  assert.equal(p.redirects.length, 0); assert.ok(data.has('usuario'));
  const error = new Error('rede simulada');
  const q = page('index.html', { storage: storage(), fetch: () => { throw error; } });
  await assert.rejects(q.context.fetch('/api/notificacoes'), e => e === error);
  assert.ok(q.context.IS.logado);
});
test('login existente continua salvando sessão e redirecionando com o observador instalado', async () => {
  const p = page('login.html', { fetch: () => new Response(JSON.stringify({ token: token(), usuario: user('cliente') })) });
  p.inline(); p.document.getElementById('email').value = 'teste@example.invalid';
  p.document.getElementById('senha').value = 'senha-simulada';
  const form = p.document.getElementById('loginForm');
  await form.listeners.submit[0].call(form, { preventDefault() {} });
  assert.equal(p.data.get('token'), token());
  [...p.timers.values()][0].fn(); assert.equal(p.context.location.href, 'dashboard-cliente.html');
});

test('menu móvel possui um manipulador, abre/fecha uma vez e fecha ao seguir seção', () => {
  const p = page(); const toggle = p.document.querySelector('.nav-toggle'); const nav = p.document.getElementById('mainNav');
  assert.equal(toggle.listeners.click.length, 1);
  toggle.emit('click'); assert.ok(nav.classList.contains('open')); assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.emit('click'); assert.equal(nav.classList.contains('open'), false);
  toggle.emit('click'); const click = p.document.querySelector('.menu a[href="#servicos"]').emit('click');
  assert.equal(nav.classList.contains('open'), false); assert.ok(click.prevented);
  assert.equal(p.document.getElementById('servicos').scrolled.behavior, 'smooth');
  toggle.emit('click'); p.document.emit('click', { target: p.document.body });
  assert.equal(nav.classList.contains('open'), false);
});
test('scrollspy mantém destaque de página e só modifica links de seção existentes', () => {
  const p = page(); const catalog = p.document.querySelector('.menu a[href="profissionais.html"]');
  catalog.classList.add('active'); catalog.setAttribute('aria-current', 'page');
  p.document.getElementById('servicos').offsetTop = 1000; p.document.getElementById('servicos').offsetHeight = 500;
  p.context.scrollY = 1000; p.event('scroll');
  assert.ok(catalog.classList.contains('active')); assert.equal(catalog.attrs['aria-current'], 'page');
  const section = p.document.querySelector('.menu a[href="#servicos"]');
  assert.ok(section.classList.contains('active')); assert.equal(section.attrs['aria-current'], 'location');
});
test('todas as páginas usam catálogo na navegação; seções e agendamento da landing permanecem', () => {
  for (const file of pages) {
    const html = read(file); assert.ok(html.includes('<script src="app.js"></script>'), file);
    assert.doesNotMatch(html, /href="(?:index\.html)?#profissionais"/);
    const doc = dom(html);
    for (const a of doc.querySelectorAll('nav a')) {
      if (a.href && !a.href.startsWith('#') && !a.href.includes('://')) assert.ok(fs.existsSync(path.join(root, a.href.split('#')[0])), `${file}: ${a.href}`);
    }
  }
  const p = page();
  for (const id of ['inicio', 'como-contratar', 'servicos', 'profissionais', 'agendamento']) assert.ok(p.document.getElementById(id));
  assert.equal(p.document.getElementById('btnAgendar').listeners.click.length, 1);
  assert.ok(p.document.getElementById('data').min);
  assert.doesNotMatch(read('index.html'), /href="app.css"/);
  assert.match(read('home.css'), /\.is-guest \[data-auth="in"\]/);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('home reutiliza os quatro ícones do Dashboard, com nomes acessíveis nos links', () => {
  const home = dom(read('index.html')); const dashboard = dom(read('dashboard-cliente.html'));
  for (const [selector, icon] of [
    ['a[href="#inicio"]', 'fa-house'], ['a[data-link="dashboard"]', 'fa-gauge-high'],
    ['a[href="profissionais.html"]', 'fa-briefcase'], ['a[data-link="perfil"]', 'fa-user']
  ]) {
    const link = home.querySelector('.menu ' + selector);
    assert.ok(link.querySelector('.fas.' + icon));
    assert.equal(link.querySelector('i').getAttribute('aria-hidden'), 'true');
    assert.ok(dashboard.querySelector('.menu .fas.' + icon));
  }
  const css = read('home.css');
  assert.match(css, /\.menu a i \{[^}]*margin-right: 8px;[^}]*color: var\(--green-light\)/);
  assert.match(css, /\.is-guest \.menu a i \{ display: none; }/);
});

for (const [label, data] of [['visitante', new Map()], ['sessão corrompida', new Map([['usuario', '{']])]]) {
  test(`home ${label}: sino oculto, sem consulta ou intervalo de notificações`, () => {
    const p = page('index.html', { storage: data, notifications: true });
    assert.equal(p.visible(p.document.getElementById('notifSlot')), false);
    assert.equal(p.document.getElementById('notifBtn'), null);
    assert.equal(p.requests.length, 0); assert.equal(p.intervals.length, 0);
    assert.equal(p.document.querySelector('.nav-toggle').listeners.click.length, 1);
  });
}

for (const tipo of ['cliente', 'prestador']) {
  test(`home ${tipo}: um sino e contador autenticado usando o script existente`, async () => {
    const p = page('index.html', { storage: storage(tipo), notifications: true,
      fetch: () => jsonResponse({ total: 3 }) });
    await flush();
    assert.equal(p.document.querySelectorAll('#notifBtn').length, 1);
    assert.ok(p.visible(p.document.getElementById('notifItem')));
    assert.ok(p.document.getElementById('notifBtn').querySelector('.fa-bell'));
    assert.equal(p.document.getElementById('notifBadge').textContent, 3);
    assert.ok(p.document.getElementById('notifBadge').classList.contains('show'));
    assert.match(p.document.getElementById('notifBtn').attrs['aria-label'], /3 não lidas/);
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0][0], '/api/notificacoes/nao-lidas');
    assert.equal(p.requests[0][1].headers.Authorization, `Bearer ${token(tipo)}`);
    assert.equal(p.intervals.length, 1); assert.equal(p.intervals[0].ms, 30000);
    await p.intervals[0].fn(); assert.equal(p.requests.length, 2);
    p.context.IS.sair(); await p.intervals[0].fn();
    assert.equal(p.requests.length, 2); assert.equal(p.visible(p.document.getElementById('notifItem')), false);
  });
}

for (const total of [0, 1, 12]) {
  test(`home: contador de ${total} notificações preserva zero oculto e limite 9+`, async () => {
    const p = page('index.html', { storage: storage(), notifications: true,
      fetch: () => jsonResponse({ total }) });
    await flush();
    const badge = p.document.getElementById('notifBadge');
    assert.equal(badge.classList.contains('show'), total > 0);
    if (total) assert.equal(badge.textContent, total > 9 ? '9+' : total);
    assert.equal(p.document.getElementById('notifLerTodas').disabled, total === 0);
  });
}

test('home móvel: sino fecha menu, abre lista e permite fechar por Escape ou clique externo', async () => {
  const p = page('index.html', { storage: storage(), notifications: true,
    fetch: url => jsonResponse(url.endsWith('/nao-lidas') ? { total: 0 } : []) });
  await flush();
  const nav = p.document.getElementById('mainNav'); const toggle = p.document.querySelector('.nav-toggle');
  const bell = p.document.getElementById('notifBtn'); const panel = p.document.getElementById('notifDropdown');
  assert.equal(toggle.listeners.click.length, 1); assert.equal(bell.listeners.click.length, 1);
  toggle.click(); assert.ok(nav.classList.contains('open'));
  bell.click(); await flush();
  assert.equal(nav.classList.contains('open'), false); assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.ok(panel.classList.contains('open')); assert.equal(bell.attrs['aria-expanded'], 'true');
  assert.match(p.document.getElementById('notifLista').innerHTML, /Tudo em dia/);
  p.document.emit('keydown', { key: 'Escape' });
  assert.equal(panel.classList.contains('open'), false); assert.ok(bell.focused);
  bell.click(); await flush(); p.document.emit('click', { target: p.document.body });
  assert.equal(panel.classList.contains('open'), false);
});

test('home: abrir notificação reutiliza marcação como lida e destino existente', async () => {
  const notification = { _id: 'n1', tipo: 'nova_proposta', mensagem: 'Nova proposta',
    lida: false, link: '/dashboard-cliente.html', data_criacao: new Date(now).toISOString() };
  const p = page('index.html', { storage: storage(), notifications: true, fetch: url =>
    jsonResponse(url.endsWith('/nao-lidas') ? { total: 1 } : url.endsWith('/lida') ? {} : [notification]) });
  await flush(); p.document.getElementById('notifBtn').click(); await flush();
  const item = p.document.querySelector('.notif-item'); assert.ok(item);
  item.click(); await flush();
  const update = p.requests.find(([url]) => url === '/api/notificacoes/n1/lida');
  assert.equal(update[1].method, 'PUT');
  assert.equal(update[1].headers.Authorization, `Bearer ${token()}`);
  assert.equal(p.document.getElementById('notifBadge').classList.contains('show'), false);
  assert.equal(p.context.location.href, 'dashboard-cliente.html');
});

test('home: 401 no contador encerra a sessão e oculta o sino', async () => {
  const p = page('index.html', { storage: storage(), notifications: true,
    fetch: () => jsonResponse({ mensagem: 'Token invalido' }, 401) });
  await flush();
  assert.equal(p.context.IS.logado, false); assert.deepEqual(p.redirects, ['login.html']);
  assert.equal(p.visible(p.document.getElementById('notifItem')), false);
  await p.intervals[0].fn(); assert.equal(p.requests.length, 1);
});

test('home: falha ao carregar notificações mantém menu utilizável e mostra erro no painel', async () => {
  const p = page('index.html', { storage: storage(), notifications: true,
    fetch: () => jsonResponse({ mensagem: 'Falha simulada' }, 500) });
  await flush(); p.document.getElementById('notifBtn').click(); await flush();
  assert.ok(p.document.querySelector('.notif-state.is-error')); assert.ok(p.context.IS.logado);
  p.document.querySelector('.nav-toggle').click();
  assert.ok(p.document.getElementById('mainNav').classList.contains('open'));
});

test('estilos do sino são compartilhados sem importar app.css na home e mantêm breakpoints', () => {
  const shared = read('home.css'); const internal = read('app.css');
  assert.doesNotMatch(read('index.html'), /href="app.css"/);
  assert.doesNotMatch(internal, /\.notif(?:-|\s*\{)/);
  assert.equal([...shared.matchAll(/\.notif-badge \{/g)].length, 1);
  assert.match(shared, /\.icon-btn \{[^}]*width: 40px;[^}]*height: 40px;/);
  assert.match(shared, /@media \(max-width: 920px\) \{\s*\.notif \{ position: static; }\s*\.notif-panel \{[^}]*width: auto;/);
  assert.match(shared, /@media \(max-width: 600px\) \{\s*\.notif-panel \{ left: 8px; right: 8px; }/);
  assert.match(shared, /@media \(max-width: 480px\) \{\s*\.link-btn \.lg \{ display: none; }/);
  for (const property of ['ok-bg', 'warn', 'warn-bg', 'danger', 'danger-bg', 'info', 'info-bg']) {
    assert.ok(shared.includes(`--${property}:`), `Variável ausente: ${property}`);
  }
});
