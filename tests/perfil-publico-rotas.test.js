const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const root = path.join(__dirname, '..');
const secret = 'chave-sintetica-exclusiva-perfil';
const ID = 'abcdef0123456789abcdef01';
const CONTA = '1'.repeat(24);
const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const PRIVADO = 'MARCADOR-PRIVADO-SINTETICO';
const urlPerfil = id => `/api/usuario/${id}/perfil`;
const plain = value => JSON.parse(JSON.stringify(value));
const perfilPublico = {
  id: ID, nome: 'Profissional ficticio', tipo: 'prestador',
  descricao_detalhada: 'Descricao publica', portifolio: ['https://example.invalid/foto.jpg'], online: true
};
const documento = {
  _id: ID, nome: perfilPublico.nome, tipo: 'prestador',
  descricao_detalhada: perfilPublico.descricao_detalhada, portifolio: perfilPublico.portifolio,
  ultimo_login: new Date(NOW - 60000), email: PRIVADO, telefone: PRIVADO, senha: PRIVADO,
  hash: PRIVADO, token: PRIVADO, resetPasswordToken: PRIVADO, campo_futuro: PRIVADO, __v: 9
};

async function fixture(t, { usuario = documento, failure } = {}) {
  const queries = [], dispatches = [], faqQueries = [];
  const Usuario = {
    findById(id) {
      const query = { id, select: null };
      queries.push(query);
      if (failure === 'findById') throw new Error(PRIVADO);
      return { async select(fields) {
        query.select = fields;
        if (failure === 'select') throw new Error(PRIVADO);
        // Campos extras permanecem no documento para verificar a resposta explicita.
        return usuario;
      } };
    }
  };
  class PerfilDate extends Date { static now() { return NOW; } }
  const controllers = controllerStubs(dispatches);
  controllers.usuarioController = {
    ...loadController('controllers/usuarioController.js', {
      '../Models/usuarioModel': Usuario
    }, { secret, clock: PerfilDate }),
    // O PUT continua verificando somente encaminhamento e protecoes.
    atualizarPortifolio: controllers.usuarioController.atualizarPortifolio
  };
  controllers.faqController = loadController('controllers/faqController.js', { '../Models/faqModel': {
    find() { return { async sort(order) { faqQueries.push(plain(order)); return []; } }; }
  } }, { secret });
  const { request, headers } = await startHttp(t, { controllers, secret, usuarioId: CONTA });
  return { request, queries, dispatches, faqQueries, headers };
}

function assertJson(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

for (const [label, headers] of [
  ['sem token', {}], ['com token invalido', { Authorization: 'Bearer invalido' }]
]) test(`perfil publico ${label}: contrato exato e ausencia de campos privados`, async t => {
  const f = await fixture(t);
  const res = await f.request('GET', urlPerfil(ID), headers);
  assertJson(res, 200, perfilPublico);
  assert.ok(!res.text.includes(PRIVADO));
  assert.deepEqual(f.queries, [{ id: ID, select: 'nome tipo descricao_detalhada portifolio ultimo_login' }]);
  assert.deepEqual(f.dispatches, []);
});

for (const id of [ID.toUpperCase(), '2'.repeat(24)]) {
  test(`parametro id chega intacto ao modelo: ${id}`, async t => {
    const f = await fixture(t, { usuario: { ...documento, _id: id.toLowerCase() } });
    const res = await f.request('GET', urlPerfil(id) + '?id=ignorado', f.headers('cliente'));
    assertJson(res, 200, { ...perfilPublico, id: id.toLowerCase() });
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0].id, id);
    assert.notEqual(f.queries[0].id, CONTA);
  });
}

for (const id of ['invalido', 'a'.repeat(23), 'a'.repeat(25), 'g'.repeat(24), '%20', '%24ne']) {
  test(`ID invalido ${id} retorna 400 sem consultar Usuario`, async t => {
    const f = await fixture(t);
    assertJson(await f.request('GET', urlPerfil(id)), 400, { mensagem: 'Informe um usuario valido' });
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.dispatches, []);
  });
}

for (const [label, usuario] of [['ausente', null], ['cliente', { ...documento, tipo: 'cliente' }]]) {
  test(`usuario ${label} retorna o mesmo contrato 404`, async t => {
    const f = await fixture(t, { usuario });
    assertJson(await f.request('GET', urlPerfil(ID)), 404, { mensagem: 'Usuario nao encontrado' });
    assert.equal(f.queries.length, 1);
  });
}

for (const failure of ['findById', 'select']) {
  test(`falha em ${failure} retorna 500 sanitizado`, async t => {
    const f = await fixture(t, { failure });
    const res = await f.request('GET', urlPerfil(ID));
    assertJson(res, 500, { mensagem: 'Erro ao obter perfil' });
    assert.ok(!res.text.includes(PRIVADO));
    assert.equal(f.queries.length, 1);
  });
}

