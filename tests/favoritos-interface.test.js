const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'site-iservice-main', file), 'utf8');
const CLIENTE = '1'.repeat(24), PRESTADOR = '2'.repeat(24), OUTRO = '3'.repeat(24);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const favorito = (id = PRESTADOR, nome = 'Ana Limpeza') => ({ prestador_id: { _id: id, nome } });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (id = CLIENTE, exp = Date.now() / 1000 + 3600, tipo = 'cliente') =>
    `${encode({ alg: 'HS256' })}.${encode({ id, tipo, exp })}.assinatura`;
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const ok = body => ({ ok: true, status: 200, async json() { return plain(body); } });
const failure = status => ({ ok: false, status, async json() { return { mensagem: 'Erro simulado' }; } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// DOM e rede em memoria. app.js real valida a sessao visual e observa os 401.
class Node {
    constructor(attrs = {}) {
        this.attrs = attrs; this.children = []; this.events = {}; this.textContent = '';
        this.disabled = Object.hasOwn(attrs, 'disabled'); this.hidden = Object.hasOwn(attrs, 'hidden'); this.open = false;
        const classes = new Set((attrs.class || '').split(/\s+/));
        this.classList = { add: (...items) => items.forEach(x => classes.add(x)), remove: (...items) => items.forEach(x => classes.delete(x)),
            contains: item => classes.has(item), toggle(item, force = !classes.has(item)) { force ? classes.add(item) : classes.delete(item); } };
    }
    get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) =>
        [key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(event, callback) { (this.events[event] ||= []).push(callback); }
    emit(event, detail = {}) { return Promise.all((this.events[event] || []).map(callback => callback({ target: this, ...detail }))); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    matches(selector) {
        if (selector === 'i') return this.attrs.tag === 'i';
        if (selector.startsWith('.') && !this.classList.contains(selector.slice(1).split('[')[0])) return false;
        const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
        return !!attr && Object.hasOwn(this.attrs, attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) {
        this.html = value; this.children = [];
        for (const match of value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
            const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], decode(m[2] || '')]));
            const button = new Node(attrs); button.parent = this; button.textContent = match[2]; this.children.push(button);
        }
    }
}

