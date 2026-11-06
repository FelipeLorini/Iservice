const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const root = path.join(__dirname, '..');
const secret = 'chave-sintetica-exclusiva-catalogo';
const CONTA = 'a'.repeat(24), ID = '1'.repeat(24), OUTRO = 'b'.repeat(24);
const PRIVADO = 'MARCADOR-PRIVADO-SINTETICO';
const plain = value => JSON.parse(JSON.stringify(value));
const publico = {
  _id: ID, nome: 'Limpeza ficticia', descricao: 'Descricao publica', preco: 150,
  categoria: 'faxina', data_criacao: '2026-01-01T00:00:00.000Z',
  prestador_id: { _id: CONTA, nome: 'Profissional ficticio' }
};
const documento = {
  ...publico, email: PRIVADO, telefone: PRIVADO, campo_futuro: PRIVADO, __v: 7,
  prestador_id: { ...publico.prestador_id, email: PRIVADO, telefone: PRIVADO,
    senha: PRIVADO, token: PRIVADO, campo_futuro: PRIVADO }
};
const registros = [{ ...documento, _id: '2'.repeat(24), nome: 'Segundo' }, documento];
const respostaPublica = [{ ...publico, _id: '2'.repeat(24), nome: 'Segundo' }, publico];

async function fixture(t, { rows = registros, failure, owner = CONTA, missing = false } = {}) {
  const queries = [], writes = [], dispatches = [];
  const Servico = {
    find(...args) {
      const query = { args: plain(args) };
      queries.push(query);
      if (failure === 'find') throw Error(PRIVADO);
      if (args[0]?.prestador_id) return Promise.resolve(rows);
      return { async populate(...fields) {
        query.populate = fields;
        if (failure === 'populate') throw Error(PRIVADO);
        return rows;
      } };
    },
    async create(data) { writes.push({ create: plain(data) }); return { _id: ID, ...data }; },
    async findById(id) {
      queries.push({ findById: id });
      return missing ? null : { prestador_id: owner,
        async deleteOne() { writes.push({ deleteOne: id }); } };
    }
  };
  const controllers = controllerStubs(dispatches);
  controllers.ServicoController = loadController('controllers/ServicoController.js', {
    '../Models/servicoModel': Servico
  }, { secret });
  const { request, headers } = await startHttp(t, { controllers, secret, usuarioId: CONTA });
  return { request, queries, writes, dispatches, headers };
}