for (const [label, ultimo_login, online] of [
  ['ausente', undefined, false], ['nulo', null, false], ['data invalida', 'data-invalida', false],
  ['agora', new Date(NOW), true], ['antes do limite', new Date(NOW - 299999), true],
  ['exatamente cinco minutos', new Date(NOW - 300000), false],
  ['mais de cinco minutos', new Date(NOW - 300001).toISOString(), false],
  // Caracteriza a comparacao atual, que tambem considera datas futuras online.
  ['data futura', new Date(NOW + 60000), true]
]) test(`online com relogio fixo: ${label}`, async t => {
  const f = await fixture(t, { usuario: { ...documento, ultimo_login } });
  assertJson(await f.request('GET', urlPerfil(ID)), 200, { ...perfilPublico, online });
});

test('descricao e portifolio ausentes preservam os valores padrao publicos', async t => {
  const f = await fixture(t, { usuario: { ...documento, descricao_detalhada: undefined, portifolio: undefined } });
  assertJson(await f.request('GET', urlPerfil(ID)), 200, { ...perfilPublico, descricao_detalhada: '', portifolio: [] });
});

test('GET com barra final preserva o perfil publico', async t => {
  const f = await fixture(t);
  assertJson(await f.request('GET', urlPerfil(ID) + '/', { Authorization: 'Bearer invalido' }), 200, perfilPublico);
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].id, ID);
});

for (const suffix of ['', '/']) {
  test(`HEAD do perfil${suffix ? ' com barra final' : ''} preserva headers e omite corpo`, async t => {
    const f = await fixture(t);
    const url = urlPerfil(ID) + suffix;
    const get = await f.request('GET', url);
    const head = await f.request('HEAD', url, { Authorization: 'Bearer invalido' });
    assertJson(get, 200, perfilPublico);
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.text)));
    assert.equal(head.headers.etag, get.headers.etag);
    assert.equal(f.queries.length, 2);
  });
  test(`OPTIONS do perfil${suffix ? ' com barra final' : ''} e atendido pelo CORS`, async t => {
    const f = await fixture(t);
    for (const headers of [{}, { Origin: 'https://example.invalid',
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
      Authorization: 'Bearer invalido' }]) {
      const res = await f.request('OPTIONS', urlPerfil(ID) + suffix, headers);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.equal(res.headers['content-length'], '0');
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.equal(res.headers['access-control-allow-methods'], 'GET,HEAD,PUT,PATCH,POST,DELETE');
      assert.equal(res.headers.allow, undefined);
      if (headers.Origin) assert.equal(res.headers['access-control-allow-headers'], 'authorization');
    }
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.dispatches, []);
  });
}

test('metodos nao registrados e caminhos semelhantes nao executam consulta ou outros handlers', async t => {
  const f = await fixture(t);
  const requests = ['POST', 'PUT', 'PATCH', 'DELETE'].map(method => [method, urlPerfil(ID)]);
  requests.push(...[
    '/api/usuario//perfil', `/api/usuario/${ID}`, urlPerfil(ID) + '/extra',
    urlPerfil(ID) + 'x', `/api/usuarios/${ID}/perfil`, `/usuario/${ID}/perfil`, '/api/usuario/portifolio'
  ].map(url => ['GET', url]));
  for (const [method, url] of requests) {
    assert.equal((await f.request(method, url)).status, 404, `${method} ${url}`);
  }
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});

for (const [label, tipo, status, mensagem] of [
  ['sem token', null, 401, 'Acesso negado. Token nao fornecido'],
  ['token invalido', 'invalido', 401, 'Token invalido ou expirado'],
  ['cliente', 'cliente', 403, 'Acesso negado. Apenas prestadores podem realizar esta acao']
]) test(`PUT portifolio permanece protegido: ${label}`, async t => {
  const f = await fixture(t);
  const headers = tipo === 'invalido' ? { Authorization: 'Bearer invalido' } : tipo ? f.headers(tipo) : {};
  assertJson(await f.request('PUT', '/api/usuario/portifolio', headers), status, { mensagem });
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});