async function page(options = {}) {
    const catalogo = !!options.catalogo;
    const state = { records: [favorito()], ...options };
    const nodes = new Map();
    const doc = new Node();
    const node = id => {
        if (!nodes.has(id)) { const value = new Node({ id }); nodes.set(id, value); doc.children.push(value); }
        return nodes.get(id);
    };
    doc.documentElement = new Node(); doc.body = new Node();
    node('estadoFavoritos');
    if (!catalogo) ['listaFavoritos', 'totalFavoritos', 'tituloFavoritos', 'perfilFavorito', 'conteudoPerfilFavorito', 'fecharPerfilFavorito'].forEach(node);
    if (!catalogo) {
        const expandir = node('alternarListaFavoritos');
        expandir.setAttribute('data-favorito-acao', 'expandir');
        expandir.setAttribute('aria-controls', 'listaFavoritos');
        expandir.setAttribute('aria-expanded', 'false');
        expandir.hidden = true;
    }
    const retry = new Node({ 'data-favorito-acao': 'recarregar', hidden: '' }); doc.children.push(retry);
    const hearts = [];
    if (catalogo) {
        for (const id of [PRESTADOR, PRESTADOR, OUTRO]) {
            const heart = new Node({ class: 'btn-favorito', 'data-favorito-acao': 'alternar', 'data-prestador': id, 'data-nome': 'Profissional', disabled: '' });
            heart.children.push(new Node({ tag: 'i', class: 'far fa-heart' })); doc.children.push(heart); hearts.push(heart);
        }
    }
    doc.getElementById = id => nodes.get(id) || null;
    const storage = new Map([['token', token()], ['usuario', JSON.stringify({ id: CLIENTE, tipo: 'cliente', nome: 'Pessoa' })]]);
    if (options.expired) storage.set('token', token(CLIENTE, 1));
    if (options.invalid) storage.set('usuario', '{');
    if (options.guest) storage.clear();
    if (options.prestador) { storage.set('token', token(CLIENTE, undefined, 'prestador')); storage.set('usuario', JSON.stringify({ id: CLIENTE, tipo: 'prestador' })); }
    const requests = [], storageWrites = [], redirects = [], chats = [];
    const events = new Node();
    const location = { href: 'https://iservice.test/' + (catalogo ? 'profissionais.html' : 'dashboard-cliente.html'),
        origin: 'https://iservice.test', pathname: catalogo ? '/profissionais.html' : '/dashboard-cliente.html',
        replace(value) { redirects.push(value); }, reload() { redirects.push('reload'); } };
    const context = vm.createContext({
        document: doc, location, URL, URLSearchParams, Headers, Request, Response, console,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        setTimeout() { return 1; }, clearTimeout() {},
        localStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key),
            setItem(key, value) { if (state.storageBlocked) throw new Error('Storage indisponivel'); storage.set(key, value); storageWrites.push([key, value]); } },
        addEventListener: (event, callback) => events.addEventListener(event, callback),
        async abrirChat(id) { chats.push(id); },
        async fetch(url, config = {}) {
            requests.push({ url, config: plain(config) });
            assert.equal(config.headers.Authorization, 'Bearer ' + storage.get('token'));
            if (url === '/api/favoritos' && !config.method) return state.load ? state.load() : ok(state.records);
            if (config.method === 'DELETE') {
                if (state.remove) return state.remove(url);
                state.records = state.records.filter(item => item.prestador_id?._id !== url.split('/').pop());
                return ok({ mensagem: 'Removido' });
            }
            if (config.method === 'POST') {
                if (state.add) return state.add();
                const id = JSON.parse(config.body).prestador_id;
                state.records.push(favorito(id, 'Profissional')); return ok({ favorito: { prestador_id: id } });
            }
            assert.match(url, /^\/api\/usuario\/[a-f\d]{24}\/perfil$/);
            if (state.profile) return state.profile(url);
            return ok({ id: url.split('/')[3], nome: 'Ana Limpeza', tipo: 'prestador', descricao_detalhada: 'Cuido de sua casa', portifolio: [], online: false });
        }
    });
    context.window = context;
    vm.runInContext(read('app.js'), context);
    vm.runInContext(read('favoritos.js'), context);
    await doc.emit('DOMContentLoaded');
    await flush();
    return {
        state, context, nodes, node, requests, storage, storageWrites, redirects, hearts, retry, chats,
        buttons: () => node('listaFavoritos').querySelectorAll('[data-favorito-acao]'),
        button: (action, id = PRESTADOR) => node('listaFavoritos').querySelectorAll(`[data-favorito-acao="${action}"]`).find(b => b.dataset.prestador === id),
        click: button => doc.emit('click', { target: button }),
        async event(event, detail) { await events.emit(event, detail); await flush(); }
    };
}