function assertJson(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

const consultas = [
  ['/api/servicos', []], ['/api/servicos/categoria/faxina', [{ categoria: 'faxina' }]]
];
for (const [url, args] of consultas) {
  for (const [label, headers] of [['sem token', {}], ['token invalido', { Authorization: 'Bearer invalido' }]]) {
    test(`${url}: ${label}, projecao publica exata e sequencia preservada`, async t => {
      const f = await fixture(t);
      const res = await f.request('GET', url, headers);
      assertJson(res, 200, respostaPublica);
      assert.ok(!res.text.includes(PRIVADO));
      assert.deepEqual(f.queries, [{ args, populate: ['prestador_id', 'nome'] }]);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.dispatches, []);
    });
  }
  test(`${url}: colecao vazia retorna 200 e []`, async t => {
    const f = await fixture(t, { rows: [] });
    assertJson(await f.request('GET', url), 200, []);
    assert.deepEqual(f.queries, [{ args, populate: ['prestador_id', 'nome'] }]);
  });
  test(`${url}: prestador removido ou ausente fica null sem eliminar servico`, async t => {
    const f = await fixture(t, { rows: [null, undefined].map(prestador_id => ({ ...documento, prestador_id })) });
    assertJson(await f.request('GET', url), 200, [
      { ...publico, prestador_id: null }, { ...publico, prestador_id: null }
    ]);
  });
  for (const failure of ['find', 'populate']) test(`${url}: falha ${failure} sanitizada`, async t => {
    const f = await fixture(t, { failure });
    assertJson(await f.request('GET', url), 500, { mensagem: 'Erro ao listar servicos' });
    assert.deepEqual(f.queries, [failure === 'find' ? { args } : { args, populate: ['prestador_id', 'nome'] }]);
    assert.deepEqual(f.writes, []);
  });
  test(`${url}: barra final preserva consulta e resposta`, async t => {
    const f = await fixture(t);
    assertJson(await f.request('GET', url + '/', { Authorization: 'Bearer invalido' }), 200, respostaPublica);
    assert.deepEqual(f.queries, [{ args, populate: ['prestador_id', 'nome'] }]);
  });
  for (const suffix of ['', '/']) {
    test(`HEAD ${url}${suffix}: headers de GET e corpo vazio`, async t => {
      const f = await fixture(t);
      const get = await f.request('GET', url + suffix);
      const head = await f.request('HEAD', url + suffix, { Authorization: 'Bearer invalido' });
      assertJson(get, 200, respostaPublica);
      assert.equal(head.status, 200);
      assert.equal(head.text, '');
      assert.equal(head.headers['content-type'], get.headers['content-type']);
      assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.text)));
      assert.equal(head.headers.etag, get.headers.etag);
      assert.deepEqual(f.queries, Array(2).fill({ args, populate: ['prestador_id', 'nome'] }));
    });
    test(`OPTIONS ${url}${suffix}: CORS responde sem consultar o modelo`, async t => {
      const f = await fixture(t);
      for (const headers of [{}, { Origin: 'https://example.invalid',
        'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
        Authorization: 'Bearer invalido' }]) {
        const res = await f.request('OPTIONS', url + suffix, headers);
        assert.equal(res.status, 204);
        assert.equal(res.text, '');
        assert.equal(res.headers['content-length'], '0');
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.equal(res.headers['access-control-allow-methods'], 'GET,HEAD,PUT,PATCH,POST,DELETE');
        assert.equal(res.headers.allow, undefined);
        if (headers.Origin) assert.equal(res.headers['access-control-allow-headers'], 'authorization');
      }
      assert.deepEqual(f.queries, []);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.dispatches, []);
    });
  }
}

for (const categoria of ['FAXINA', 'categoria-inexistente', 'limpeza geral', 'faxina/especial']) {
  test(`categoria ${categoria}: parametro decodificado sem normalizacao ou validacao adicional`, async t => {
    const f = await fixture(t, { rows: [] });
    assertJson(await f.request('GET', '/api/servicos/categoria/' + encodeURIComponent(categoria) + '?categoria=ignorada'), 200, []);
    assert.deepEqual(f.queries, [{ args: [{ categoria }], populate: ['prestador_id', 'nome'] }]);
  });
}

test('catalogo geral nao converte query string em filtro de categoria', async t => {
  const f = await fixture(t);
  assertJson(await f.request('GET', '/api/servicos?categoria=faxina'), 200, respostaPublica);
  assert.deepEqual(f.queries, [{ args: [], populate: ['prestador_id', 'nome'] }]);
});

test('metodos nao registrados e caminhos semelhantes continuam 404', async t => {
  const f = await fixture(t);
  for (const [method, url] of [
    ['PUT', '/api/servicos'], ['PATCH', '/api/servicos'], ['DELETE', '/api/servicos'],
    ['POST', '/api/servicos/categoria/faxina'], ['PUT', '/api/servicos/categoria/faxina'],
    ['PATCH', '/api/servicos/categoria/faxina'], ['DELETE', '/api/servicos/categoria/faxina'],
    ['GET', '/api/servicos/categoria'], ['GET', '/api/servicos/categoria/'],
    ['GET', '/api/servicos/categoria/faxina/extra'], ['GET', '/api/servicosx'], ['GET', '/servicos']
  ]) assert.equal((await f.request(method, url)).status, 404, `${method} ${url}`);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.dispatches, []);
});

