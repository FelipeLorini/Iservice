const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const CLIENTE = '1'.repeat(24);
const OUTRO_CLIENTE = '2'.repeat(24);
const PRESTADOR = 'a'.repeat(24);
const ID = '3'.repeat(24);
const AUSENTE = '4'.repeat(24);
const SENSIVEL = 'MARCADOR-PRIVADO-EXCLUSIVO-DO-TESTE';
const privados = {
  telefone: SENSIVEL, email: SENSIVEL, senha: SENSIVEL, hash: SENSIVEL,
  token: SENSIVEL, resetPasswordToken: SENSIVEL, campo_futuro: SENSIVEL, __v: 7
};
const prestador = { _id: PRESTADOR, nome: 'Profissional', tipo: 'prestador',
  descricao_detalhada: 'Descricao publica', portifolio: ['https://example.invalid/foto.jpg'],
  ultimo_login: new Date(), ...privados };
const invalidos = [undefined, null, '', 'invalido', 'abcdefghijkl', 'g'.repeat(24), 123,
  { $ne: null }, [PRESTADOR]];

// Codigo real, dependencias explicitamente simuladas; sem servidor, rede ou .env.
function load(file, dependencies) {
  const module = { exports: {} };
  const logs = [];
  const context = {
    module, exports: module.exports, process: { env: {} },
    console: { error: (...args) => logs.push(args) },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Dependencia inesperada: ${name}`);
      return dependencies[name];
    }
  };
  vm.runInNewContext(read(file), context, { filename: file });
  return { handlers: module.exports, logs };
}

async function invoke(handler, request = {}) {
  const res = { code: 200, status(code) { this.code = code; return this; },
    json(body) { this.body = plain(body); return this; } };
  await handler({ body: {}, params: {}, query: {}, usuarioId: CLIENTE, ...request }, res);
  return res;
}

function semDadosPrivados(body) {
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(SENSIVEL));
  assert.doesNotMatch(serialized, /"(?:telefone|email|senha|hash|token|resetPasswordToken|__v|campo_futuro)":/);
}

function perfil(user = prestador, error) {
  const lookups = [];
  const api = load('controllers/usuarioController.js', { '../Models/usuarioModel': {
    findById(id) {
      lookups.push(id);
      return { async select(fields) {
        assert.doesNotMatch(fields, /telefone|email|senha|token/);
        if (error) throw error;
        // Devolve campos extras para testar tambem a lista explicita da resposta.
        return user;
      } };
    }
  } });
  return { ...api, lookups, get: id => invoke(api.handlers.obterPerfilPublico, { params: { id } }) };
}

test('perfil publico preserva contrato do prestador e nao serializa campos privados ou futuros', async () => {
  const res = await perfil().get(PRESTADOR);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { id: PRESTADOR, nome: 'Profissional', tipo: 'prestador',
    descricao_detalhada: prestador.descricao_detalhada, portifolio: prestador.portifolio, online: true });
  semDadosPrivados(res.body);
  assert.ok(!Object.hasOwn(res.body, 'ultimo_login'));
});

test('perfil de cliente e usuario inexistente tem a mesma resposta de ausencia', async () => {
  const cliente = await perfil({ ...prestador, _id: CLIENTE, tipo: 'cliente' }).get(CLIENTE);
  const missing = await perfil(null).get(AUSENTE);
  assert.equal(cliente.code, 404);
  assert.equal(missing.code, 404);
  assert.deepEqual(cliente.body, missing.body);
  assert.deepEqual(cliente.body, { mensagem: 'Usuario nao encontrado' });
});

for (const ultimo_login of [null, new Date(Date.now() - 10 * 60 * 1000)]) {
  test(`perfil sem acesso recente mantem online falso (${ultimo_login})`, async () => {
    const res = await perfil({ ...prestador, ultimo_login, descricao_detalhada: undefined, portifolio: undefined }).get(PRESTADOR);
    assert.equal(res.body.online, false);
    assert.deepEqual(res.body.portifolio, []);
    assert.equal(res.body.descricao_detalhada, '');
  });
}

for (const id of invalidos) {
  test(`perfil rejeita ID invalido antes da consulta: ${JSON.stringify(id)}`, async () => {
    const api = perfil();
    assert.equal((await api.get(id)).code, 400);
    assert.equal(api.lookups.length, 0);
  });
}

test('perfil aceita ObjectId hexadecimal em maiusculas e sanitiza falha interna', async () => {
  assert.equal((await perfil().get(PRESTADOR.toUpperCase())).code, 200);
  const res = await perfil(null, new Error(SENSIVEL)).get(PRESTADOR);
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { mensagem: 'Erro ao obter perfil' });
});

const servico = { _id: ID, nome: 'Limpeza', descricao: 'Limpeza residencial', preco: 150,
  categoria: 'faxina', data_criacao: '2026-01-01', prestador_id: prestador, ...privados };

for (const handler of ['listarServicos', 'listarServicosPorCategoria']) {
  for (const scenario of ['normal', 'prestador removido', 'vazio', 'erro']) {
    test(`catalogo ${handler}: ${scenario}`, async () => {
      let query;
      const { handlers } = load('controllers/ServicoController.js', { '../Models/servicoModel': {
        find(filter) {
          query = filter === undefined ? undefined : plain(filter);
          return { async populate(field, fields) {
            assert.equal(field, 'prestador_id');
            assert.equal(fields, 'nome');
            if (scenario === 'erro') throw new Error(SENSIVEL);
            return scenario === 'vazio' ? [] : [{ ...servico, prestador_id: scenario === 'prestador removido' ? null : prestador }];
          } };
        }
      } });
      const res = await invoke(handlers[handler], { params: { categoria: 'faxina' } });
      assert.deepEqual(query, handler === 'listarServicos' ? undefined : { categoria: 'faxina' });
      assert.equal(res.code, scenario === 'erro' ? 500 : 200);
      semDadosPrivados(res.body);
      if (scenario === 'erro') assert.deepEqual(res.body, { mensagem: 'Erro ao listar servicos' });
      else if (scenario === 'vazio') assert.deepEqual(res.body, []);
      else assert.deepEqual(res.body, [{ _id: ID, nome: 'Limpeza', descricao: 'Limpeza residencial',
        preco: 150, categoria: 'faxina', data_criacao: '2026-01-01',
        prestador_id: scenario === 'prestador removido' ? null : { _id: PRESTADOR, nome: 'Profissional' } }]);
    });
  }
}

function favoritos(options = {}) {
  const users = options.users || [prestador, { _id: OUTRO_CLIENTE, tipo: 'cliente', ...privados }];
  const records = options.records || [];
  const calls = { users: [], finds: [], creates: [], deletes: [] };
  const matches = (record, query) => Object.entries(query).every(([key, value]) => record[key] === value);
  const { handlers } = load('controllers/favoritoController.js', {
    '../Models/usuarioModel': {
      findOne(query) {
        calls.users.push(plain(query));
        return { async select(fields) {
          assert.equal(fields, '_id');
          if (options.error === 'usuario') throw new Error(SENSIVEL);
          return users.find(user => matches(user, query)) || null;
        } };
      }
    },
    '../Models/favoritoModel': {
      async findOne(query) {
        calls.finds.push(plain(query));
        if (options.error === 'consulta') throw new Error(SENSIVEL);
        return records.find(record => matches(record, query)) || null;
      },
      async create(data) {
        if (options.error === 'criacao') throw new Error(SENSIVEL);
        if (options.error === 'duplicidade') throw Object.assign(new Error(SENSIVEL), { code: 11000 });
        calls.creates.push(plain(data));
        const record = { _id: ID, ...plain(data) };
        records.push(record);
        return record;
      },
      async findOneAndDelete(query) {
        calls.deletes.push(plain(query));
        if (options.error === 'exclusao') throw new Error(SENSIVEL);
        const index = records.findIndex(record => matches(record, query));
        return index < 0 ? null : records.splice(index, 1)[0];
      }
    }
  });
  return { handlers, calls, records };
}

test('favorito valido deriva cliente da sessao e preserva inclusao, verificacao e remocao', async () => {
  const api = favoritos();
  const res = await invoke(api.handlers.adicionarFavorito, { body: { prestador_id: PRESTADOR, cliente_id: OUTRO_CLIENTE } });
  assert.equal(res.code, 201);
  assert.deepEqual(api.calls.creates, [{ cliente_id: CLIENTE, prestador_id: PRESTADOR }]);
  assert.deepEqual(api.calls.users, [{ _id: PRESTADOR, tipo: 'prestador' }]);
  const check = await invoke(api.handlers.verificarFavorito, { params: { prestador_id: PRESTADOR } });
  assert.deepEqual(check.body, { favorito: true });
  const remove = await invoke(api.handlers.removerFavorito, { params: { id: PRESTADOR } });
  assert.equal(remove.code, 200);
  assert.equal(api.records.length, 0);
  semDadosPrivados(res.body);
});

for (const destino of [OUTRO_CLIENTE, AUSENTE]) {
  test(`favoritos rejeitam destino nao prestador ou inexistente: ${destino}`, async () => {
    const api = favoritos({ records: [{ cliente_id: CLIENTE, prestador_id: destino }] });
    const res = await invoke(api.handlers.adicionarFavorito, { body: { prestador_id: destino } });
    assert.equal(res.code, 404);
    assert.deepEqual(res.body, { mensagem: 'Prestador nao encontrado' });
    assert.equal(api.calls.creates.length, 0);
    const check = await invoke(api.handlers.verificarFavorito, { params: { prestador_id: destino } });
    assert.deepEqual(check.body, { favorito: false });
    assert.equal(api.calls.finds.length, 0);
  });
}

for (const id of invalidos) {
  test(`favoritos rejeitam ID invalido em inclusao, verificacao e remocao: ${JSON.stringify(id)}`, async () => {
    const api = favoritos();
    const requests = [
      ['adicionarFavorito', { body: { prestador_id: id } }],
      ['verificarFavorito', { params: { prestador_id: id } }],
      ['removerFavorito', { params: { id } }]
    ];
    for (const [handler, request] of requests) assert.equal((await invoke(api.handlers[handler], request)).code, 400);
    assert.deepEqual(api.calls, { users: [], finds: [], creates: [], deletes: [] });
  });
}

test('favoritos nao consultam ou removem relacao de outra conta e permitem remover referencia antiga propria', async () => {
  const api = favoritos({ records: [
    { cliente_id: OUTRO_CLIENTE, prestador_id: PRESTADOR },
    { cliente_id: CLIENTE, prestador_id: AUSENTE }
  ] });
  const check = await invoke(api.handlers.verificarFavorito, { params: { prestador_id: PRESTADOR }, query: { cliente_id: OUTRO_CLIENTE } });
  assert.deepEqual(check.body, { favorito: false });
  const denied = await invoke(api.handlers.removerFavorito, { params: { id: PRESTADOR }, body: { cliente_id: OUTRO_CLIENTE } });
  assert.equal(denied.code, 404);
  assert.equal(api.records.length, 2);
  assert.equal((await invoke(api.handlers.removerFavorito, { params: { id: AUSENTE } })).code, 200);
  assert.deepEqual(api.records, [{ cliente_id: OUTRO_CLIENTE, prestador_id: PRESTADOR }]);
});

for (const error of ['preexistente', 'duplicidade']) {
  test(`favoritos preservam tratamento de duplicidade: ${error}`, async () => {
    const api = favoritos({ error, records: error === 'preexistente' ? [{ cliente_id: CLIENTE, prestador_id: PRESTADOR }] : [] });
    const res = await invoke(api.handlers.adicionarFavorito, { body: { prestador_id: PRESTADOR } });
    assert.equal(res.code, 400);
    assert.deepEqual(res.body, { mensagem: 'Prestador ja esta nos favoritos' });
    assert.equal(api.calls.creates.length, 0);
  });
}

for (const [handler, error] of [
  ['adicionarFavorito', 'usuario'], ['adicionarFavorito', 'consulta'], ['adicionarFavorito', 'criacao'],
  ['verificarFavorito', 'usuario'], ['verificarFavorito', 'consulta'], ['removerFavorito', 'exclusao']
]) {
  test(`favoritos sanitizam erro em ${handler}/${error}`, async () => {
    const api = favoritos({ error });
    const res = await invoke(api.handlers[handler], { body: { prestador_id: PRESTADOR }, params: { prestador_id: PRESTADOR, id: PRESTADOR } });
    assert.equal(res.code, 500);
    assert.deepEqual(Object.keys(res.body), ['mensagem']);
    semDadosPrivados(res.body);
  });
}

test('favoritos filtram referencias antigas com populate real do Mongoose, sem conectar ou escrever', async () => {
  const mongoose = require('mongoose');
  const db = new mongoose.Mongoose();
  db.set('bufferCommands', false);
  const Usuario = db.model('Usuario', require('../Models/usuarioModel').schema.clone());
  const Favorito = db.model('Favorito', require('../Models/favoritoModel').schema.clone());
  const objectId = id => new mongoose.Types.ObjectId(id);
  const users = [prestador, { _id: OUTRO_CLIENTE, nome: 'Cliente privado', tipo: 'cliente', ...privados }]
    .map(user => ({ ...user, _id: objectId(user._id) }));
  const records = [PRESTADOR, OUTRO_CLIENTE, AUSENTE, null, undefined, 'referencia-invalida']
    .map((destino, i) => ({ _id: new mongoose.Types.ObjectId(), cliente_id: objectId(CLIENTE),
      prestador_id: destino && destino !== 'referencia-invalida' ? objectId(destino) : destino,
      data_criacao: new Date('2026-01-01'), ...privados }));
  records.push({ _id: objectId(ID), cliente_id: objectId(OUTRO_CLIENTE), prestador_id: objectId(PRESTADOR) });
  const before = plain(records);
  const queries = [];
  // Apenas leitura em memoria no limite do driver. Escritas nao sao substituidas.
  Favorito.collection.find = filter => {
    queries.push(plain(filter));
    return { async toArray() { return records.filter(record => record.cliente_id.equals(filter.cliente_id)); } };
  };
  Usuario.collection.find = (filter, options) => {
    assert.equal(filter.tipo, 'prestador');
    assert.ok(!Object.hasOwn(options.projection, 'telefone'));
    return { async toArray() { return users.filter(user => user.tipo === filter.tipo &&
      filter._id.$in.some(id => id && user._id.equals(id))); } };
  };
  const { handlers } = load('controllers/favoritoController.js', {
    '../Models/favoritoModel': Favorito, '../Models/usuarioModel': Usuario
  });
  const res = await invoke(handlers.listarFavoritos, { query: { cliente_id: OUTRO_CLIENTE } });
  assert.equal(res.code, 200);
  assert.equal(res.body.length, 1);
  assert.deepEqual(res.body[0].prestador_id, { _id: PRESTADOR, nome: 'Profissional', descricao_detalhada: 'Descricao publica' });
  assert.equal(res.body[0].cliente_id, CLIENTE);
  assert.deepEqual(queries, [{ cliente_id: CLIENTE }]);
  semDadosPrivados(res.body);
  assert.deepEqual(plain(records), before);
  assert.equal(db.connection.readyState, 0);
});

for (const scenario of ['vazio', 'erro']) {
  test(`listagem de favoritos: ${scenario}`, async () => {
    const { handlers } = load('controllers/favoritoController.js', {
      '../Models/usuarioModel': {}, '../Models/favoritoModel': {
        find(query) {
          assert.deepEqual(plain(query), { cliente_id: CLIENTE });
          return { async populate() { if (scenario === 'erro') throw new Error(SENSIVEL); return []; } };
        }
      }
    });
    const res = await invoke(handlers.listarFavoritos);
    assert.equal(res.code, scenario === 'erro' ? 500 : 200);
    assert.deepEqual(res.body, scenario === 'erro' ? { mensagem: 'Erro ao listar favoritos' } : []);
  });
}

function avaliacoes(records = [], error) {
  const queries = [];
  const api = load('controllers/avaliacaoController.js', {
    '../Models/agendamentoModel': {}, '../utils/notificacaoHelper': {},
    '../Models/avaliacaoModel': {
      find(query) {
        queries.push(plain(query));
        return { populate(field, fields) {
          assert.equal(field, 'cliente_id');
          assert.equal(fields, 'nome');
          return { async sort(order) {
            assert.deepEqual(plain(order), { data_criacao: -1 });
            if (error) throw error;
            return records;
          } };
        } };
      }
    }
  });
  return { ...api, queries };
}

test('avaliacao publica preserva exibicao sem IDs da conta, agendamento ou outros vinculos', async () => {
  const api = avaliacoes([{ _id: ID, cliente_id: { _id: CLIENTE, nome: 'Pessoa', ...privados },
    prestador_id: PRESTADOR, agendamento_id: AUSENTE, servico_id: ID, nota: 5, comentario: 'Bom trabalho', ...privados }]);
  const res = await invoke(api.handlers.listarAvaliacoesPorPrestador, { params: { id: PRESTADOR } });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, [{ nota: 5, comentario: 'Bom trabalho', cliente_id: { nome: 'Pessoa' } }]);
  assert.deepEqual(api.queries, [{ prestador_id: PRESTADOR }]);
  semDadosPrivados(res.body);
});

test('avaliacoes antigas, sem cliente ou com cliente removido permanecem legiveis', async () => {
  const records = [undefined, null, CLIENTE, {}, { nome: 'Pessoa' }].map(cliente_id => ({ nota: 4, cliente_id }));
  const api = avaliacoes(records);
  const res = await invoke(api.handlers.listarAvaliacoesPorPrestador, { params: { id: PRESTADOR } });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, records.map((_, i) => ({ nota: 4, comentario: '', cliente_id: { nome: i === 4 ? 'Pessoa' : 'Cliente' } })));
});

test('avaliacoes publicas tratam lista vazia, ID invalido e falha interna', async () => {
  const api = avaliacoes();
  for (const id of invalidos) assert.equal((await invoke(api.handlers.listarAvaliacoesPorPrestador, { params: { id } })).code, 400);
  assert.equal(api.queries.length, 0);
  assert.deepEqual((await invoke(api.handlers.listarAvaliacoesPorPrestador, { params: { id: PRESTADOR } })).body, []);
  const failed = avaliacoes([], new Error(SENSIVEL));
  const res = await invoke(failed.handlers.listarAvaliacoesPorPrestador, { params: { id: PRESTADOR } });
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { mensagem: 'Erro ao listar avaliacoes' });
});

function chat(options = {}) {
  const Chat = require('../Models/chatModel');
  // Documento e ObjectIds reais em memoria; save e consulta nunca acessam o banco.
  const document = new Chat({ participants: [CLIENTE, PRESTADOR], messages: [
    { sender: PRESTADOR, receiver: CLIENTE, content: 'Recebida', read: false },
    { sender: CLIENTE, receiver: PRESTADOR, content: 'Enviada', read: false },
    { sender: PRESTADOR, receiver: CLIENTE, content: 'Ja lida', read: true, readAt: new Date('2026-01-01') }
  ] });
  let saves = 0;
  const lookups = [];
  document.save = async () => { saves++; if (options.error === 'save') throw new Error(SENSIVEL); };
  const api = load('controllers/chatController.js', { '../Models/chatModel': { async findById(id) {
    lookups.push(id);
    if (options.error === 'consulta') throw new Error(SENSIVEL);
    return options.missing ? null : document;
  } } });
  return { ...api, document, lookups, get saves() { return saves; },
    mark: (usuarioId = CLIENTE, chatId = ID) => invoke(api.handlers.markAsRead, { usuarioId, params: { chatId } }) };
}

for (const usuarioId of [CLIENTE, PRESTADOR]) {
  test(`participante marca somente recebidas nao lidas e preserva leitura anterior: ${usuarioId}`, async () => {
    const api = chat();
    const before = plain(api.document.messages);
    const res = await api.mark(usuarioId);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { mensagem: 'Mensagens marcadas como lidas', marcadas: 1 });
    api.document.messages.forEach((message, i) => {
      if (message.receiver.toString() === usuarioId && !before[i].read) {
        assert.equal(message.read, true);
        assert.ok(message.readAt instanceof Date);
      } else assert.deepEqual(plain(message), before[i]);
    });
    assert.equal(api.saves, 1);
    assert.equal((await api.mark(usuarioId)).body.marcadas, 0);
  });
}

test('terceiro nao pode marcar chat nem acionar save, mesmo com receiver inconsistente', async () => {
  const api = chat();
  api.document.messages.push({ sender: CLIENTE, receiver: OUTRO_CLIENTE, content: 'Legada inconsistente', read: false });
  const before = plain(api.document);
  const res = await api.mark(OUTRO_CLIENTE);
  assert.equal(res.code, 403);
  assert.equal(api.saves, 0);
  assert.deepEqual(plain(api.document), before);
});

test('marcacao de chat valida ID antes de consultar e retorna 404 para inexistente', async () => {
  const api = chat();
  for (const chatId of invalidos) {
    const res = await invoke(api.handlers.markAsRead, { params: { chatId } });
    assert.equal(res.code, 400);
  }
  assert.equal(api.lookups.length, 0);
  assert.equal(api.saves, 0);
  const missing = chat({ missing: true });
  assert.equal((await missing.mark()).code, 404);
  assert.equal(missing.saves, 0);
});

for (const error of ['consulta', 'save']) {
  test(`marcacao de chat sanitiza falha de ${error}`, async () => {
    const api = chat({ error });
    const res = await api.mark();
    assert.equal(res.code, 500);
    assert.deepEqual(res.body, { mensagem: 'Erro ao marcar mensagens' });
    assert.deepEqual(api.logs, [['Falha interna na operacao de chat']]);
  });
}