test('integra uma unica area de favoritos, atalho e script compartilhado sem handler antigo', () => {
    const dashboard = read('dashboard-cliente.html'), catalogo = read('profissionais.html');
    assert.equal((dashboard.match(/id="listaFavoritos"/g) || []).length, 1);
    assert.match(dashboard, /href="#meusFavoritos"/);
    assert.match(dashboard, /<dialog[^>]*id="perfilFavorito"/);
    for (const html of [dashboard, catalogo]) {
        assert.equal((html.match(/src="favoritos.js" defer/g) || []).length, 1);
        assert.doesNotMatch(html, /function carregarFavoritos|function alternarFavorito|onclick="alternarFavorito/);
    }
    assert.match(catalogo, /IS.favoritos\?\.atualizarBotoes/);
});

test('cliente autenticado ve nome, contador e botoes com responsabilidades distintas', async () => {
    const p = await page();
    assert.equal(p.node('totalFavoritos').textContent, '1');
    assert.match(p.node('listaFavoritos').innerHTML, /Ana Limpeza/);
    assert.deepEqual(p.buttons().map(b => b.dataset.favoritoAcao), ['perfil', 'conversar', 'remover']);
    await p.click(p.button('perfil'));
    assert.equal(p.node('perfilFavorito').open, true);
    assert.match(p.node('conteudoPerfilFavorito').innerHTML, /Cuido de sua casa/);
    assert.equal(p.requests.at(-1).url, `/api/usuario/${PRESTADOR}/perfil`);
    await p.click(p.button('conversar'));
    assert.deepEqual(p.chats, [PRESTADOR]);
    assert.equal(p.requests.filter(r => r.config.method === 'DELETE').length, 0);
});

test('sem favoritos apresenta estado vazio real e contador zero', async () => {
    const p = await page({ records: [] });
    assert.equal(p.node('totalFavoritos').textContent, '0');
    assert.match(p.node('listaFavoritos').innerHTML, /Você ainda não tem favoritos/);
    assert.equal(p.buttons().length, 0);
});

test('remocao bem-sucedida atualiza contador, persiste em nova consulta e sinaliza outras abas', async () => {
    const p = await page();
    await p.click(p.button('remover'));
    assert.equal(p.requests.at(-1).url, `/api/favoritos/${PRESTADOR}`);
    assert.equal(p.requests.at(-1).config.method, 'DELETE');
    assert.equal(p.node('totalFavoritos').textContent, '0');
    assert.equal(p.state.records.length, 0);
    assert.equal(p.storageWrites[0][0], 'iservice:favoritos:' + CLIENTE);
    assert.ok(!p.storageWrites[0][1].includes(PRESTADOR));
    await p.event('pageshow', { persisted: true });
    assert.equal(p.node('totalFavoritos').textContent, '0');
    const recarregada = await page({ records: p.state.records });
    assert.equal(recarregada.node('totalFavoritos').textContent, '0');
});

for (const scenario of ['HTTP', 'rede']) {
    test(`falha ${scenario} ao remover preserva linha, contador e permite nova tentativa`, async () => {
        const p = await page({ remove: async () => { if (scenario === 'rede') throw new Error('Offline'); return failure(500); } });
        await p.click(p.button('remover'));
        assert.equal(p.node('totalFavoritos').textContent, '1');
        assert.match(p.node('listaFavoritos').innerHTML, /Ana Limpeza/);
        assert.match(p.node('estadoFavoritos').textContent, /Não foi possível remover/);
        assert.equal(p.button('remover').disabled, false);
        assert.equal(p.storageWrites.length, 0);
        p.state.remove = null;
        await p.click(p.button('remover'));
        assert.equal(p.node('totalFavoritos').textContent, '0');
    });
}

for (const scenario of ['HTTP', 'rede', 'JSON', 'contrato']) {
    test(`falha ${scenario} ao carregar nao se confunde com lista vazia e permite tentar novamente`, async () => {
        const p = await page({ load: async () => {
            if (scenario === 'rede') throw new Error('Offline');
            if (scenario === 'JSON') return { ok: true, async json() { throw new Error('JSON'); } };
            return scenario === 'contrato' ? ok({}) : failure(500);
        } });
        assert.equal(p.node('totalFavoritos').textContent, '—');
        assert.match(p.node('listaFavoritos').innerHTML, /Não foi possível carregar/);
        assert.equal(p.retry.hidden, false);
        p.state.load = null;
        await p.click(p.retry);
        assert.equal(p.node('totalFavoritos').textContent, '1');
        assert.equal(p.retry.hidden, true);
    });
}

test('carregamento e cliques repetidos compartilham consulta, sem requisicoes duplicadas', async () => {
    const pending = deferred();
    const p = await page({ load: () => pending.promise });
    assert.match(p.node('listaFavoritos').innerHTML, /Carregando/);
    const focus = p.event('focus');
    const back = p.event('pageshow', { persisted: true });
    assert.equal(p.requests.length, 1);
    pending.resolve(ok([favorito()])); await Promise.all([focus, back]);
    assert.equal(p.node('totalFavoritos').textContent, '1');
});

test('duplo clique durante remocao envia um DELETE e aguarda sucesso para retirar a linha', async () => {
    const pending = deferred();
    const p = await page({ remove: () => pending.promise });
    const original = p.button('remover');
    const first = p.click(original);
    await p.click(original);
    assert.equal(p.requests.filter(r => r.config.method === 'DELETE').length, 1);
    assert.equal(p.button('remover').disabled, true);
    assert.equal(p.node('totalFavoritos').textContent, '1');
    pending.resolve(ok({})); await first;
    assert.equal(p.node('totalFavoritos').textContent, '0');
});

test('referencias incompletas sao ignoradas ou recebem nome neutro, sem duplicar prestador', async () => {
    const p = await page({ records: [null, {}, { prestador_id: null }, { prestador_id: PRESTADOR },
        favorito('invalido'), favorito(PRESTADOR), favorito(PRESTADOR), { prestador_id: { _id: OUTRO } }] });
    assert.equal(p.node('totalFavoritos').textContent, '2');
    assert.match(p.node('listaFavoritos').innerHTML, /Prestador/);
    assert.equal(p.buttons().length, 6);
});

test('nomes, descricao e portfolio nao injetam HTML nem exibem telefone, email ou campos privados', async () => {
    const ataque = '<img src=x onerror="alert(1)">';
    const p = await page({ records: [{ ...favorito(PRESTADOR, ataque), telefone: 'PRIVADO', email: 'PRIVADO' }],
        profile: async () => ok({ id: PRESTADOR, tipo: 'prestador', nome: ataque, descricao_detalhada: ataque,
            telefone: 'PRIVADO', email: 'PRIVADO', senha: 'PRIVADO', token: 'PRIVADO',
            portifolio: ['javascript:alert(1)', 'data:text/html,test', 'https://example.invalid/foto.jpg'] }) });
    assert.ok(!p.node('listaFavoritos').innerHTML.includes(ataque));
    assert.match(p.node('listaFavoritos').innerHTML, /&lt;img/);
    await p.click(p.button('perfil'));
    const html = p.node('conteudoPerfilFavorito').innerHTML;
    assert.ok(!html.includes(ataque));
    assert.doesNotMatch(html, /PRIVADO|javascript:|data:text/);
    assert.match(html, /https:\/\/example.invalid\/foto.jpg/);
});

for (const options of [{ guest: true }, { invalid: true }, { expired: true }, { prestador: true }]) {
    test(`sessao sem cliente valido nao consulta favoritos: ${JSON.stringify(options)}`, async () => {
        const p = await page(options);
        assert.equal(p.requests.length, 0);
    });
}

for (const operation of ['load', 'remove', 'profile']) {
    test(`401 em ${operation} encerra sessao pelo app existente e nao exibe dados antigos`, async () => {
        const p = await page(operation === 'load' ? { load: async () => failure(401) } : {});
        if (operation !== 'load') {
            p.state[operation] = async () => failure(401);
            await p.click(p.button(operation === 'remove' ? 'remover' : 'perfil'));
        }
        assert.equal(p.context.IS.logado, false);
        assert.ok(p.redirects.includes('login.html'));
        assert.equal(p.node('listaFavoritos').innerHTML, '');
        assert.equal(p.storageWrites.length, 0);
    });
}

test('resposta antiga nao repoe lista ao trocar a conta durante a consulta', async () => {
    const pending = deferred();
    const p = await page({ load: () => pending.promise });
    p.storage.set('token', token(OUTRO));
    p.storage.set('usuario', JSON.stringify({ id: OUTRO, tipo: 'cliente' }));
    await p.event('storage', { key: 'token' });
    pending.resolve(ok([favorito()])); await flush();
    assert.equal(p.node('listaFavoritos').innerHTML, '');
    assert.equal(p.node('totalFavoritos').textContent, '—');
});

test('catalogo sincroniza todos os coracoes apos remocao e eventos de outra aba', async () => {
    const p = await page({ catalogo: true });
    assert.ok(p.hearts.slice(0, 2).every(b => b.getAttribute('aria-pressed') === 'true'));
    await p.click(p.hearts[0]);
    assert.ok(p.hearts.slice(0, 2).every(b => b.getAttribute('aria-pressed') === 'false'));
    p.state.records = [favorito(OUTRO)];
    await p.event('storage', { key: 'iservice:favoritos:' + CLIENTE });
    assert.equal(p.hearts[2].getAttribute('aria-pressed'), 'true');
    const count = p.requests.length;
    await p.event('storage', { key: 'iservice:favoritos:' + OUTRO });
    assert.equal(p.requests.length, count);
});

test('catalogo nao simula sucesso no POST e permite adicionar apos falha', async () => {
    const p = await page({ catalogo: true, records: [], add: async () => failure(500) });
    await p.click(p.hearts[0]);
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'false');
    assert.equal(p.storageWrites.length, 0);
    p.state.add = null;
    await p.click(p.hearts[0]);
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'true');
    assert.equal(p.hearts[1].getAttribute('aria-pressed'), 'true');
    await p.event('focus');
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'true');
});