for (const [method, url] of [['POST', '/api/servicos'], ['GET', '/api/servicos/prestador'], ['DELETE', '/api/servicos/' + ID]]) {
  for (const [tipo, status, mensagem] of [
    [null, 401, 'Acesso negado. Token nao fornecido'],
    ['invalido', 401, 'Token invalido ou expirado'],
    ['cliente', 403, 'Acesso negado. Apenas prestadores podem realizar esta acao']
  ]) test(`${method} ${url}: bloqueia ${tipo || 'sem token'} antes do modelo`, async t => {
    const f = await fixture(t);
    const headers = tipo === 'invalido' ? { Authorization: 'Bearer invalido' } : tipo ? f.headers(tipo) : {};
    assertJson(await f.request(method, url, headers), status, { mensagem });
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.dispatches, []);
  });
}

test('GET prestador autenticado consulta somente a propria conta e preserva resposta privada', async t => {
  const f = await fixture(t);
  assertJson(await f.request('GET', '/api/servicos/prestador?prestador_id=' + OUTRO, f.headers('prestador')), 200, registros);
  assert.deepEqual(f.queries, [{ args: [{ prestador_id: CONTA }] }]);
  assert.deepEqual(f.writes, []);
});

test('POST autenticado mantem 201 e deriva propriedade do JWT, nao do corpo', async t => {
  const f = await fixture(t);
  const input = { nome: 'Servico', descricao: 'Descricao', preco: 10, categoria: 'faxina' };
  const data = { ...input, prestador_id: CONTA };
  assertJson(await f.request('POST', '/api/servicos', f.headers('prestador'), { ...input, prestador_id: OUTRO }),
    201, { mensagem: 'Servico cadastrado com sucesso', servico: { _id: ID, ...data } });
  assert.deepEqual(f.writes, [{ create: data }]);
  assert.deepEqual(f.queries, []);
});

for (const [label, options, status, mensagem] of [
  ['proprio', {}, 200, 'Servico deletado com sucesso'],
  ['de outra conta', { owner: OUTRO }, 403, 'Voce nao tem permissao para deletar este servico'],
  ['ausente', { missing: true }, 404, 'Servico nao encontrado']
]) test(`DELETE autenticado de servico ${label} preserva propriedade e contrato`, async t => {
  const f = await fixture(t, options);
  assertJson(await f.request('DELETE', '/api/servicos/' + ID, f.headers('prestador')), status, { mensagem });
  assert.deepEqual(f.queries, [{ findById: ID }]);
  assert.deepEqual(f.writes, status === 200 ? [{ deleteOne: ID }] : []);
});

