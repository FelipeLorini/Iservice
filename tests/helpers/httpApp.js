const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const root = path.join(__dirname, '..', '..');
// Lista explicita de substituicoes, independente dos endpoints esperados nos testes.
const controllerNames = Object.freeze([
  'CadastroController', 'LoginController', 'ServicoController', 'agendamentoController',
  'avaliacaoController', 'pedidoController', 'propostaController', 'notificacaoController',
  'favoritoController', 'usuarioController', 'faqController', 'chatController'
]);

function evaluate(file, requireMock, secret, clock = Date) {
  const filename = path.join(root, file);
  // Nao segue links para arquivos externos ao projeto nem usa require.cache.
  assert.equal(fs.realpathSync(filename), filename, `Caminho indireto recusado: ${file}`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Date: clock,
    process: { env: { JWT_SECRET: secret } }, require: requireMock
  }, { filename });
  return module.exports;
}

// Controller real somente por escolha da fixture, com todos os imports simulados.
// Modelos, servicos ou utilitarios novos exigem uma decisao explicita do teste.
function loadController(file, dependencies, { secret, clock = Date } = {}) {
  assert.match(file, /^controllers\/[A-Za-z][A-Za-z0-9]*\.js$/, 'Controller nao permitido');
  return evaluate(file, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Dependencia inesperada em ${file}: ${name}`);
    return dependencies[name];
  }, secret, clock);
}

function controllerStubs(dispatches) {
  return Object.fromEntries(controllerNames.map(controller => [controller,
    new Proxy({}, { get: (_, handler) => (req, res) => {
      const result = { handler: `${controller}.${handler}`, params: req.params };
      if (req.usuarioId) result.usuarioId = req.usuarioId;
      dispatches.push(JSON.parse(JSON.stringify(result)));
      res.json(result);
    } })
  ]));
}

function createRouteLoader({ controllers, secret, expressModule = express, jwtModule = jwt }) {
  const cache = new Map(); // Exclusivo desta fixture, inclusive os middlewares.
  const libraries = { express: expressModule, cors, path, jsonwebtoken: jwtModule };
  const middlewareFiles = ['middleware/auth.js', 'middleware/authMiddleware.js'];
  function load(file) {
    const controller = /^controllers\/([A-Za-z][A-Za-z0-9]*)\.js$/.exec(file);
    if (controller) {
      assert.ok(Object.hasOwn(controllers, controller[1]), `Controller nao substituido: ${file}`);
      return controllers[controller[1]];
    }
    assert.ok(file === 'src/app.js' || /^routes\/[A-Za-z][A-Za-z0-9]*\.js$/.test(file) ||
      middlewareFiles.includes(file), `Modulo nao permitido: ${file}`);
    if (cache.has(file)) return cache.get(file);
    const exports = evaluate(file, name => {
      if (Object.hasOwn(libraries, name)) return libraries[name];
      assert.ok(name.startsWith('./') || name.startsWith('../'), `Import nao permitido: ${name}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      return load(resolved.endsWith('.js') ? resolved : resolved + '.js');
    }, secret);
    cache.set(file, exports);
    return exports;
  }
  return load;
}

async function startHttp(t, { controllers, secret, usuarioId }) {
  const load = createRouteLoader({ controllers, secret });
  const { createApp, configureApp } = load('src/app.js');
  const app = createApp();
  configureApp(app);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  function request(method, url, headers = {}, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        method, path: url, agent: false,
        headers: data === undefined ? headers : { ...headers, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Timeout HTTP local do teste')));
      req.on('error', reject);
      req.end(data);
    });
  }
  const headers = tipo => ({ Authorization: 'Bearer ' + jwt.sign({ id: usuarioId, tipo }, secret, { expiresIn: 60 }) });
  return { request, headers };
}

module.exports = { loadController, controllerStubs, controllerNames, createRouteLoader, startHttp };
