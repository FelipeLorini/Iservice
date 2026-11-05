const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const root = path.join(__dirname, '..');
const secret = 'chave-sintetica-exclusiva-faq';
const usuarioId = '1'.repeat(24);
const documentos = [
  { _id: '2'.repeat(24), pergunta: 'Como criar conta?', resposta: 'Exemplo ficticio.', categoria: 'conta', ordem: 1, __v: 0 },
  { _id: '3'.repeat(24), pergunta: 'Como entrar?', resposta: 'Outro exemplo.', categoria: 'conta', ordem: 2 },
  { _id: '4'.repeat(24), pergunta: 'Como funciona?', resposta: 'Informacao ficticia.', categoria: 'geral', ordem: 1 }
];
const plain = value => JSON.parse(JSON.stringify(value));

// Carrega codigo real com imports permitidos explicitamente. Nunca carrega
// server.js, dotenv, mongoose ou modelos reais, nem altera require.cache/process.env.
function load(file, dependencies) {
  const filename = path.join(root, file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env: { JWT_SECRET: secret } },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Dependencia inesperada em ${file}: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

async function fixture(t, { rows = documentos, failure } = {}) {
  const queries = [], dispatches = [];
  const Faq = {
    find(...args) {
      const query = { args, sort: null };
      queries.push(query);
      if (failure === 'find') throw new Error('falha sintetica FAQ');
      return { async sort(order) {
        query.sort = plain(order);
        if (failure === 'sort') throw new Error('falha sintetica FAQ');
        // Nao simula a ordenacao do MongoDB: registra a solicitacao do controller
        // e devolve a sequencia conhecida para verificar sua preservacao HTTP.
        return rows;
      } };
    }
  };
  const faq = load('controllers/faqController.js', { '../Models/faqModel': Faq });
  const auth = load('middleware/auth.js', { jsonwebtoken: jwt });
  const chatAuth = load('middleware/authMiddleware.js', { jsonwebtoken: jwt });
  function sentinel(controller) {
    return new Proxy({}, { get: (_, handler) => (req, res) => {
      const result = { handler: `${controller}.${handler}`, params: req.params };
      if (req.usuarioId) result.usuarioId = req.usuarioId;
      dispatches.push(plain(result));
      res.json(result);
    } });
  }
  const dependencies = { express, '../middleware/auth': auth, '../controllers/faqController': faq };
  for (const name of ['CadastroController', 'LoginController', 'ServicoController',
    'agendamentoController', 'avaliacaoController', 'pedidoController', 'propostaController',
    'notificacaoController', 'favoritoController', 'usuarioController']) {
    dependencies['../controllers/' + name] = sentinel(name);
  }
  const userRoutes = load('routes/userRoutes.js', dependencies);
  const chatRoutes = load('routes/chatRoutes.js', {
    express, '../middleware/authMiddleware': chatAuth,
    '../controllers/chatController': sentinel('chatController')
  });
  const { createApp, configureApp } = load('src/app.js', {
    express, cors, path, '../routes/userRoutes': userRoutes, '../routes/chatRoutes': chatRoutes
  });
  const app = createApp();
  configureApp(app);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  function request(method, url, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        method, path: url, headers, agent: false }, res => {
        const chunks = [];
        res.on('error', reject);
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Timeout HTTP local do teste')));
      req.on('error', reject);
      req.end();
    });
  }
  const headers = tipo => ({ Authorization: 'Bearer ' + jwt.sign({ id: usuarioId, tipo }, secret, { expiresIn: 60 }) });
  return { request, queries, dispatches, headers };
}

for (const [label, headers] of [
  ['sem autenticacao', {}], ['com token invalido', { Authorization: 'Bearer token-invalido' }]
]) test(`GET /api/faq e publico ${label}`, async t => {
  const f = await fixture(t);
  const res = await f.request('GET', '/api/faq', headers);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), documentos);
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.dispatches, []);
});

test('FAQ solicita categoria/ordem ascendentes e preserva documentos, campos e sequencia retornada', async t => {
  const f = await fixture(t);
  const res = await f.request('GET', '/api/faq');
  assert.equal(res.status, 200);
  assert.deepEqual(f.queries, [{ args: [], sort: { categoria: 1, ordem: 1 } }]);
  assert.deepEqual(Object.entries(f.queries[0].sort), [['categoria', 1], ['ordem', 1]]);
  assert.deepEqual(JSON.parse(res.text), documentos);
});

test('FAQ vazia retorna 200 e array vazio sem envelope', async t => {
  const f = await fixture(t, { rows: [] });
  const res = await f.request('GET', '/api/faq');
  assert.equal(res.status, 200);
  assert.equal(res.text, '[]');
  assert.deepEqual(f.queries, [{ args: [], sort: { categoria: 1, ordem: 1 } }]);
});