test('aviso externo durante GET provoca nova consulta para nao manter coracao desatualizado', async () => {
    const pending = deferred();
    const p = await page({ catalogo: true, load: () => pending.promise });
    await p.event('storage', { key: 'iservice:favoritos:' + CLIENTE });
    p.state.load = null; p.state.records = [];
    pending.resolve(ok([favorito()])); await flush();
    assert.equal(p.requests.length, 2);
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'false');
});

test('foco durante DELETE aguarda gravacao antes de consultar novamente', async () => {
    const pending = deferred();
    const p = await page({ remove: () => pending.promise });
    const removing = p.click(p.button('remover'));
    await p.event('focus');
    assert.equal(p.requests.filter(r => !r.config.method).length, 1);
    p.state.records = []; pending.resolve(ok({})); await removing; await flush();
    assert.equal(p.requests.filter(r => !r.config.method).length, 2);
    assert.equal(p.node('totalFavoritos').textContent, '0');
});

test('perfil indisponivel e resposta atrasada apos fechar sao tratados sem alterar favoritos', async () => {
    const p = await page({ profile: async () => failure(404) });
    await p.click(p.button('perfil'));
    assert.match(p.node('conteudoPerfilFavorito').innerHTML, /Perfil indisponível/);
    const pending = deferred(); p.state.profile = () => pending.promise;
    const opening = p.click(p.button('perfil'));
    await p.click(p.button('perfil'));
    assert.equal(p.requests.filter(r => r.url.endsWith('/perfil')).length, 2);
    await p.node('fecharPerfilFavorito').emit('click');
    pending.resolve(ok({ id: PRESTADOR, tipo: 'prestador', nome: 'RESPOSTA-ANTIGA' })); await opening;
    assert.equal(p.node('perfilFavorito').open, false);
    assert.equal(p.button('perfil').focused, true);
    assert.doesNotMatch(p.node('conteudoPerfilFavorito').innerHTML, /RESPOSTA-ANTIGA/);
    assert.equal(p.node('totalFavoritos').textContent, '1');
});

