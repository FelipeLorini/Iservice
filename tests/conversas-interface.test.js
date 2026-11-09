'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { A, B, C, fixture, invoke } = require('./helpers/chatFixtures');
const CHAT = '3'.repeat(24), OTHER = '4'.repeat(24);
const read = file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
const flush = () => new Promise(setImmediate);
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function row(other = B, extra = {}) {
    return { id: CHAT, outro_participante: { _id: other, nome: 'Participante fictício' }, ultima_mensagem: 'Prévia fictícia',
        ultima_mensagem_data: '2026-01-01T12:00:00.000Z', nao_lidas: 2, total_mensagens: 3, ...extra };
}

function orderedRows(count) {
    return Array.from({ length: count }, (_, i) => row(B, {
        id: (900 - i * 7).toString(16).padStart(24, '0'),
        outro_participante: { _id: (100 + i).toString(16).padStart(24, '0'), nome: 'Conversa ' + (i + 1) },
        ultima_mensagem: 'Prévia ' + (i + 1), nao_lidas: i % 3,
        ultima_mensagem_data: new Date(Date.UTC(2026, 0, 10 - i)).toISOString()
    }));
}

// DOM/rede em memoria; app.js, chat.js e conversas.js reais, sem servidor ou banco.
class Node {
    constructor(tag = 'div', attrs = {}) {
        this.tag = tag; this.attrs = attrs; this.children = []; this.listeners = {}; this.disabled = false; this.hidden = false;
        this.className = attrs.class || '';
        this.classList = {
            add: (...items) => { this.className = [...new Set(this.className.split(/\s+/).concat(items))].join(' '); },
            remove: (...items) => { this.className = this.className.split(/\s+/).filter(item => !items.includes(item)).join(' '); },
            contains: name => this.className.split(/\s+/).includes(name)
        };
    }
    set textContent(value) { this.text = String(value); this.html = ''; this.children = []; }
    get textContent() { return (this.text || '') + (this.html || '').replace(/<[^>]*>/g, '') + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this.html = value; this.text = ''; this.children = []; }
    get innerHTML() { return this.html || ''; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, event = {}) { return Promise.all((this.listeners[name] || []).map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
    matches(selector) {
        if (selector.includes(' ')) return false;
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        if (selector.startsWith('[')) {
            const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
            return !!match && this.getAttribute(match[1]) !== null && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
        }
        return this.tag === selector;
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function page({ tipo = 'cliente', user = A, fetcher = () => response([row(user === B ? A : B)]), expired = false, guest = false } = {}) {
    const document = new Node('document'), events = new Node(), requests = [], redirects = [], notices = [], storage = new Map();
    const nodes = {};
    document.documentElement = new Node('html'); document.body = new Node('body');
    const html = read('dashboard-' + tipo + '.html');
    for (const name of ['minhasConversas', 'listaConversas', 'estadoConversas', 'totalConversas', 'atualizarConversas', 'tentarConversas', 'alternarConversas']) {
        assert.match(html, new RegExp('id="' + name + '"'));
        nodes[name] = new Node(['atualizarConversas', 'tentarConversas', 'alternarConversas'].includes(name) ? 'button' : 'div', { id: name });
        document.appendChild(nodes[name]);
    }
    nodes.minhasConversas.setAttribute('data-conversas-tipo', tipo);
    document.getElementById = name => nodes[name] || null;
    document.createElement = tag => new Node(tag);
    let rev = 0;
    function store(id, role = tipo, exp = Date.now() / 1000 + 3600) {
        const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        storage.set('token', `${encode({ alg: 'HS256' })}.${encode({ id, tipo: role, exp, rev: ++rev })}.assinatura`);
        storage.set('usuario', JSON.stringify({ id, tipo: role, nome: 'Conta fictícia' }));
    }
    store(user, tipo, expired ? 1 : undefined); if (guest) storage.clear();
    const location = { origin: 'https://iservice.test', pathname: '/dashboard-' + tipo + '.html',
        href: 'https://iservice.test/dashboard-' + tipo + '.html',
        replace(url) { redirects.push(url); }, reload() { redirects.push('reload'); } };
    const context = vm.createContext({ document, location, URL, URLSearchParams, Headers, Request, Response, AbortController,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        setTimeout() { return 1; }, clearTimeout() {},
        addEventListener: (event, fn) => events.addEventListener(event, fn),
        async fetch(url, options) { requests.push({ url, options }); return fetcher(url, options); }
    });
    context.window = context;
    for (const file of ['app.js', 'chat.js', 'conversas.js']) vm.runInContext(read(file), context);
    context.IS.toast = text => notices.push(text);
    return { context, nodes, requests, redirects, notices, store, storage, document,
        async mount() { await document.emit('DOMContentLoaded'); await flush(); },
        async event(name, event = {}) { await events.emit(name, event); await flush(); },
        async refresh() { await nodes.atualizarConversas.emit('click'); await flush(); },
        async retry() { await nodes.tentarConversas.emit('click'); await flush(); },
        async toggle() { await nodes.alternarConversas.emit('click'); await flush(); },
        rows() { return nodes.listaConversas.children; }
    };
}

for (const tipo of ['cliente', 'prestador']) {
    test(tipo + ': lista autenticada mostra nome, previa, data e nao lidas e abre o chat existente', async () => {
        const p = page({ tipo }); await p.mount();
        assert.equal(p.requests.length, 1); assert.equal(p.requests[0].url, '/api/chat');
        assert.equal(p.requests[0].options.method, 'GET'); assert.equal(p.requests[0].options.cache, 'no-store');
        assert.equal(p.requests[0].options.headers.Authorization, 'Bearer ' + p.storage.get('token'));
        assert.equal(p.nodes.totalConversas.textContent, '1 conversa');
        assert.equal(p.nodes.alternarConversas.hidden, true);
        assert.equal(p.nodes.listaConversas.getAttribute('aria-busy'), 'false');
        const button = p.rows()[0];
        assert.match(button.textContent, /Participante fictício/); assert.match(button.textContent, /Prévia fictícia/);
        assert.equal(button.querySelector('.badge').textContent, '2');
        assert.equal(button.querySelector('time').dateTime, '2026-01-01T12:00:00.000Z');
        assert.match(button.getAttribute('aria-label'), /2 mensagens não lidas/);
        await button.emit('click');
        assert.equal(p.context.location.href, 'chat.html?chatId=' + CHAT + '&destinatarioId=' + B + '&usuarioId=' + A);
        assert.equal(p.requests.length, 1, 'Abrir um chat existente nao pode chamar /start');
    });
    test(tipo + ': lista vazia possui estado proprio e permite atualizar', async () => {
        let data = []; const p = page({ tipo, fetcher: () => response(data) }); await p.mount();
        assert.match(p.nodes.listaConversas.textContent, /Nenhuma conversa ainda/);
        assert.equal(p.nodes.totalConversas.textContent, '0 conversas');
        assert.equal(p.nodes.alternarConversas.hidden, true);
        assert.equal(p.nodes.tentarConversas.hidden, true);
        assert.equal(p.nodes.estadoConversas.textContent, '', 'O rodape nao deve repetir o estado vazio da lista');
        assert.equal(p.nodes.atualizarConversas.disabled, false);
        data = [row()]; await p.refresh(); assert.equal(p.rows().length, 1);
    });
    test(tipo + ': recuperar uma falha com lista vazia remove retry e mantem Atualizar disponivel', async () => {
        let fail = true;
        const p = page({ tipo, fetcher: () => fail ? response({}, 503) : response([]) });
        await p.mount(); assert.equal(p.nodes.tentarConversas.hidden, false);
        fail = false; await p.retry();
        assert.equal(p.nodes.tentarConversas.hidden, true);
        assert.equal(p.nodes.atualizarConversas.disabled, false);
        assert.equal(p.nodes.estadoConversas.textContent, '');
        assert.match(p.nodes.listaConversas.textContent, /Nenhuma conversa ainda/);
        assert.doesNotMatch(p.nodes.listaConversas.textContent, /Falha|Tente novamente/);
    });
    test(tipo + ': HTML inclui painel acessivel, atalho e modulo compartilhado depois do chat', () => {
        const html = read('dashboard-' + tipo + '.html');
        assert.match(html, /href="#minhasConversas"/);
        assert.match(html, new RegExp('data-conversas-tipo="' + tipo + '" aria-labelledby="tituloConversas"'));
        assert.match(html, /id="estadoConversas"[^>]*role="status"[^>]*aria-live="polite"/);
        assert.match(html, /<button type="button"[^>]*id="alternarConversas"[^>]*aria-controls="listaConversas"[^>]*aria-expanded="false"[^>]*hidden>Ver todas as conversas<\/button>/);
        assert.equal((html.match(/id="minhasConversas"/g) || []).length, 1);
        assert.equal((html.match(/src="conversas.js"/g) || []).length, 1);
        assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="chat.js"'));
        assert.ok(html.indexOf('src="chat.js"') < html.indexOf('src="conversas.js" defer'));
    });
    for (const count of [3, 4]) test(tipo + ': ' + count + ' conversas mostram no maximo tres e contador total', async () => {
        const data = orderedRows(count);
        const p = page({ tipo, fetcher: () => response(data) }); await p.mount();
        assert.deepEqual(p.rows().map(button => button.querySelector('.row-title').textContent), data.slice(0, 3).map(item => item.outro_participante.nome));
        assert.equal(p.nodes.totalConversas.textContent, count + ' conversas');
        assert.equal(p.nodes.alternarConversas.hidden, count <= 3);
        assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false');
        assert.equal(p.nodes.alternarConversas.textContent, 'Ver todas as conversas');
        if (count === 3) { await p.toggle(); assert.equal(p.rows().length, 3); }
        assert.equal(p.requests.length, 1);
    });
    test(tipo + ': expandir e recolher preservam ordem, detalhes e destino sem chamadas extras', async () => {
        const data = orderedRows(6);
        // Empates conservam a ordem fornecida pelo backend.
        data[2].ultima_mensagem_data = data[1].ultima_mensagem_data;
        const p = page({ tipo, fetcher: () => response(data) }); await p.mount();
        assert.equal(p.rows().length, 3); assert.match(p.nodes.estadoConversas.textContent, /3 de 6/);
        await p.toggle();
        assert.equal(p.rows().length, 6); assert.equal(p.nodes.totalConversas.textContent, '6 conversas');
        assert.equal(p.nodes.alternarConversas.textContent, 'Mostrar menos');
        assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'true');
        assert.match(p.nodes.estadoConversas.textContent, /6 de 6/);
        for (const [i, button] of p.rows().entries()) {
            assert.equal(button.querySelector('.row-title').textContent, data[i].outro_participante.nome);
            assert.equal(button.querySelector('.row-sub').textContent, data[i].ultima_mensagem);
            assert.equal(button.querySelector('time').dateTime, data[i].ultima_mensagem_data);
            assert.equal(button.querySelector('.badge')?.textContent || '0', String(data[i].nao_lidas));
        }
        await p.rows()[5].emit('click');
        assert.equal(p.context.location.href, `chat.html?chatId=${data[5].id}&destinatarioId=${data[5].outro_participante._id}&usuarioId=${A}`);
        await p.toggle();
        assert.deepEqual(p.rows().map(button => button.querySelector('.row-title').textContent), data.slice(0, 3).map(item => item.outro_participante.nome));
        assert.equal(p.nodes.alternarConversas.textContent, 'Ver todas as conversas');
        assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false');
        assert.equal(p.nodes.totalConversas.textContent, '6 conversas'); assert.equal(p.requests.length, 1);
    });
    test(tipo + ': atualizacao preserva expansao na mesma sessao e usa a nova ordem da API', async () => {
        let data = orderedRows(5);
        const p = page({ tipo, fetcher: () => response(data) }); await p.mount(); await p.toggle();
        data = [{ ...data[4], ultima_mensagem_data: '2026-01-11T00:00:00.000Z' }, ...data.slice(0, 4)];
        await p.refresh(); assert.equal(p.rows().length, 5);
        assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'true');
        await p.toggle();
        assert.deepEqual(p.rows().map(button => button.querySelector('.row-title').textContent), data.slice(0, 3).map(item => item.outro_participante.nome));
        assert.equal(p.requests.length, 2);
        await p.toggle(); data = data.slice(0, 3); await p.refresh();
        assert.equal(p.nodes.alternarConversas.hidden, true); assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false');
        data = orderedRows(5); await p.refresh(); assert.equal(p.rows().length, 3);
        assert.equal(p.nodes.totalConversas.textContent, '5 conversas');
    });
}

test('expansao nao recupera dados antigos durante carregamento ou erro; retry inicia reduzido', async () => {
    const pending = deferred(); let n = 0;
    const p = page({ fetcher: () => ++n === 2 ? pending.promise : response(orderedRows(5)) });
    await p.mount(); await p.toggle(); assert.equal(p.rows().length, 5);
    const work = p.refresh();
    assert.equal(p.nodes.alternarConversas.hidden, true); assert.equal(p.nodes.alternarConversas.disabled, true);
    await p.toggle(); assert.equal(p.rows().length, 0);
    pending.resolve(response({}, 503)); await work; await p.toggle();
    assert.equal(p.rows().length, 0); assert.equal(p.nodes.tentarConversas.hidden, false);
    assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false');
    await p.retry(); assert.equal(p.rows().length, 3); assert.equal(p.nodes.alternarConversas.hidden, false);
    assert.equal(p.requests.length, 3);
});

for (const mode of ['logout', 'troca', 'storage_sem_evento']) test(mode + ': descarta lista expandida e impede reexibir conversas armazenadas', async () => {
    const p = page({ fetcher: () => response(orderedRows(5)) }); await p.mount(); await p.toggle();
    const oldButton = p.rows()[4];
    if (mode === 'logout') p.context.IS.sair();
    else { p.store(C); if (mode === 'troca') await p.event('storage', { key: 'usuario' }); }
    await p.toggle();
    assert.equal(p.nodes.listaConversas.textContent, ''); assert.equal(p.nodes.totalConversas.textContent, '');
    assert.equal(p.nodes.alternarConversas.hidden, true); assert.equal(p.nodes.alternarConversas.disabled, true);
    assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false');
    await oldButton.emit('click'); assert.match(p.context.location.href, /dashboard/);
    assert.equal(p.requests.length, 1);
});

test('resposta atrasada nao substitui os dados usados pelo botao de expansao', async () => {
    const first = deferred(), second = deferred(); let n = 0;
    const p = page({ fetcher: () => ++n === 1 ? first.promise : second.promise }); await p.mount();
    const work = p.refresh(); second.resolve(response(orderedRows(6))); await work; await p.toggle();
    first.resolve(response(orderedRows(7).map(item => ({ ...item, ultima_mensagem: 'ANTIGA' })))); await flush();
    await p.toggle(); await p.toggle();
    assert.equal(p.rows().length, 6); assert.equal(p.nodes.totalConversas.textContent, '6 conversas');
    assert.doesNotMatch(p.nodes.listaConversas.textContent, /ANTIGA/); assert.equal(p.requests.length, 2);
});

test('BFCache descarta lista expandida; retornar a pagina consulta e mostra as tres mais recentes', async () => {
    const p = page({ fetcher: () => response(orderedRows(5)) }); await p.mount(); await p.toggle();
    await p.event('pagehide'); await p.toggle(); assert.equal(p.rows().length, 0);
    assert.equal(p.nodes.alternarConversas.hidden, true);
    await p.event('pageshow', { persisted: true }); assert.equal(p.rows().length, 3);
    assert.equal(p.nodes.alternarConversas.getAttribute('aria-expanded'), 'false'); assert.equal(p.requests.length, 2);
});

test('prestador encontra dois clientes distintos, inclusive nomes Jonas Jr e Edson, sem iniciar chats', async () => {
    const p = page({ tipo: 'prestador', user: B, fetcher: () => response([
        row(A, { outro_participante: { _id: A, nome: 'Jonas Jr' } }),
        row(C, { id: OTHER, outro_participante: { _id: C, nome: 'Edson' }, nao_lidas: 1 })
    ]) }); await p.mount();
    assert.equal(p.nodes.totalConversas.textContent, '2 conversas');
    const buttons = p.rows(); assert.match(buttons[0].textContent, /Jonas Jr/); assert.match(buttons[1].textContent, /Edson/);
    await buttons[0].emit('click'); assert.equal(p.context.location.href, `chat.html?chatId=${CHAT}&destinatarioId=${A}&usuarioId=${B}`);
    await buttons[1].emit('click'); assert.equal(p.context.location.href, `chat.html?chatId=${OTHER}&destinatarioId=${C}&usuarioId=${B}`);
    assert.equal(p.requests.length, 1);
});

test('conversa sem mensagens continua acessivel com previa vazia e sem badge', async () => {
    const p = page({ fetcher: () => response([row(B, { ultima_mensagem: null, total_mensagens: 0, nao_lidas: 0 })]) }); await p.mount();
    const button = p.rows()[0]; assert.match(button.textContent, /Ainda não há mensagens/);
    assert.equal(button.querySelector('.badge'), null); await button.emit('click'); assert.match(p.context.location.href, /chatId=/);
});

test('estado de carregamento aparece antes da resposta e impede cliques em linhas antigas', async () => {
    const pending = deferred(); let slow = false;
    const p = page({ fetcher: () => slow ? pending.promise : response([row()]) }); await p.mount();
    const old = p.rows()[0]; slow = true; const work = p.refresh();
    assert.match(p.nodes.estadoConversas.textContent, /Carregando/);
    assert.equal(p.nodes.listaConversas.getAttribute('aria-busy'), 'true'); assert.equal(p.nodes.atualizarConversas.disabled, true);
    await old.emit('click'); assert.match(p.context.location.href, /dashboard/);
    pending.resolve(response([])); await work;
});

for (const mode of ['rede', 'http', 'json']) test('falha ' + mode + ' nao expoe erro interno e permite tentar novamente', async () => {
    let fail = true;
    const p = page({ fetcher: () => {
        if (!fail) return response([row()]);
        if (mode === 'rede') throw Error('SEGREDO-SINTETICO');
        if (mode === 'json') return { ok: true, status: 200, async json() { throw Error('SEGREDO-SINTETICO'); } };
        return response({ mensagem: 'SEGREDO-SINTETICO' }, 503);
    } }); await p.mount();
    assert.match(p.nodes.estadoConversas.textContent, /Falha ao carregar/);
    assert.doesNotMatch(p.nodes.listaConversas.textContent + p.nodes.estadoConversas.textContent, /SEGREDO/);
    assert.equal(p.nodes.tentarConversas.hidden, false); assert.equal(p.nodes.atualizarConversas.disabled, false);
    fail = false; await p.retry(); assert.match(p.nodes.listaConversas.textContent, /Prévia fictícia/);
    assert.equal(p.nodes.tentarConversas.hidden, true);
});

for (const [label, data] of [
    ['objeto em vez de lista', {}], ['ID invalido', [row(B, { id: 'invalido' })]],
    ['destinatario ausente', [row(B, { outro_participante: null })]],
    ['destinatario igual a sessao', [row(A)]], ['chat repetido', [row(), row()]],
    ['nao lidas negativas', [row(B, { nao_lidas: -1 })]], ['totais contraditorios', [row(B, { total_mensagens: 1 })]],
    ['conteudo objeto', [row(B, { ultima_mensagem: { content: 'NAO-EXIBIR' } })]],
    ['nome nao textual', [row(B, { outro_participante: { _id: B, nome: ['NAO-EXIBIR'] } })]]
]) test('resposta inconsistente: ' + label + ' nao produz linhas ou navegacao', async () => {
    const p = page({ fetcher: () => response(data) }); await p.mount();
    assert.equal(p.rows().length, 0); assert.equal(p.nodes.tentarConversas.hidden, false);
    assert.doesNotMatch(p.nodes.listaConversas.textContent, /NAO-EXIBIR|Prévia fictícia/);
});

test('nome, previa e rotulo usam texto literal, sem executar HTML ou atributos recebidos', async () => {
    const attack = '<img src=x onerror="alert(1)"><script>teste</script>';
    const p = page({ fetcher: () => response([row(B, { outro_participante: { _id: B, nome: attack }, ultima_mensagem: attack })]) }); await p.mount();
    const button = p.rows()[0];
    assert.equal(button.querySelector('.row-title').textContent, attack);
    assert.equal(button.querySelector('.row-sub').textContent, attack);
    assert.equal(button.querySelectorAll('img').length, 0); assert.equal(button.querySelectorAll('script').length, 0);
    assert.equal(button.getAttribute('onerror'), null); assert.ok(button.getAttribute('aria-label').includes(attack));
});

test('previa longa e data invalida nao quebram o painel', async () => {
    const p = page({ fetcher: () => response([row(B, { ultima_mensagem: 'x'.repeat(1000), ultima_mensagem_data: 'invalida' })]) }); await p.mount();
    assert.equal(p.rows()[0].querySelector('.row-sub').textContent.length, 161);
    assert.equal(p.rows()[0].querySelector('time'), null);
});

for (const mode of ['logout', 'troca', 'renovacao', 'storage_sem_evento']) test(mode + ': limpa previas, cancela consulta e ignora resposta tardia', async () => {
    const pending = deferred(); let slow = false;
    const p = page({ fetcher: () => slow ? pending.promise : response([row()]) }); await p.mount();
    const old = p.rows()[0]; slow = true; const work = p.refresh();
    if (mode === 'logout') p.context.IS.sair();
    else { p.store(mode === 'renovacao' ? A : C); if (mode !== 'storage_sem_evento') await p.event('storage', { key: 'token' }); }
    if (mode !== 'storage_sem_evento') {
        assert.equal(p.nodes.listaConversas.textContent, ''); assert.equal(p.requests[1].options.signal.aborted, true);
    }
    pending.resolve(response([row(B, { ultima_mensagem: 'RESPOSTA-ANTIGA' })])); await work;
    assert.equal(p.nodes.listaConversas.textContent, ''); assert.equal(p.nodes.totalConversas.textContent, '');
    assert.match(p.nodes.estadoConversas.textContent, /Sessão encerrada ou expirada/);
    await old.emit('click'); assert.match(p.context.location.href, /dashboard/);
    await p.retry(); assert.equal(p.requests.length, 2);
});

test('alteracao de storage sem evento impede abertura de linha ja renderizada', async () => {
    const p = page(); await p.mount(); const old = p.rows()[0]; p.store(C); await old.emit('click');
    assert.match(p.context.location.href, /dashboard/); assert.equal(p.nodes.listaConversas.textContent, '');
});

test('respostas de consultas anteriores nao substituem uma lista mais recente, mesmo ignorando abort', async () => {
    const first = deferred(), second = deferred(); let n = 0;
    const p = page({ fetcher: () => ++n === 1 ? first.promise : second.promise }); await p.mount();
    const work = p.refresh(); assert.equal(p.requests[0].options.signal.aborted, true);
    second.resolve(response([row(C, { id: OTHER, ultima_mensagem: 'ATUAL' })])); await work;
    first.resolve(response([row(B, { ultima_mensagem: 'ANTIGA' })])); await flush();
    assert.match(p.nodes.listaConversas.textContent, /ATUAL/); assert.doesNotMatch(p.nodes.listaConversas.textContent, /ANTIGA/);
    await p.rows()[0].emit('click'); assert.match(p.context.location.href, new RegExp('destinatarioId=' + C));
});

test('troca de conta enquanto json ainda e lido nao revela o corpo atrasado', async () => {
    const body = deferred(); const p = page({ fetcher: () => ({ ok: true, status: 200, json: () => body.promise }) }); await p.mount();
    p.store(C); await p.event('storage', { key: 'usuario' }); body.resolve([row()]); await flush();
    assert.equal(p.nodes.listaConversas.textContent, '');
});

test('401 real encerra sessao e limpa lista sem oferecer retry com token expirado', async () => {
    let expired = false; const p = page({ fetcher: () => response(expired ? {} : orderedRows(5), expired ? 401 : 200) }); await p.mount(); await p.toggle();
    expired = true; await p.refresh(); assert.equal(p.context.IS.logado, false);
    await p.toggle(); assert.equal(p.nodes.alternarConversas.hidden, true);
    assert.equal(p.nodes.listaConversas.textContent, ''); assert.equal(p.nodes.tentarConversas.hidden, true);
    assert.match(p.nodes.estadoConversas.textContent, /expirada/); assert.ok(p.redirects.includes('login.html'));
});

for (const mode of ['expired', 'guest']) test('sessao ' + mode + ' nao consulta API nem mostra dados', async () => {
    const p = page({ [mode]: true }); await p.mount(); assert.equal(p.requests.length, 0);
    assert.equal(p.nodes.listaConversas.textContent, ''); assert.match(p.nodes.estadoConversas.textContent, /expirada/);
});

test('sair da pagina remove conteudo privado antes do BFCache; voltar reconsulta com a mesma conta', async () => {
    let content = 'ANTES'; const p = page({ fetcher: () => response([row(B, { ultima_mensagem: content })]) }); await p.mount();
    await p.event('pagehide'); assert.equal(p.nodes.listaConversas.textContent, '');
    content = 'DEPOIS'; await p.event('pageshow', { persisted: true });
    assert.match(p.nodes.listaConversas.textContent, /DEPOIS/); assert.equal(p.requests.length, 2);
    await p.event('pagehide'); p.store(C); await p.event('pageshow', { persisted: true });
    assert.equal(p.nodes.listaConversas.textContent, ''); assert.equal(p.requests.length, 2);
});

test('voltar ao foco atualiza nao lidas; atualizar nome na mesma sessao preserva lista', async () => {
    let count = 2; const p = page({ fetcher: () => response([row(B, { nao_lidas: count })]) }); await p.mount();
    p.storage.set('usuario', JSON.stringify({ id: A, tipo: 'cliente', nome: 'Nome atualizado' }));
    await p.event('storage', { key: 'usuario' }); assert.equal(p.rows().length, 1);
    count = 0; await p.event('focus'); assert.equal(p.rows()[0].querySelector('.badge'), null); assert.equal(p.requests.length, 2);
});

test('abrir existente normaliza IDs e rejeita entradas invalidas sem consultar ou criar chats', async () => {
    const p = page(); await p.mount();
    for (const [chat, other] of [[null, B], [CHAT, A], [CHAT, 'invalido']]) assert.equal(p.context.IS.chat.abrirExistente(chat, other), false);
    assert.equal(p.requests.length, 1); assert.match(p.context.location.href, /dashboard/);
    assert.equal(p.context.IS.chat.abrirExistente(CHAT, B.toUpperCase()), true);
    assert.equal(p.context.location.href, `chat.html?chatId=${CHAT}&destinatarioId=${B}&usuarioId=${A}`);
});

test('abrir existente cancela abertura anterior por profissional e impede redirecionamento tardio', async () => {
    const pending = deferred();
    const p = page({ fetcher: url => url === '/api/chat' ? response([row(C, { id: OTHER })]) : pending.promise });
    await p.mount(); const work = p.context.IS.chat.abrir(B);
    await p.rows()[0].emit('click');
    const selected = `chat.html?chatId=${OTHER}&destinatarioId=${C}&usuarioId=${A}`;
    assert.equal(p.context.location.href, selected); assert.equal(p.requests[1].options.signal.aborted, true);
    pending.resolve(response({ chat: { _id: CHAT, participants: [A, B] } }, 201)); await work;
    assert.equal(p.context.location.href, selected);
});

test('controller real lista chats recebidos do prestador e isola dois clientes; resposta preserva o par', async () => {
    const f = fixture();
    const ab = f.add([A, B], { lastMessage: '2026-01-01T12:00:00Z', messages: [{ sender: A, receiver: B, content: 'A-B', read: false }] });
    const cb = f.add([C, B], { lastMessage: '2026-01-01T12:00:00Z', messages: [{ sender: C, receiver: B, content: 'C-B', read: false }] });
    const list = async id => (await invoke(f.api.getUserChats, { usuarioId: id })).body;
    const provider = page({ tipo: 'prestador', user: B, fetcher: async () => response(await list(B)) }); await provider.mount();
    assert.equal(provider.rows().length, 2);
    assert.equal(provider.rows()[0].querySelector('.badge').textContent, '1');
    await provider.rows()[1].emit('click'); assert.equal(provider.context.location.href, `chat.html?chatId=${cb._id}&destinatarioId=${C}&usuarioId=${B}`);
    const sent = await invoke(f.api.sendMessage, { usuarioId: B, body: { chat_id: cb._id, content: 'Resposta B-C' } });
    assert.equal(sent.code, 201); assert.equal(sent.body.message.receiver, C); assert.equal(ab.messages.length, 1);
    for (const [user, expected, absent] of [[A, 'A-B', 'Resposta B-C'], [C, 'Resposta B-C', 'A-B']]) {
        const p = page({ user, fetcher: async () => response(await list(user)) }); await p.mount();
        assert.equal(p.rows().length, 1); assert.match(p.nodes.listaConversas.textContent, new RegExp(expected));
        assert.ok(!p.nodes.listaConversas.textContent.includes(absent));
    }
    assert.equal(f.creates, 0);
});
