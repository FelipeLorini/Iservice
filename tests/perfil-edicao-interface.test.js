const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../site-iservice-main');
const html = fs.readFileSync(path.join(root, 'perfil_prestador.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const A = '1'.repeat(24), B = '2'.repeat(24);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (body, status = 200) => ({ ok: status === 200, status, async json() { return body; } });
async function form(options = {}) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const nodes = new Map(ids.map(id => [id, { value: '', disabled: false, textContent: '', innerHTML: '', events: {},
    addEventListener(event, fn) { this.events[event] = fn; }, focus() {} }]));
  const storage = options.storage || new Map();
  const reads = [], writes = [], calls = [], messages = [], notices = [];
  const id = options.id || A;
  const record = options.record || { id, tipo: 'prestador', nome: 'Profissional', descricao_detalhada: 'Descricao da API', portifolio: ['https://example.invalid/original.png'] };
  const IS = { usuario: { id, tipo: 'prestador', nome: 'Profissional' }, token: 'token-' + id,
    API_URL: '/api', exigirSessao: () => true, esc: String, inicial: s => s[0], categoria: () => ({ nome: 'Faxina' }),
    vazio: (...args) => args.join(' '), estrelas: () => '',
    msg: (el, text, type) => messages.push({ text, type }), toast: (text, type) => notices.push({ text, type }) };
  const context = { IS, document: { getElementById: id => { assert.ok(nodes.has(id), id); return nodes.get(id); }, querySelectorAll: () => [] },
    localStorage: { getItem(key) { reads.push(key); if (options.blockedStorage) throw Error('Bloqueado'); return storage.get(key) ?? null; },
      setItem(key, value) { if (options.blockedStorage) throw Error('Bloqueado'); writes.push(key); storage.set(key, value); } },
    console: { error() {} },
    async fetch(url, config = {}) {
      calls.push({ url, config });
      if (url.endsWith('/perfil')) return options.load ? options.load() : response(record);
      if (url.endsWith('/media')) return response({ total: 0, media: 0 });
      if (config.method === 'PUT') {
        if (options.save) return options.save(config);
        Object.assign(record, JSON.parse(config.body));
        return response({ ...record });
      }
      return response([]);
    }
  };
  context.window = context;
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (source.trim()) vm.runInNewContext(source, context);
  await flush();
  return { nodes, reads, writes, calls, messages, notices, storage, record, context,
    submit: () => nodes.get('formPerfil').events.submit({ preventDefault() {} }),
    puts: () => calls.filter(c => c.config.method === 'PUT') };
}
test('descricao vem da API, nunca de dados antigos ou de outro prestador', async () => {
  const storage = new Map([['perfilPrestador', '{"descricao":"GLOBAL","telefone":"OUTRO"}'],
    ['perfilPrestador:' + B, '{"descricao":"OUTRO","telefone":"OUTRO"}'],
    ['perfilPrestador:' + A, '{"descricao":"LOCAL ANTIGA"}']]);
  const f = await form({ storage });
  assert.deepEqual(f.reads, ['perfilPrestador:' + A]);
  assert.equal(f.nodes.get('descricao').value, 'Descricao da API');
  assert.equal(f.nodes.get('telefone').value, '');
  assert.equal(f.nodes.get('descricao').disabled, false);
});
test('salvar descricao envia somente descricao_detalhada e recarrega a versao persistida', async () => {
  const f = await form(); f.nodes.get('descricao').value = '  Texto novo  ';
  await f.submit();
  assert.deepEqual(JSON.parse(f.puts()[0].config.body), { descricao_detalhada: 'Texto novo' });
  assert.equal(f.puts()[0].config.headers.Authorization, 'Bearer token-' + A);
  assert.deepEqual(f.record.portifolio, ['https://example.invalid/original.png']);
  assert.ok(f.messages.some(m => m.type === 'success'));
  assert.equal(JSON.parse(f.storage.get('perfilPrestador:' + A)).descricao, undefined);
  const reloaded = await form({ record: f.record, storage: f.storage });
  assert.equal(reloaded.nodes.get('descricao').value, 'Texto novo');
});
for (const [name, save] of [
  ['HTTP', () => response({ mensagem: 'Erro' }, 500)],
  ['rede', () => Promise.reject(Error('Offline'))],
  ['JSON', () => ({ ok: true, json: async () => { throw Error('JSON'); } })]
]) test('falha ' + name + ' nao mostra sucesso nem grava preferencias', async () => {
  const f = await form({ save }); f.nodes.get('descricao').value = 'Nova';
  await f.submit();
  assert.ok(f.messages.some(m => m.type === 'error'));
  assert.ok(!f.messages.some(m => m.type === 'success'));
  assert.deepEqual(f.writes, []);
  assert.equal(f.nodes.get('descricao').value, 'Nova');
});
test('falha de carga impede salvar descricao ou sobrescrever portfolio desconhecido', async () => {
  const f = await form({ load: () => response({}, 500) });
  await f.submit(); await f.context.removerFoto(0);
  assert.equal(f.puts().length, 0);
  assert.equal(f.nodes.get('descricao').disabled, true);
  assert.equal(f.nodes.get('btnSalvarPerfil').disabled, true);
});
test('resposta de perfil de outra conta e recusada', async () => {
  const f = await form({ record: { id: B, tipo: 'prestador', descricao_detalhada: 'OUTRO', portifolio: [] } });
  assert.equal(f.nodes.get('descricao').value, '');
  await f.submit(); assert.equal(f.puts().length, 0);
});
test('troca de sessao durante PUT nao aplica resposta nem preferencias da conta anterior', async () => {
  const pending = deferred();
  const f = await form({ save: () => pending.promise });
  const submitting = f.submit();
  f.context.IS.usuario = { id: B }; f.context.IS.token = 'token-' + B;
  pending.resolve(response({ descricao_detalhada: 'Conta anterior' }));
  await submitting;
  assert.deepEqual(f.writes, []);
  assert.ok(!f.messages.some(m => m.type === 'success'));
  assert.equal(f.nodes.get('btnSalvarPerfil').disabled, true);
});
test('duplo submit compartilha operacao e storage bloqueado nao impede persistencia na API', async () => {
  const pending = deferred(), f = await form({ blockedStorage: true, save: () => pending.promise });
  const first = f.submit(); await f.submit(); assert.equal(f.puts().length, 1);
  pending.resolve(response({ descricao_detalhada: 'Salva' })); await first;
  assert.ok(f.messages.some(m => m.type === 'success' && m.text.includes('não foi possível guardar')));
});
test('portfolio confirmado preserva descricao; exclusao e inclusao aguardam a API', async () => {
  const f = await form(); f.nodes.get('portfolioUrlInput').value = 'https://example.invalid/nova.png';
  await f.nodes.get('btnAdicionarFoto').events.click();
  assert.deepEqual(Object.keys(JSON.parse(f.puts()[0].config.body)), ['portifolio']);
  assert.equal(f.record.descricao_detalhada, 'Descricao da API');
  assert.equal(f.record.portifolio.length, 2);
  assert.match(f.nodes.get('portfolioGrid').innerHTML, /nova.png/);
  await f.context.removerFoto(0);
  assert.deepEqual(f.record.portifolio, ['https://example.invalid/nova.png']);
});
test('portfolio recusado preserva foto anterior e nao anuncia inclusao ou exclusao', async () => {
  const f = await form({ save: () => response({}, 500) });
  f.nodes.get('portfolioUrlInput').value = 'https://example.invalid/nova.png';
  await f.nodes.get('btnAdicionarFoto').events.click();
  await f.context.removerFoto(0);
  assert.match(f.nodes.get('portfolioGrid').innerHTML, /original.png/);
  assert.doesNotMatch(f.nodes.get('portfolioGrid').innerHTML, /nova.png/);
  assert.ok(f.notices.every(n => n.type === 'error'));
});
test('layout restaura geometria original do hero e rotulo simples preserva contador', () => {
  const css = fs.readFileSync(path.join(root, 'home.css'), 'utf8');
  assert.match(css, /\.visual-panel \{[^}]*aspect-ratio: 1 \/ 1;[^}]*place-items: center;/);
  assert.match(css, /\.visual-mark \{[^}]*width: 58%;/);
  assert.match(css, /\.chip \{[^}]*position: absolute;[^}]*gap: 12px;[^}]*padding: 12px 16px;/);
  assert.match(css, /\.chip-1 \{ top: 12%; left: -28px; \}/);
  assert.match(css, /\.chip-2 \{ top: 42%; right: -24px; \}/);
  assert.match(css, /\.chip-3 \{ bottom: 10%; left: 6%; \}/);
  assert.match(css, /@media \(max-width: 920px\)[\s\S]*\.chip-1 \{ left: 0; \}/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.chip-1 \{ top: 8%; \}/);
  const dashboard = fs.readFileSync(path.join(root, 'dashboard-cliente.html'), 'utf8');
  assert.match(dashboard, /id="totalFavoritos">[^<]*<\/span><span class="stat-label">Meus Favoritos<\/span>/);
  assert.match(dashboard, /<a href="#meusFavoritos" class="btn/);
  assert.match(fs.readFileSync(path.join(root, 'profissionais.html'), 'utf8'), /avaliações exibidas quando disponíveis/);
});