test('storage indisponivel nao transforma remocao confirmada em falha', async () => {
    const p = await page({ storageBlocked: true });
    await p.click(p.button('remover'));
    assert.equal(p.node('totalFavoritos').textContent, '0');
    assert.match(p.node('estadoFavoritos').textContent, /removido/);
});

const muitosFavoritos = total => Array.from({ length: total }, (_, index) =>
    favorito((index + 32).toString(16).padStart(24, '0'), 'Profissional ' + (index + 1)));
const idsVisiveis = p => p.buttons().filter(botao => botao.dataset.favoritoAcao === 'perfil').map(botao => botao.dataset.prestador);

for (const total of [0, 1, 3, 4, 30]) {
    test(`${total} favoritos: mostra ate tres inicialmente sem limitar dados ou contador`, async () => {
        const records = muitosFavoritos(total);
        const p = await page({ records });
        assert.deepEqual(idsVisiveis(p), records.slice(0, 3).map(item => item.prestador_id._id));
        assert.equal(p.node('totalFavoritos').textContent, String(total));
        assert.equal(p.state.records.length, total);
        assert.equal(p.node('alternarListaFavoritos').hidden, total <= 3);
        assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), 'false');
        if (total > 3) assert.equal(p.node('alternarListaFavoritos').textContent, `Ver todos os ${total} favoritos`);
        assert.equal(p.requests.length, 1);
    });
}

test('expandir e recolher preservam total, mensagens e dados sem consultar a API', async () => {
    const records = muitosFavoritos(30);
    const p = await page({ records });
    const botao = p.node('alternarListaFavoritos');
    const requests = p.requests.length;
    for (let repeticao = 0; repeticao < 2; repeticao++) {
        await p.click(botao);
        assert.equal(botao.textContent, 'Ver menos');
        assert.equal(botao.getAttribute('aria-expanded'), 'true');
        assert.equal(idsVisiveis(p).length, 30);
        assert.equal(p.node('totalFavoritos').textContent, '30');
        await p.click(botao);
        assert.equal(botao.textContent, 'Ver todos os 30 favoritos');
        assert.equal(botao.getAttribute('aria-expanded'), 'false');
        assert.equal(idsVisiveis(p).length, 3);
        assert.equal(p.node('totalFavoritos').textContent, '30');
    }
    assert.equal(p.requests.length, requests);
    assert.deepEqual(p.state.records, records);
    assert.equal(p.node('estadoFavoritos').textContent, '');
});

