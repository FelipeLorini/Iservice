const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { controllerStubs, startHttp } = require('./helpers/httpApp');

const publicRoot = path.join(__dirname, '..', 'public');
const pages = ['index.html', 'login.html', 'cadastro.html', 'faq.html', 'chat.html',
  'contratar.html', 'dashboard-cliente.html', 'dashboard-prestador.html',
  'perfil_cliente.html', 'perfil_prestador.html', 'profissionais.html',
  'faxina.html', 'jardinagem.html', 'Reparos.html', 'eletrica.html', 'pintura.html', 'encanamento.html'];
const setup = t => startHttp(t, { controllers: controllerStubs([]), secret: 'estaticos-ficticio', usuarioId: '1'.repeat(24) });

test('View: todas as paginas mantem as URLs anteriores na aplicacao Express real', async t => {
  const { request } = await setup(t);
  for (const file of pages) {
    const response = await request('GET', '/' + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers['content-type'], /^text\/html/, file);
    assert.equal(response.text, fs.readFileSync(path.join(publicRoot, file), 'utf8'), file);
  }
  const root = await request('GET', '/');
  assert.equal(root.status, 200);
  assert.equal(root.text, fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8'));
  const head = await request('HEAD', '/dashboard-cliente.html');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(Number(head.headers['content-length']), fs.statSync(path.join(publicRoot, 'dashboard-cliente.html')).size);
});

test('View: scripts, CSS e imagens preservam caminhos e tipos HTTP', async t => {
  const { request } = await setup(t);
  for (const [files, type] of [
    [['app.js', 'chat.js', 'conversas.js', 'favoritos.js', 'menu.js', 'notificacoes.js', 'script.js'], /javascript/],
    [['app.css', 'home.css', 'style.css', 'theme.css'], /^text\/css/],
    [['logo.png', 'logo-full.png', 'logo-mark.png', 'logo iservice/Logo_iService__1__-_Copia-removebg-preview.png'], /^image\/png/]
  ]) {
    for (const file of files) {
      const response = await request('GET', '/' + file.split('/').map(encodeURIComponent).join('/'));
      assert.equal(response.status, 200, file);
      assert.match(response.headers['content-type'], type, file);
      assert.equal(Number(response.headers['content-length']), fs.statSync(path.join(publicRoot, file)).size, file);
      if (!file.endsWith('.png')) assert.equal(response.text, fs.readFileSync(path.join(publicRoot, file), 'utf8'), file);
    }
  }
});

test('View: referencias locais de HTML e CSS resolvem com a grafia exata', () => {
  function check(reference, source) {
    if (!reference || reference.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(reference)) return;
    const url = new URL(reference, 'http://local.invalid/' + source);
    const relative = decodeURIComponent(url.pathname).slice(1) || 'index.html';
    let parent = publicRoot;
    for (const segment of relative.split('/')) {
      assert.ok(fs.readdirSync(parent).includes(segment), `${source}: ${reference} (grafia/caminho)`);
      parent = path.join(parent, segment);
    }
    assert.ok(fs.statSync(parent).isFile(), `${source}: ${reference}`);
  }
  for (const file of pages) {
    const html = fs.readFileSync(path.join(publicRoot, file), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, match => match.slice(0, match.indexOf('>') + 1))
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const [, , reference] of html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) check(reference, file);
  }
  for (const file of ['home.css', 'app.css', 'style.css', 'theme.css']) {
    const css = fs.readFileSync(path.join(publicRoot, file), 'utf8');
    for (const [, reference] of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) check(reference.trim(), file);
  }
});

test('View: servidor nao expoe codigo interno, estruturas antigas ou arquivos auxiliares', async t => {
  const { request } = await setup(t);
  for (const url of ['/server.js', '/src/app.js', '/controllers/pedidoController.js',
    '/Models/usuarioModel.js', '/services/propostaService.js', '/tests/helpers/httpApp.js',
    '/Views/authView.js', '/site-iservice-main/index.html', '/public/index.html',
    '/README.md', '/workspace.code-workspace', '/docs/demo-contratacao-local.md']) {
    assert.equal((await request('GET', url)).status, 404, url);
  }
});

test('View: montagem estatica preserva precedencia da API e autenticacao do chat', async t => {
  const { request } = await setup(t);
  const faq = await request('GET', '/api/faq');
  assert.equal(faq.status, 200);
  assert.equal(JSON.parse(faq.text).handler, 'faqController.listarFaqs');
  for (const url of ['/api/chat', '/api/servicos/prestador', '/api/favoritos', '/api/notificacoes']) {
    assert.equal((await request('GET', url)).status, 401, url);
  }
});
