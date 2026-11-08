const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { disposableMongo } = require('./helpers/disposableMongo');
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const secret = 'segredo-exclusivamente-ficticio-integracao-auth';
const password = 'senha-exclusivamente-ficticia-auth';
const changedPassword = 'outra-senha-exclusivamente-ficticia';
const plain = value => JSON.parse(JSON.stringify(value));
const input = (label, tipo = 'cliente') => ({ nome: 'Conta ficticia ' + label,
  email: label + '@example.invalid', senha: password, tipo, telefone: '000000000' });

function json(res, status, expected) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  const body = JSON.parse(res.text);
  // Comparacoes booleanas evitam imprimir credenciais/tokens ate em falhas de assercao.
  if (expected !== undefined) assert.ok(JSON.stringify(body) === JSON.stringify(expected), 'Contrato JSON deve ser preservado');
  return body;
}

function assertHash(hash) {
  assert.ok(typeof hash === 'string' && /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/.test(hash),
    'Senha persistida deve ter formato bcrypt com custo 10');
  assert.ok(hash !== password && hash !== changedPassword, 'Senha nao deve ser persistida em texto');
}

async function realUsuario(database) {
  // Executa o Model original, sem copiar schema/hook nem substituir operacoes.
  // A unica troca de mongoose vincula o Model real a instancia independente deste teste.
  const filename = path.join(__dirname, '..', 'Models', 'usuarioModel.js');
  const module = { exports: {} };
  const dependencies = { mongoose: database, bcryptjs: bcrypt };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Import inesperado no Model de usuario');
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

test('MongoDB descartavel: autenticacao HTTP e hashing com Model real', { timeout: 60000 }, async t => {
  const database = new mongoose.Mongoose();
  database.set('autoCreate', false);
  database.set('autoIndex', false);
  database.set('bufferCommands', false);
  const databaseName = 'iservice_auth_disposable_' + randomUUID().replace(/-/g, '');
  let mongo, directory, writesAllowed = false;
  const writes = [];
  const mutating = new Set(['insert', 'update', 'delete', 'findAndModify', 'create',
    'createIndexes', 'drop', 'dropDatabase', 'dropIndexes']);
  try {
    mongo = await disposableMongo(); // Falha fechada se o executavel local nao estiver disponivel.
    const url = new URL(mongo.uri);
    assert.equal(url.protocol, 'mongodb:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0 && Number(url.port) !== 27017, 'Porta deve ser temporaria e diferente de 27017');
    assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(url.search, ''); assert.ok(url.pathname === '' || url.pathname === '/');
    assert.ok(Number.isSafeInteger(mongo.pid) && mongo.pid > 0, 'Processo dedicado deve possuir PID');
    assert.equal((await mongo.client.db('admin').command({ serverStatus: 1 })).pid, mongo.pid);
    const commandLine = await mongo.client.db('admin').command({ getCmdLineOpts: 1 });
    assert.equal(commandLine.parsed.net.bindIp, '127.0.0.1');
    assert.equal(commandLine.parsed.net.port, Number(url.port));
    directory = path.resolve(commandLine.parsed.storage.dbPath);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('iservice-chat-audit-'), 'Diretorio deve pertencer ao helper temporario');
    assert.equal(await fs.realpath(directory), directory);

    // URI gerada pelo processo acima; nenhuma URI de ambiente e usada como alternativa.
    await database.connect(mongo.uri, { dbName: databaseName, autoCreate: false, autoIndex: false,
      bufferCommands: false, serverSelectionTimeoutMS: 1000, monitorCommands: true });
    const client = database.connection.getClient();
    client.on('commandStarted', event => {
      if (mutating.has(event.commandName)) writes.push({ name: event.commandName,
        databaseName: event.databaseName, collection: event.command[event.commandName], allowed: writesAllowed });
    });
    async function assertTarget() {
      assert.equal(database.connection.host, '127.0.0.1');
      assert.equal(database.connection.port, Number(url.port));
      assert.equal(database.connection.name, databaseName);
      assert.equal(database.connection.readyState, 1);
      assert.equal((await database.connection.db.admin().command({ serverStatus: 1 })).pid, mongo.pid);
    }
    await assertTarget();
    const Usuario = await realUsuario(database);
    assert.equal(Usuario.db, database.connection);
    assert.equal(mongoose.connection.readyState, 0, 'Conexao global deve continuar fechada');
    assert.equal(writes.length, 0, 'Model nao deve criar colecao ou indice automaticamente');
    writesAllowed = true;
    await assertTarget();
    await Usuario.createCollection();
    await assertTarget();
    await Usuario.createIndexes(); // Somente o indice declarado no Model, na colecao temporaria.

    await t.test('instancia exclusiva possui indice real de email e nenhum usuario preexistente', async () => {
      await assertTarget();
      assert.equal(await Usuario.countDocuments(), 0);
      const indexes = await Usuario.collection.indexes();
      assert.ok(indexes.some(index => index.unique === true && index.key.email === 1 && Object.keys(index.key).length === 1),
        'Indice unico de email deve existir no banco temporario');
    });

    // O servidor HTTP e encerrado pelo contexto filho antes do fechamento do banco no finally.
    await t.test('cadastro e login percorrem Express, Routers, controllers e persistencia reais', async t => {
      const dispatches = [], controllers = controllerStubs(dispatches);
      controllers.CadastroController = loadController('controllers/CadastroController.js', {
        '../Models/usuarioModel': Usuario
      }, { secret });
      controllers.LoginController = loadController('controllers/LoginController.js', {
        '../Models/usuarioModel': Usuario, jsonwebtoken: jwt
      }, { secret });
      controllers.usuarioController = loadController('controllers/usuarioController.js', {
        '../Models/usuarioModel': Usuario
      }, { secret });
      const http = await startHttp(t, { controllers, secret });
      const accounts = new Map(), tokens = new Map();

      async function register(label, tipo = 'cliente') {
        await assertTarget();
        const data = input(label, tipo);
        const body = json(await http.request('POST', '/api/cadastro', {}, data), 201);
        assert.deepEqual(Object.keys(body).sort(), ['mensagem', 'usuario']);
        assert.equal(body.mensagem, 'Usuario cadastrado com sucesso');
        assert.deepEqual(Object.keys(body.usuario).sort(), ['email', 'id', 'nome', 'tipo']);
        assert.ok(/^[a-f\d]{24}$/.test(body.usuario.id), 'Cadastro deve retornar ID persistido');
        assert.deepEqual(body.usuario, { id: body.usuario.id, nome: data.nome, email: data.email, tipo });
        return { data, id: body.usuario.id };
      }

      for (const tipo of ['cliente', 'prestador']) {
        await t.test(`cadastro de ${tipo} persiste hash e compara senhas antes e depois de recarregar`, async () => {
          const account = await register(tipo, tipo);
          const stored = await Usuario.collection.findOne({ email: account.data.email });
          assertHash(stored.senha);
          assert.equal(stored._id.toString(), account.id);
          const doc = await Usuario.findById(account.id);
          assert.equal(await doc.compararSenha(password), true);
          assert.equal(await doc.compararSenha('incorreta-ficticia'), false);
          const reloaded = await Usuario.findById(account.id);
          assert.equal(await reloaded.compararSenha(password), true);
          assert.equal(await reloaded.compararSenha('incorreta-ficticia'), false);
          assert.equal(reloaded.ultimo_login, null);
          accounts.set(tipo, account);
        });
      }

      await t.test('save sem modificar senha preserva exatamente o hash armazenado', async () => {
        await assertTarget();
        const account = accounts.get('cliente');
        const doc = await Usuario.findById(account.id), previousHash = doc.senha;
        doc.telefone = '111111111';
        await doc.save();
        const reloaded = await Usuario.findById(account.id);
        assert.ok(reloaded.senha === previousHash, 'Hash deve permanecer identico sem alterar senha');
        assert.equal(reloaded.telefone, '111111111');
        assert.equal(await reloaded.compararSenha(password), true);
      });

      await t.test('alterar senha no Model gera novo hash e invalida somente a senha anterior', async () => {
        const account = await register('troca-senha');
        await assertTarget();
        const doc = await Usuario.findById(account.id), previousHash = doc.senha;
        doc.senha = changedPassword;
        await doc.save();
        const reloaded = await Usuario.findById(account.id);
        assertHash(reloaded.senha);
        assert.ok(reloaded.senha !== previousHash, 'Troca deve gerar hash diferente');
        assert.equal(await reloaded.compararSenha(password), false);
        assert.equal(await reloaded.compararSenha(changedPassword), true);
        json(await http.request('POST', '/api/login', {}, { email: account.data.email, senha: password }),
          401, { mensagem: 'Email ou senha invalidos' });
        const result = json(await http.request('POST', '/api/login', {}, { email: account.data.email, senha: changedPassword }), 200);
        assert.equal(jwt.verify(result.token, secret).id, account.id);
      });

      for (const field of ['nome', 'email', 'senha', 'tipo', 'telefone']) {
        await t.test(`campo obrigatorio ${field}: validacao real e contrato HTTP 500 atual sem gravar`, async () => {
          await assertTarget();
          const data = input('sem-' + field); delete data[field];
          const error = new Usuario(data).validateSync();
          assert.ok(error?.errors?.[field]?.kind === 'required', 'Campo deve falhar pela validacao required real');
          const before = await Usuario.countDocuments(), previousWrites = writes.length;
          json(await http.request('POST', '/api/cadastro', {}, data), 500, { mensagem: 'Erro ao cadastrar usuario' });
          assert.equal(await Usuario.countDocuments(), before);
          assert.equal(writes.length, previousWrites, 'Validacao deve impedir escrita no MongoDB');
        });
      }

      await t.test('papel fora do enum e rejeitado pelo Model real sem cadastrar', async () => {
        await assertTarget();
        const before = await Usuario.countDocuments();
        json(await http.request('POST', '/api/cadastro', {}, input('papel-invalido', 'inexistente')),
          500, { mensagem: 'Erro ao cadastrar usuario' });
        assert.equal(await Usuario.countDocuments(), before);
      });

      await t.test('email duplicado preserva 400 HTTP e indice real rejeita criacao direta com 11000', async () => {
        await assertTarget();
        const account = accounts.get('cliente'), before = await Usuario.countDocuments();
        const original = await Usuario.findById(account.id);
        json(await http.request('POST', '/api/cadastro', {}, account.data), 400, { mensagem: 'Email ja cadastrado' });
        await assert.rejects(Usuario.create(account.data), error => error.code === 11000);
        assert.equal(await Usuario.countDocuments(), before);
        const reloaded = await Usuario.findById(account.id);
        assert.ok(reloaded.senha === original.senha, 'Duplicidade nao pode alterar hash da conta existente');
      });

      for (const tipo of ['cliente', 'prestador']) {
        await t.test(`login real de ${tipo} emite identidade JWT e persiste ultimo_login sem rehash`, async () => {
          await assertTarget();
          const account = accounts.get(tipo), before = await Usuario.findById(account.id);
          const begin = Date.now();
          const body = json(await http.request('POST', '/api/login', {},
            { email: account.data.email, senha: password, id: 'f'.repeat(24), tipo: 'forjado' }), 200);
          const end = Date.now();
          assert.deepEqual(Object.keys(body).sort(), ['mensagem', 'token', 'usuario']);
          assert.equal(body.mensagem, 'Login realizado com sucesso');
          assert.deepEqual(body.usuario, { id: account.id, nome: account.data.nome, email: account.data.email, tipo });
          const claims = jwt.verify(body.token, secret, { algorithms: ['HS256'] });
          assert.deepEqual(Object.keys(claims).sort(), ['email', 'exp', 'iat', 'id', 'tipo']);
          assert.equal(claims.id, account.id); assert.equal(claims.email, account.data.email); assert.equal(claims.tipo, tipo);
          assert.equal(claims.exp - claims.iat, 7 * 24 * 60 * 60);
          const reloaded = await Usuario.findById(account.id);
          assert.ok(before.ultimo_login === null, 'Conta ainda nao deve ter feito login');
          assert.ok(reloaded.ultimo_login instanceof Date, 'ultimo_login deve ser Date persistida');
          assert.ok(reloaded.ultimo_login.getTime() >= begin && reloaded.ultimo_login.getTime() <= end,
            'ultimo_login deve corresponder ao intervalo da requisicao');
          assert.ok(reloaded.senha === before.senha, 'Login nao deve modificar o hash');
          tokens.set(tipo, body.token);
        });
      }

      await t.test('login com senha incorreta preserva 401 e nao altera ultimo_login nem hash', async () => {
        await assertTarget();
        const account = accounts.get('cliente'), before = plain(await Usuario.findById(account.id));
        const previousWrites = writes.length;
        json(await http.request('POST', '/api/login', {}, { email: account.data.email, senha: 'incorreta-ficticia' }),
          401, { mensagem: 'Email ou senha invalidos' });
        assert.ok(JSON.stringify(plain(await Usuario.findById(account.id))) === JSON.stringify(before),
          'Falha de login nao deve alterar documento');
        assert.equal(writes.length, previousWrites);
      });

      await t.test('login de conta inexistente preserva 401 sem criar usuario', async () => {
        await assertTarget();
        const before = await Usuario.countDocuments(), previousWrites = writes.length;
        json(await http.request('POST', '/api/login', {}, { email: 'ausente@example.invalid', senha: password }),
          401, { mensagem: 'Email ou senha invalidos' });
        assert.equal(await Usuario.countDocuments(), before); assert.equal(writes.length, previousWrites);
      });

      await t.test('login com campos ausentes preserva 400 sem gravacoes', async () => {
        await assertTarget();
        const previousWrites = writes.length;
        for (const body of [{}, { email: 'cliente@example.invalid' }, { senha: password }]) {
          json(await http.request('POST', '/api/login', {}, body), 400, { mensagem: 'Email e senha sao obrigatorios' });
        }
        assert.equal(writes.length, previousWrites);
      });

      await t.test('JWT emitido passa pelo middleware real e atualiza apenas a conta autorizada', async () => {
        await assertTarget();
        const client = accounts.get('cliente'), provider = accounts.get('prestador');
        const clientBefore = plain(await Usuario.findById(client.id)), providerBefore = await Usuario.findById(provider.id);
        json(await http.request('PUT', '/api/usuario/portifolio', { Authorization: 'Bearer ' + tokens.get('cliente') }, { portifolio: [] }),
          403, { mensagem: 'Acesso negado. Apenas prestadores podem realizar esta acao' });
        const portifolio = ['https://example.invalid/foto-ficticia.jpg'];
        json(await http.request('PUT', '/api/usuario/portifolio', { Authorization: 'Bearer ' + tokens.get('prestador') },
          { portifolio, usuario_id: client.id, id: client.id }), 200,
        { mensagem: 'Portifolio atualizado com sucesso', portifolio, descricao_detalhada: '' });
        const providerAfter = await Usuario.findById(provider.id);
        assert.deepEqual([...providerAfter.portifolio], portifolio);
        assert.ok(providerAfter.senha === providerBefore.senha, 'Atualizacao autenticada nao deve reprocessar senha');
        assert.ok(JSON.stringify(plain(await Usuario.findById(client.id))) === JSON.stringify(clientBefore),
          'Identidade enviada no corpo nao pode alterar outra conta');
      });

      await t.test('JWT ausente, malformado ou assinado com outra chave retorna 401 sem gravar', async () => {
        await assertTarget();
        const previousWrites = writes.length;
        json(await http.request('PUT', '/api/usuario/portifolio', {}, { portifolio: [] }),
          401, { mensagem: 'Acesso negado. Token nao fornecido' });
        const wrongKey = jwt.sign({ id: accounts.get('prestador').id, tipo: 'prestador' }, 'outra-chave-ficticia');
        for (const token of ['invalido-ficticio', wrongKey]) {
          json(await http.request('PUT', '/api/usuario/portifolio', { Authorization: 'Bearer ' + token }, { portifolio: [] }),
            401, { mensagem: 'Token invalido ou expirado' });
        }
        assert.equal(writes.length, previousWrites);
      });

      assert.deepEqual(dispatches, [], 'Fluxos de autenticacao nao podem cair nos controllers sentinela');
    });
  } finally {
    // Sem exclusoes por comando MongoDB: fechar conexoes e remover apenas recursos do processo proprio.
    const results = await Promise.allSettled([database.disconnect()]);
    if (mongo) {
      try { await mongo.cleanup(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
    }
    assert.equal(database.connection.readyState, 0, 'Conexao Mongoose temporaria deve estar fechada');
    assert.equal(mongoose.connection.readyState, 0, 'Conexao global deve permanecer fechada');
    assert.ok(results.every(result => result.status === 'fulfilled'), 'Limpeza de conexoes/processo deve concluir');
    if (mongo) {
      assert.throws(() => process.kill(mongo.pid, 0), error => error.code === 'ESRCH', 'Processo temporario deve ter encerrado');
      if (directory) assert.ok(await fs.access(directory).then(() => false, error => error.code === 'ENOENT'),
        'Diretorio de dados temporario deve ter sido removido');
    }
    assert.ok(writes.every(write => write.allowed && write.databaseName === databaseName && write.collection === 'usuarios' &&
      ['insert', 'update', 'create', 'createIndexes'].includes(write.name)),
    'Todas as escritas devem pertencer somente a colecao de usuarios temporaria autorizada');
  }
});