for (const total of [4, 5]) {
    test(`remocao recolhida entre ${total} favoritos traz proximo item e atualiza expansao`, async () => {
        const records = muitosFavoritos(total);
        const p = await page({ records });
        await p.click(p.button('remover', records[0].prestador_id._id));
        assert.deepEqual(idsVisiveis(p), records.slice(1, 4).map(item => item.prestador_id._id));
        assert.equal(p.node('totalFavoritos').textContent, String(total - 1));
        assert.equal(p.node('alternarListaFavoritos').hidden, total === 4);
        assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), 'false');
        if (total === 5) assert.equal(p.node('alternarListaFavoritos').textContent, 'Ver todos os 4 favoritos');
        assert.equal(p.requests.filter(request => !request.config.method).length, 1);
        assert.equal(p.requests.filter(request => request.config.method === 'DELETE').length, 1);
    });
}

test('remocao expandida de item antes oculto mantem expansao enquanto houver mais de tres', async () => {
    const records = muitosFavoritos(6);
    const p = await page({ records });
    await p.click(p.node('alternarListaFavoritos'));
    await p.click(p.button('remover', records[4].prestador_id._id));
    const restantes = records.filter((_, index) => index !== 4);
    assert.deepEqual(idsVisiveis(p), restantes.map(item => item.prestador_id._id));
    assert.equal(p.node('totalFavoritos').textContent, '5');
    assert.equal(p.node('alternarListaFavoritos').textContent, 'Ver menos');
    assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), 'true');
    await p.click(p.node('alternarListaFavoritos'));
    assert.equal(p.node('alternarListaFavoritos').textContent, 'Ver todos os 5 favoritos');
    assert.equal(idsVisiveis(p).length, 3);
    assert.equal(p.node('totalFavoritos').textContent, '5');
});

test('ao passar de quatro para tres, expansao e reiniciada e controle desaparece', async () => {
    const records = muitosFavoritos(4);
    const p = await page({ records });
    await p.click(p.node('alternarListaFavoritos'));
    await p.click(p.button('remover', records[3].prestador_id._id));
    assert.equal(idsVisiveis(p).length, 3);
    assert.equal(p.node('totalFavoritos').textContent, '3');
    assert.equal(p.node('alternarListaFavoritos').hidden, true);
    assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), 'false');
    p.state.records = records;
    await p.event('storage', { key: 'iservice:favoritos:' + CLIENTE });
    assert.equal(idsVisiveis(p).length, 3);
    assert.equal(p.node('totalFavoritos').textContent, '4');
    assert.equal(p.node('alternarListaFavoritos').hidden, false);
    assert.equal(p.node('alternarListaFavoritos').textContent, 'Ver todos os 4 favoritos');
});

test('Ver perfil e Conversar funcionam no ultimo item apos expansao', async () => {
    const records = muitosFavoritos(12);
    const p = await page({ records });
    const ultimoId = records.at(-1).prestador_id._id;
    assert.equal(p.button('perfil', ultimoId), undefined);
    await p.click(p.node('alternarListaFavoritos'));
    await p.click(p.button('perfil', ultimoId));
    assert.equal(p.requests.at(-1).url, `/api/usuario/${ultimoId}/perfil`);
    assert.equal(p.node('perfilFavorito').open, true);
    await p.node('fecharPerfilFavorito').emit('click');
    assert.equal(p.button('perfil', ultimoId).focused, true);
    await p.click(p.button('conversar', ultimoId));
    assert.deepEqual(p.chats, [ultimoId]);
    assert.equal(p.requests.filter(request => request.config.method === 'DELETE').length, 0);
    assert.equal(p.node('totalFavoritos').textContent, '12');
});

for (const expandida of [false, true]) {
    test(`falha na remocao preserva total e lista ${expandida ? 'expandida' : 'recolhida'}`, async () => {
        const records = muitosFavoritos(5);
        const p = await page({ records, remove: async () => failure(500) });
        if (expandida) await p.click(p.node('alternarListaFavoritos'));
        const antes = idsVisiveis(p);
        await p.click(p.button('remover', antes.at(-1)));
        assert.deepEqual(idsVisiveis(p), antes);
        assert.equal(p.node('totalFavoritos').textContent, '5');
        assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), String(expandida));
        assert.match(p.node('estadoFavoritos').textContent, /Não foi possível remover/);
        await p.click(p.node('alternarListaFavoritos'));
        assert.match(p.node('estadoFavoritos').textContent, /Não foi possível remover/);
        assert.deepEqual(p.state.records, records);
    });
}