for (const failure of ['find', 'sort']) test(`FAQ preserva status 500 e contrato atual quando ${failure} falha`, async t => {
  const f = await fixture(t, { failure });
  const res = await f.request('GET', '/api/faq');
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), { mensagem: 'Erro ao listar faqs', erro: 'falha sintetica FAQ' });
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.dispatches, []);
});

test('GET /api/faq/ preserva acesso publico, consulta e resposta', async t => {
  const f = await fixture(t);
  const res = await f.request('GET', '/api/faq/', { Authorization: 'Bearer invalido' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), documentos);
  assert.deepEqual(f.queries, [{ args: [], sort: { categoria: 1, ordem: 1 } }]);
});

for (const url of ['/api/faq', '/api/faq/']) {
  test(`HEAD ${url} executa consulta e retorna headers de GET sem corpo`, async t => {
    const f = await fixture(t);
    const get = await f.request('GET', url);
    const head = await f.request('HEAD', url, { Authorization: 'Bearer invalido' });
    assert.equal(get.status, 200);
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.text)));
    assert.equal(head.headers.etag, get.headers.etag);
    assert.equal(f.queries.length, 2);
  });

  test(`OPTIONS ${url} e atendido pelo CORS sem consultar FAQ`, async t => {
    const f = await fixture(t);
    for (const headers of [{}, { Origin: 'https://example.invalid',
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
      Authorization: 'Bearer invalido' }]) {
      const res = await f.request('OPTIONS', url, headers);
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

for (const [method, url] of [
  ['POST', '/api/faq'], ['PUT', '/api/faq'], ['PATCH', '/api/faq'], ['DELETE', '/api/faq'],
  ['GET', '/api/faq/inexistente'], ['GET', '/api/faqx'], ['GET', '/faq']
]) test(`${method} ${url} nao e capturado pela FAQ`, async t => {
  const f = await fixture(t);
  const res = await f.request(method, url);
  assert.equal(res.status, 404);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});

// Verifica apenas encaminhamento e middleware das outras rotas: seus handlers
// sao sentinelas, sem executar regras de negocio ou carregar seus modelos.
const outrasRotas = [
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
  ['GET', '/usuario/id-ficticio/perfil', 'usuarioController.obterPerfilPublico'],
  ['PUT', '/usuario/portifolio', 'usuarioController.atualizarPortifolio', 'prestador'],
  ['POST', '/chat/start', 'chatController.startChat', 'cliente'],
  ['POST', '/chat/message', 'chatController.sendMessage', 'cliente'],
  ['GET', '/chat/unread/count', 'chatController.getUnreadCount', 'cliente'],
  ['GET', '/chat', 'chatController.getUserChats', 'cliente'],
  ['PUT', '/chat/id-ficticio/read', 'chatController.markAsRead', 'cliente'],
  ['GET', '/chat/id-ficticio', 'chatController.getChatMessages', 'cliente']
];

test('FAQ nao intercepta os outros 39 endpoints, incluindo /api/chat', async t => {
  const f = await fixture(t);
  for (const [method, route, handler, tipo] of outrasRotas) {
    const label = `${method} /api${route}`;
    const res = await f.request(method, '/api' + route, tipo ? f.headers(tipo) : {});
    assert.equal(res.status, 200, label);
    const body = JSON.parse(res.text);
    assert.equal(body.handler, handler, label);
    if (tipo) assert.equal(body.usuarioId, usuarioId, label);
    if (route.startsWith('/chat')) assert.equal(res.headers['cache-control'], 'no-store', label);
  }
  assert.equal(f.dispatches.length, outrasRotas.length);
  assert.deepEqual(f.queries, []);
});

test('acesso publico a FAQ nao remove autenticacao ou autorizacao das outras rotas', async t => {
  const f = await fixture(t);
  for (const url of ['/api/chat', '/api/avaliacoes/cliente']) {
    for (const headers of [{}, { Authorization: 'Bearer invalido' }]) {
      assert.equal((await f.request('GET', url, headers)).status, 401, url);
    }
  }
  assert.equal((await f.request('GET', '/api/avaliacoes/cliente', f.headers('prestador'))).status, 403);
  assert.equal((await f.request('GET', '/api/servicos/prestador', f.headers('cliente'))).status, 403);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});

test('GET /faq.html continua servindo a pagina estatica, sem consultar o modelo FAQ', async t => {
  const f = await fixture(t);
  const res = await f.request('GET', '/faq.html');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html\b/);
  assert.equal(res.text, fs.readFileSync(path.join(root, 'site-iservice-main/faq.html'), 'utf8'));
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.dispatches, []);
});
