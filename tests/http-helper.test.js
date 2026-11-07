const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouteLoader, loadController, loadService, controllerStubs, startHttp } = require('./helpers/httpApp');

test('loader HTTP recusa fontes fora da montagem permitida antes de ler seus arquivos', () => {
  const load = createRouteLoader({ controllers: {} });
  for (const file of ['server.js', 'config/database.js', 'Models/faqModel.js',
    'routes/../server.js', '../server.js', 'dotenv', 'mongoose', 'node:fs']) {
    assert.throws(() => load(file), /Modulo nao permitido/, file);
    assert.throws(() => loadController(file, {}), /Controller nao permitido/, file);
  }
});

test('Router real exige controller explicitamente substituido, inclusive em import filho', () => {
  const controllers = controllerStubs([]);
  delete controllers.faqController;
  const load = createRouteLoader({ controllers });
  assert.throws(() => load('routes/userRoutes.js'), /Controller nao substituido: controllers\/faqController.js/);
});

test('controller real recusa modelo nao simulado, sem fallback para require real', () => {
  const before = new Set(Object.keys(require.cache));
  assert.throws(() => loadController('controllers/faqController.js', {}), /Dependencia inesperada.*faqModel/);
  assert.deepEqual(Object.keys(require.cache).filter(file => !before.has(file)), []);
});

test('loader de service permite somente propostaService e nao amplia os loaders anteriores', () => {
  for (const file of ['server.js', '.env', 'Models/propostaModel.js', 'utils/notificacaoHelper.js',
    'services/outroService.js', 'services/../services/propostaService.js', '../services/propostaService.js']) {
    assert.throws(() => loadService(file, {}), /Service nao permitido/, file);
  }
  const load = createRouteLoader({ controllers: {} });
  assert.throws(() => load('services/propostaService.js'), /Modulo nao permitido/);
  assert.throws(() => loadController('services/propostaService.js', {}), /Controller nao permitido/);
});

test('service real recusa cada dependencia nao simulada sem carregar modelos ou helper reais', () => {
  const before = new Set(Object.keys(require.cache));
  const dependencies = {};
  for (const name of ['../Models/propostaModel', '../Models/agendamentoModel',
    '../Models/servicoModel', '../utils/notificacaoHelper']) {
    assert.throws(() => loadService('services/propostaService.js', dependencies),
      error => error.message.includes('Dependencia inesperada') && error.message.includes(name));
    dependencies[name] = {};
  }
  const service = loadService('services/propostaService.js', dependencies);
  assert.equal(typeof service.aceitarProposta, 'function');
  assert.deepEqual(Object.keys(require.cache).filter(file => !before.has(file)), []);
});

test('loaders e servidores independentes isolam Routers, registros e chaves JWT', async t => {
  const firstDispatches = [], secondDispatches = [];
  const firstControllers = controllerStubs(firstDispatches);
  const secondControllers = controllerStubs(secondDispatches);
  const firstLoader = createRouteLoader({ controllers: firstControllers });
  const secondLoader = createRouteLoader({ controllers: secondControllers });
  assert.equal(firstLoader('routes/userRoutes.js'), firstLoader('routes/userRoutes.js'));
  assert.notEqual(firstLoader('routes/userRoutes.js'), secondLoader('routes/userRoutes.js'));
  const first = await startHttp(t, { controllers: firstControllers, secret: 'chave-ficticia-a', usuarioId: 'a'.repeat(24) });
  const second = await startHttp(t, { controllers: secondControllers, secret: 'chave-ficticia-b', usuarioId: 'b'.repeat(24) });
  const url = '/api/servicos/prestador';
  assert.equal((await second.request('GET', url, first.headers('prestador'))).status, 401);
  assert.deepEqual(secondDispatches, []);
  const responses = await Promise.all([
    first.request('GET', url, first.headers('prestador')),
    second.request('GET', url, second.headers('prestador'))
  ]);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).usuarioId, (index === 0 ? 'a' : 'b').repeat(24));
  }
  assert.equal(firstDispatches.length, 1);
  assert.equal(secondDispatches.length, 1);
});