// Matriz independente das declaracoes de producao: detecta mudanca de URL/handler.
// Outros controllers sao sentinelas; verifica encaminhamento, nao suas respostas de negocio.
const outrosEndpoints = [
  ['POST', '/cadastro', 'CadastroController.cadastrar'],
  ['POST', '/login', 'LoginController.login'],
  ['GET', '/servicos', 'ServicoController.listarServicos'],
  ['GET', '/servicos/categoria/faxina', 'ServicoController.listarServicosPorCategoria'],
  ['POST', '/servicos', 'ServicoController.cadastrarServico', 'prestador'],
  ['GET', '/servicos/prestador', 'ServicoController.listarServicosPorPrestador', 'prestador'],
  ['DELETE', '/servicos/id-ficticio', 'ServicoController.deletarServico', 'prestador'],
  ['POST', '/agendamentos', 'agendamentoController.agendarServico', 'cliente'],
  ['GET', '/agendamentos/cliente', 'agendamentoController.listarAgendamentosCliente', 'cliente'],
  ['GET', '/agendamentos/prestador', 'agendamentoController.listarAgendamentosPrestador', 'prestador'],
  ['PUT', '/agendamentos/id-ficticio/status', 'agendamentoController.atualizarStatusAgendamento', 'prestador'],
  ['PUT', '/agendamentos/id-ficticio/cancelar', 'agendamentoController.cancelarAgendamento', 'cliente'],
  ['POST', '/avaliacoes', 'avaliacaoController.criarAvaliacao', 'cliente'],
  ['GET', '/avaliacoes/cliente', 'avaliacaoController.listarAvaliacoesCliente', 'cliente'],
  ['GET', '/avaliacoes/prestador/id-ficticio', 'avaliacaoController.listarAvaliacoesPorPrestador'],
  ['GET', '/avaliacoes/prestador/id-ficticio/media', 'avaliacaoController.calcularMedia'],
  ['POST', '/pedidos', 'pedidoController.criarPedido', 'cliente'],
  ['GET', '/pedidos/cliente', 'pedidoController.listarPedidosCliente', 'cliente'],
  ['GET', '/pedidos/abertos', 'pedidoController.listarPedidosAbertos', 'prestador'],
  ['PUT', '/pedidos/id-ficticio/cancelar', 'pedidoController.cancelarPedido', 'cliente'],
  ['POST', '/propostas', 'propostaController.criarProposta', 'prestador'],
  ['GET', '/propostas/pedido/id-ficticio', 'propostaController.listarPropostas', 'cliente'],
  ['GET', '/propostas/prestador', 'propostaController.listarPropostasPrestador', 'prestador'],
  ['PUT', '/propostas/id-ficticio/aceitar', 'propostaController.aceitarProposta', 'cliente'],
  ['GET', '/notificacoes', 'notificacaoController.listarNotificacoes', 'cliente'],
  ['PUT', '/notificacoes/id-ficticio/lida', 'notificacaoController.marcarComoLida', 'cliente'],
  ['GET', '/notificacoes/nao-lidas', 'notificacaoController.contarNaoLidas', 'cliente'],
  ['POST', '/favoritos', 'favoritoController.adicionarFavorito', 'cliente'],
  ['DELETE', '/favoritos/id-ficticio', 'favoritoController.removerFavorito', 'cliente'],
  ['GET', '/favoritos', 'favoritoController.listarFavoritos', 'cliente'],
  ['GET', '/favoritos/verificar/id-ficticio', 'favoritoController.verificarFavorito', 'cliente'],
  ['PUT', '/usuario/portifolio', 'usuarioController.atualizarPortifolio', 'prestador'],
  ['POST', '/chat/start', 'chatController.startChat', 'cliente'],
  ['POST', '/chat/message', 'chatController.sendMessage', 'cliente'],
  ['GET', '/chat/unread/count', 'chatController.getUnreadCount', 'cliente'],
  ['GET', '/chat', 'chatController.getUserChats', 'cliente'],
  ['PUT', '/chat/id-ficticio/read', 'chatController.markAsRead', 'cliente'],
  ['GET', '/chat/id-ficticio', 'chatController.getChatMessages', 'cliente']
];

test('perfil nao intercepta os demais 38 endpoints nem a FAQ', async t => {
  const f = await fixture(t);
  for (const [method, url, handler, tipo] of outrosEndpoints) {
    const res = await f.request(method, '/api' + url, tipo ? f.headers(tipo) : {});
    assert.equal(res.status, 200, `${method} ${url}`);
    const body = JSON.parse(res.text);
    assert.equal(body.handler, handler, url);
    if (tipo) assert.equal(body.usuarioId, CONTA, url);
    if (url.startsWith('/chat')) assert.equal(res.headers['cache-control'], 'no-store', url);
  }
  assertJson(await f.request('GET', '/api/faq', { Authorization: 'Bearer invalido' }), 200, []);
  assert.deepEqual(f.faqQueries, [{ categoria: 1, ordem: 1 }]);
  assert.equal(f.dispatches.length, outrosEndpoints.length);
  assert.deepEqual(f.queries, []);
});

test('chat continua exigindo token no caminho publico original', async t => {
  const f = await fixture(t);
  assertJson(await f.request('GET', '/api/chat'), 401, { mensagem: 'Token nao fornecido' });
  assertJson(await f.request('GET', '/api/chat', { Authorization: 'Bearer invalido' }), 401, { mensagem: 'Token invalido' });
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});

test('paginas e script estaticos preservam caminhos e conteudo', async t => {
  const f = await fixture(t);
  for (const [url, file] of [['/', 'index.html'], ['/faq.html', 'faq.html'],
    ['/perfil_prestador.html', 'perfil_prestador.html'], ['/favoritos.js', 'favoritos.js']]) {
    const res = await f.request('GET', url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers['content-type'], file.endsWith('.html') ? /^text\/html\b/ : /javascript\b/);
    assert.equal(res.text, fs.readFileSync(path.join(root, 'public', file), 'utf8'));
  }
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
  assert.deepEqual(f.faqQueries, []);
});
