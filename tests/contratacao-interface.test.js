const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../site-iservice-main/dashboard-cliente.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const pedido = { _id: 'pedido-1', titulo: 'Faxina ficticia', descricao: 'Descricao', categoria: 'faxina', status: 'aberto' };
const proposta = { _id: 'proposta-1', pedido_id: pedido._id, prestador_id: { _id: 'prestador-1', nome: 'Prestador ficticio' },
  valor: 100, prazo: 'Dois dias', status: 'enviada' };

// Executa o script inline completo. Somente DOM, confirm, IS e transporte sao simulados;
// aceitarProposta, recargas e renderizacao sao as funcoes reais da pagina.
async function dashboard(options = {}) {
  const nodes = new Map(), requests = [], messages = [], confirmations = [];
  let buttons = [];
  function element(id) {
    if (!nodes.has(id)) {
      const node = { value: '', textContent: '', disabled: false, dataset: {}, listeners: {}, attrs: {}, isConnected: true,
        classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } };
      let innerHTML = '';
      Object.defineProperty(node, 'innerHTML', { get: () => innerHTML, set(value) {
        innerHTML = value;
        if (id === 'listaPedidos') {
          buttons.forEach(button => { button.isConnected = false; }); buttons = [];
          for (const key of nodes.keys()) if (key.startsWith('propostas-')) nodes.delete(key);
        }
        if (id.startsWith('propostas-')) {
          buttons.filter(button => button.parentId === id).forEach(button => { button.isConnected = false; });
          buttons = buttons.filter(button => button.parentId !== id);
          for (const match of value.matchAll(/<button\b([^>]*data-proposta-id="([^"]+)"[^>]*)>([\s\S]*?)<\/button>/g)) {
            buttons.push({ parentId: id, dataset: { propostaId: match[2] }, isConnected: true,
              disabled: /\bdisabled\b/.test(match[1]), attrs: /aria-busy="true"/.test(match[1]) ? { 'aria-busy': 'true' } : {},
              innerHTML: match[3], textContent: '', onclick: /onclick="([^"]+)"/.exec(match[1])[1],
              setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } });
          }
        }
      } });
      nodes.set(id, node);
    }
    return nodes.get(id);
  }
  const state = { pedidos: [pedido], propostas: [proposta], agendas: [], failReads: false, ...options };
  const context = vm.createContext({
    console: { error() {} }, window: {}, confirm(message) { confirmations.push(message); return state.confirm !== false; },
    document: { getElementById: element, querySelectorAll(selector) { return selector === '.btn-aceitar-proposta' ? buttons : []; } },
    IS: { exigirSessao: () => true, token: 'jwt-ficticio', usuario: { nome: 'Cliente ficticio' }, API_URL: '/api',
      esc: value => String(value), inicial: value => value[0], moeda: value => String(value),
      categoria: () => ({ nome: 'Faxina', icone: 'fa-broom' }), badge: value => value, data: value => value,
      dataTile: () => ({ dia: '20', mes: 'abr' }), vazio: () => '<div>Vazio</div>',
      toast(message, type) { messages.push({ message, type }); } },
    async fetch(url, config = {}) {
      requests.push({ url, ...config });
      if (config.method === 'PUT') return state.put ? state.put(url, config) : response(200, { mensagem: 'Proposta aceita com sucesso' });
      if (state.failReads) throw Error('Leitura indisponivel');
      if (url === '/api/pedidos/cliente') return response(200, state.pedidos);
      if (url === '/api/propostas/pedido/pedido-1') return response(200, state.propostas);
      if (url === '/api/agendamentos/cliente') return response(200, state.agendas);
      if (url === '/api/avaliacoes/cliente') return response(200, { total: 0, agendamentos_avaliados: [] });
      throw Error('URL nao prevista: ' + url);
    }
  });
  context.window = context;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (script[1].trim()) vm.runInContext(script[1], context);
  }
  await flush();
  assert.equal(buttons.length, 1, 'Botao deve vir do HTML produzido pela funcao real');
  requests.length = 0;
  return { state, requests, messages, confirmations, element, buttons: () => buttons,
    click(button = buttons[0]) {
      context.clickedButton = button;
      return vm.runInContext('(function () { return ' + button.onclick + '; }).call(clickedButton)', context);
    }
  };
}
function assertReads(page) {
  for (const url of ['/api/pedidos/cliente', '/api/agendamentos/cliente']) assert.ok(page.requests.some(r => r.url === url && !r.method), url);
  assert.equal(page.requests.filter(r => r.method === 'PUT').length, 1);
}
for (const mensagem of ['Proposta aceita com sucesso', 'Contratacao existente recuperada com sucesso']) {
  test(`200 usa mensagem da API antiga/nova: ${mensagem}`, async () => {
    const page = await dashboard({ put: async () => response(200, { mensagem }) });
    await page.click();
    assert.deepEqual(page.messages, [{ message: mensagem, type: undefined }]);
    assert.equal(page.element('estadoAceitacao').textContent, mensagem);
    assertReads(page);
    assert.doesNotMatch(page.confirmations[0], /agendamento.*criado/i);
    assert.deepEqual(JSON.parse(JSON.stringify(page.requests[0])), { url: '/api/propostas/proposta-1/aceitar', method: 'PUT', headers: { Authorization: 'Bearer jwt-ficticio' } });
    assert.equal(page.buttons().length, 0, 'Uma aceitacao confirmada nao oferece nova submissao');
  });
}
for (const mensagem of [undefined, '', '   ', { detalhe: 'nao e texto' }]) {
  test(`200 com mensagem inadequada usa fallback neutro: ${JSON.stringify(mensagem)}`, async () => {
    const page = await dashboard({ put: async () => response(200, { mensagem }) });
    await page.click();
    assert.equal(page.messages[0].message, 'Aceitação confirmada. Consulte seus pedidos e agendamentos.');
    assertReads(page);
  });
}
for (const mensagem of ['Outra proposta ja foi aceita para este pedido', undefined]) {
  test(`409 informa conflito, nunca sucesso, e atualiza GETs: ${mensagem}`, async () => {
    const page = await dashboard({ put: async () => response(409, { mensagem }) });
    await page.click();
    assert.deepEqual(page.messages, [{ message: mensagem || 'Erro ao aceitar proposta.', type: 'error' }]);
    assertReads(page); assert.equal(page.buttons()[0].disabled, false);
  });
}
for (const kind of ['503', 'rede', '503 sem JSON', '200 com corpo interrompido']) {
  test(`${kind}: mantem incerteza mesmo se leituras falham e nao repete PUT`, async () => {
    const page = await dashboard();
    page.state.put = async () => {
      page.state.failReads = true;
      if (kind === 'rede') throw Error('Conexao perdida depois do envio');
      return kind === '503' ? response(503, { mensagem: 'Nao foi possivel confirmar' }) :
        { ok: kind === '200 com corpo interrompido', status: kind === '200 com corpo interrompido' ? 200 : 503,
          async json() { throw Error('JSON ausente'); } };
    };
    await page.click();
    assert.equal(page.messages.length, 1); assert.equal(page.messages[0].type, 'error');
    assert.match(page.messages[0].message, /Não foi possível confirmar o resultado/);
    assert.doesNotMatch(page.messages[0].message, /revertid|efetuad|criado/);
    assert.equal(page.element('estadoAceitacao').textContent, page.messages[0].message);
    assertReads(page); assert.equal(page.buttons()[0].disabled, false);
    assert.equal(page.buttons()[0].attrs['aria-busy'], undefined);
  });
}
test('503 consulta estado, renderiza pedido atualizado e mantem aviso sem inferir sucesso', async () => {
  const page = await dashboard();
  page.state.put = async () => {
    page.state.pedidos = [{ ...pedido, status: 'em andamento' }];
    return response(503, {});
  };
  await page.click();
  assert.equal(page.buttons().length, 0);
  assert.match(page.element('listaPedidos').innerHTML, /em andamento/);
  assert.match(page.element('estadoAceitacao').textContent, /Não foi possível confirmar/);
  assertReads(page);
});
test('dois cliques rapidos geram um PUT; botao e aria-busy restaurados apos recarregar', async () => {
  const gate = deferred(), page = await dashboard({ put: () => gate.promise });
  const button = page.buttons()[0], first = page.click(button);
  assert.equal(button.disabled, true); assert.equal(button.attrs['aria-busy'], 'true');
  assert.equal(button.textContent, 'Aguarde…');
  await page.click(button); // Mesmo invocando o handler diretamente, Set impede duplicacao.
  assert.equal(page.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(page.confirmations.length, 1);
  gate.resolve(response(409, { mensagem: 'Conflito' })); await first;
  assert.equal(button.isConnected, false);
  assert.equal(page.buttons()[0].disabled, false); assert.equal(page.buttons()[0].attrs['aria-busy'], undefined);
  // Uma nova interacao deliberada e possivel; nao e retry automatico.
  page.state.put = async () => response(200, { mensagem: 'Contratacao existente recuperada com sucesso' });
  await page.click(); assert.equal(page.requests.filter(r => r.method === 'PUT').length, 2);
});
test('sucesso nao vira erro nem reabilita botao obsoleto se uma leitura posterior falha', async () => {
  const page = await dashboard();
  const button = page.buttons()[0];
  page.state.put = async () => { page.state.failReads = true; return response(200, { mensagem: 'Proposta aceita com sucesso' }); };
  await page.click();
  assert.deepEqual(page.messages, [{ message: 'Proposta aceita com sucesso', type: undefined }]);
  assertReads(page); assert.equal(button.disabled, true);
  assert.equal(button.attrs['aria-busy'], undefined); assert.equal(button.textContent, 'Aceitação confirmada');
  await page.click(button);
  assert.equal(page.requests.filter(r => r.method === 'PUT').length, 1);
});
test('cancelar confirmacao nao escreve nem bloqueia controle', async () => {
  const page = await dashboard({ confirm: false }); await page.click();
  assert.equal(page.requests.length, 0); assert.equal(page.messages.length, 0); assert.equal(page.buttons()[0].disabled, false);
});
test('erro HTTP definido preserva mensagem, desbloqueia e nao e convertido em sucesso', async () => {
  const page = await dashboard({ put: async () => response(403, { mensagem: 'Sem permissao' }) }); await page.click();
  assert.deepEqual(page.messages, [{ message: 'Sem permissao', type: 'error' }]);
  assert.equal(page.requests.length, 1); assert.equal(page.buttons()[0].disabled, false);
});
test('feedback persistente possui regiao acessivel fora da lista substituida', () => {
  assert.match(html, /<p id="estadoAceitacao"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="estadoAceitacao"') < html.indexOf('id="listaPedidos"'));
});