test('falha ao atualizar preserva lista expandida e aviso durante expansao e recolhimento', async () => {
    const p = await page({ records: muitosFavoritos(7) });
    await p.click(p.node('alternarListaFavoritos'));
    p.state.load = async () => failure(500);
    await p.event('focus');
    assert.equal(idsVisiveis(p).length, 7);
    assert.equal(p.node('totalFavoritos').textContent, '7');
    assert.match(p.node('estadoFavoritos').textContent, /última lista consultada/);
    const requests = p.requests.length;
    await p.click(p.node('alternarListaFavoritos'));
    assert.equal(idsVisiveis(p).length, 3);
    assert.match(p.node('estadoFavoritos').textContent, /última lista consultada/);
    assert.equal(p.retry.hidden, false);
    assert.equal(p.requests.length, requests);
});

test('controle fica oculto sem dados e desabilitado durante atualizacao, sem perder expansao', async () => {
    const pending = deferred();
    const p = await page({ load: () => pending.promise });
    assert.equal(p.node('alternarListaFavoritos').hidden, true);
    pending.resolve(ok(muitosFavoritos(4))); await flush();
    await p.click(p.node('alternarListaFavoritos'));
    const refresh = deferred(); p.state.load = () => refresh.promise;
    const focusing = p.event('focus');
    assert.equal(p.node('alternarListaFavoritos').disabled, true);
    assert.equal(p.node('listaFavoritos').getAttribute('aria-busy'), 'true');
    await p.click(p.node('alternarListaFavoritos'));
    refresh.resolve(ok(muitosFavoritos(5))); await focusing;
    assert.equal(p.node('alternarListaFavoritos').disabled, false);
    assert.equal(p.node('alternarListaFavoritos').getAttribute('aria-expanded'), 'true');
    assert.equal(idsVisiveis(p).length, 5);
});

test('recolher durante remocao pendente preserva bloqueio e aplica resultado corretamente', async () => {
    const pending = deferred();
    const records = muitosFavoritos(5);
    const p = await page({ records, remove: () => pending.promise });
    await p.click(p.node('alternarListaFavoritos'));
    const botao = p.button('remover', records[4].prestador_id._id);
    const removing = p.click(botao);
    await p.click(p.node('alternarListaFavoritos'));
    await p.click(p.node('alternarListaFavoritos'));
    assert.equal(p.button('remover', records[4].prestador_id._id).disabled, true);
    await p.click(botao);
    pending.resolve(ok({})); await removing;
    assert.equal(p.node('totalFavoritos').textContent, '4');
    assert.equal(idsVisiveis(p).length, 4);
    assert.equal(p.requests.filter(request => request.config.method === 'DELETE').length, 1);
});

test('catalogo continua considerando todos os favoritos, inclusive alem dos tres primeiros', async () => {
    const p = await page({ catalogo: true, records: [...muitosFavoritos(6), favorito(PRESTADOR)] });
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'true');
    await p.click(p.hearts[0]);
    assert.equal(p.hearts[0].getAttribute('aria-pressed'), 'false');
    assert.equal(p.state.records.length, 6);
});

test('controle de expansao e acessivel e acoes usam colunas flexiveis com area de toque', () => {
    const html = read('dashboard-cliente.html');
    const botao = html.match(/<button\b[^>]*id="alternarListaFavoritos"[^>]*>/)?.[0];
    assert.ok(botao);
    assert.match(botao, /type="button"/);
    assert.match(botao, /aria-controls="listaFavoritos"/);
    assert.match(botao, /aria-expanded="false"/);
    const css = read('app.css');
    const grid = css.match(/\.favorito-item \.row-actions\s*\{([^}]+)\}/)?.[1];
    const acoes = css.match(/\.favorito-item \.row-actions \.btn\s*\{([^}]+)\}/)?.[1];
    assert.match(grid, /display:\s*grid/);
    assert.match(grid, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(acoes, /min-height:\s*44px/);
    assert.match(acoes, /min-width:\s*0/);
    assert.match(acoes, /white-space:\s*normal/);
    assert.match(acoes, /overflow-wrap:\s*anywhere/);
});