// Matriz independente das declaracoes de producao. Outros controllers sao
// sentinelas apenas para encaminhamento; todos os handlers de Servico sao reais.
const outrasRotas = [
  ['POST', '/cadastro', 'CadastroController.cadastrar'],
  ['POST', '/login', 'LoginController.login'],
  ['POST', '/agendamentos', 'agendamentoController.agendarServico', 'cliente'],
  ['GET', '/agendamentos/cliente', 'agendamentoController.listarAgendamentosCliente', 'cliente'],
  ['GET', '/agendamentos/prestador', 'agendamentoController.listarAgendamentosPrestador', 'prestador'],
  ['PUT', '/agendamentos/id/status', 'agendamentoController.atualizarStatusAgendamento', 'prestador'],
  ['PUT', '/agendamentos/id/cancelar', 'agendamentoController.cancelarAgendamento', 'cliente'],
  ['POST', '/avaliacoes', 'avaliacaoController.criarAvaliacao', 'cliente'],
  ['GET', '/avaliacoes/cliente', 'avaliacaoController.listarAvaliacoesCliente', 'cliente'],
  ['GET', '/avaliacoes/prestador/id', 'avaliacaoController.listarAvaliacoesPorPrestador'],
  ['GET', '/avaliacoes/prestador/id/media', 'avaliacaoController.calcularMedia'],
  ['POST', '/pedidos', 'pedidoController.criarPedido', 'cliente'],
  ['GET', '/pedidos/cliente', 'pedidoController.listarPedidosCliente', 'cliente'],
  ['GET', '/pedidos/abertos', 'pedidoController.listarPedidosAbertos', 'prestador'],
  ['PUT', '/pedidos/id/cancelar', 'pedidoController.cancelarPedido', 'cliente'],
  ['POST', '/propostas', 'propostaController.criarProposta', 'prestador'],
  ['GET', '/propostas/pedido/id', 'propostaController.listarPropostas', 'cliente'],
  ['GET', '/propostas/prestador', 'propostaController.listarPropostasPrestador', 'prestador'],
  ['PUT', '/propostas/id/aceitar', 'propostaController.aceitarProposta', 'cliente'],
  ['GET', '/notificacoes', 'notificacaoController.listarNotificacoes', 'cliente'],
  ['PUT', '/notificacoes/id/lida', 'notificacaoController.marcarComoLida', 'cliente'],
  ['GET', '/notificacoes/nao-lidas', 'notificacaoController.contarNaoLidas', 'cliente'],
  ['POST', '/favoritos', 'favoritoController.adicionarFavorito', 'cliente'],
  ['DELETE', '/favoritos/id', 'favoritoController.removerFavorito', 'cliente'],
  ['GET', '/favoritos', 'favoritoController.listarFavoritos', 'cliente'],
  ['GET', '/favoritos/verificar/id', 'favoritoController.verificarFavorito', 'cliente'],
  ['GET', '/faq', 'faqController.listarFaqs'],
  ['GET', '/usuario/id/perfil', 'usuarioController.obterPerfilPublico'],
  ['PUT', '/usuario/portifolio', 'usuarioController.atualizarPortifolio', 'prestador'],
  ['POST', '/chat/start', 'chatController.startChat', 'cliente'],
  ['POST', '/chat/message', 'chatController.sendMessage', 'cliente'],
  ['GET', '/chat/unread/count', 'chatController.getUnreadCount', 'cliente'],
  ['GET', '/chat', 'chatController.getUserChats', 'cliente'],
  ['PUT', '/chat/id/read', 'chatController.markAsRead', 'cliente'],
  ['GET', '/chat/id', 'chatController.getChatMessages', 'cliente']
];

test('catalogo nao interfere nos outros 35 endpoints, incluindo FAQ, perfil e chat', async t => {
  const f = await fixture(t);
  for (const [method, url, handler, tipo] of outrasRotas) {
    const res = await f.request(method, '/api' + url, tipo ? f.headers(tipo) : {});
    assert.equal(res.status, 200, `${method} ${url}`);
    const body = JSON.parse(res.text);
    assert.equal(body.handler, handler, url);
    if (tipo) assert.equal(body.usuarioId, CONTA, url);
    if (url.startsWith('/chat')) assert.equal(res.headers['cache-control'], 'no-store', url);
  }
  assert.equal(f.dispatches.length, outrasRotas.length);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.writes, []);
});

test('chat continua protegido e arquivos estaticos preservam caminhos e conteudo', async t => {
  const f = await fixture(t);
  assertJson(await f.request('GET', '/api/chat'), 401, { mensagem: 'Token nao fornecido' });
  assertJson(await f.request('GET', '/api/chat', { Authorization: 'Bearer invalido' }), 401, { mensagem: 'Token invalido' });
  for (const file of ['index.html', 'profissionais.html', 'faq.html', 'perfil_prestador.html', 'favoritos.js']) {
    const res = await f.request('GET', file === 'index.html' ? '/' : '/' + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers['content-type'], file.endsWith('.html') ? /^text\/html\b/ : /javascript\b/);
    assert.equal(res.text, fs.readFileSync(path.join(root, 'site-iservice-main', file), 'utf8'));
  }
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.dispatches, []);
});
