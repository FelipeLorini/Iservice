const test = require('node:test');
const assert = require('node:assert/strict');
// Somente o tipo escalar: nao importa Models nem abre conexao.
const { ObjectId } = require('mongoose').Types;
const { loadController, controllerStubs, startHttp } = require('./helpers/httpApp');

const CLIENTE = 'a'.repeat(24), PRESTADOR = 'b'.repeat(24), OUTRO = 'c'.repeat(24);
const AGENDAMENTO = 'd'.repeat(24), SERVICO = 'e'.repeat(24), AVALIACAO = 'f'.repeat(24);
const secret = 'chave-exclusivamente-ficticia-avaliacoes-http';
const plain = value => JSON.parse(JSON.stringify(value));
const input = { agendamento_id: AGENDAMENTO, nota: 4, comentario: 'Comentario ficticio' };

async function fixture(t, { owner = CLIENTE, missing = false, duplicate = false, failure,
  records = [], aggregate = [] } = {}) {
  const calls = [], writes = [], notifications = [], dispatches = [];
  function record(op, value) {
    calls.push({ op, value: plain(value) });
    if (failure === op) throw Error('falha-sintetica-avaliacoes');
  }
  const controllers = controllerStubs(dispatches);
  controllers.avaliacaoController = loadController('controllers/avaliacaoController.js', {
    '../Models/agendamentoModel': { async findById(id) {
      record('findById', id);
      return missing ? null : { cliente_id: owner, prestador_id: PRESTADOR, servico_id: SERVICO, status: 'finalizado' };
    } },
    '../Models/avaliacaoModel': {
      async findOne(filter) { record('findOne', filter); return duplicate ? { _id: AVALIACAO } : null; },
      async create(data) {
        record('create', data);
        const row = { _id: AVALIACAO, ...plain(data) };
        writes.push(row);
        return row;
      },
      find(filter) {
        record('find', filter);
        return {
          select(fields) {
            record('select', fields);
            return { async lean() {
              record('lean', null);
              return records.filter(row => row.cliente_id === filter.cliente_id);
            } };
          },
          populate(field, fields) {
            record('populate', [field, fields]);
            return { async sort(order) {
              record('sort', order);
              return records.filter(row => row.prestador_id === filter.prestador_id);
            } };
          }
        };
      },
      async aggregate(pipeline) { record('aggregate', pipeline); return aggregate; }
    },
    '../utils/notificacaoHelper': { async criarNotificacao(...args) {
      record('notify', args); notifications.push(plain(args));
    } },
    mongoose: { Types: { ObjectId } }
  }, { secret });
  return { ...await startHttp(t, { controllers, secret, usuarioId: CLIENTE }), calls, writes, notifications, dispatches };
}

function json(res, status, body) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(res.text), body);
}

for (const [method, url] of [['POST', '/api/avaliacoes'], ['GET', '/api/avaliacoes/cliente']]) {
  test(`${method} ${url}: JWT e papel sao verificados antes do controller real`, async t => {
    const f = await fixture(t);
    for (const [headers, status, mensagem] of [
      [{}, 401, 'Acesso negado. Token nao fornecido'],
      [{ Authorization: 'Bearer invalido' }, 401, 'Token invalido ou expirado'],
      [f.headers('prestador'), 403, 'Acesso negado. Apenas clientes podem realizar esta acao']
    ]) json(await f.request(method, url, headers, input), status, { mensagem });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.notifications, []);
    assert.deepEqual(f.dispatches, []);
  });
}

test('POST HTTP usa cliente JWT e vinculos do agendamento, ignorando identidades forjadas', async t => {
  const f = await fixture(t);
  const row = { _id: AVALIACAO, cliente_id: CLIENTE, prestador_id: PRESTADOR, servico_id: SERVICO, ...input };
  json(await f.request('POST', '/api/avaliacoes', f.headers('cliente'),
    { ...input, cliente_id: OUTRO, prestador_id: OUTRO, servico_id: OUTRO }), 201,
  { mensagem: 'Avaliacao registrada com sucesso', avaliacao: row });
  assert.deepEqual(f.writes, [row]);
  assert.deepEqual(f.calls.slice(0, 2), [{ op: 'findById', value: AGENDAMENTO },
    { op: 'findOne', value: { agendamento_id: AGENDAMENTO } }]);
  assert.deepEqual(f.notifications, [[PRESTADOR, 'Voce recebeu uma nova avaliacao', 'avaliacao', '/perfil_prestador.html']]);
  assert.deepEqual(f.dispatches, []);
});

for (const [label, options, status, body] of [
  ['outra conta', { owner: OUTRO }, 403, { mensagem: 'Voce nao tem permissao para avaliar este agendamento' }],
  ['inexistente', { missing: true }, 404, { mensagem: 'Agendamento nao encontrado' }],
  ['duplicado', { duplicate: true }, 400, { mensagem: 'Este agendamento ja foi avaliado', codigo: 'AVALIACAO_DUPLICADA' }]
]) test(`POST HTTP rejeita agendamento ${label} sem criar nem notificar`, async t => {
  const f = await fixture(t, options);
  json(await f.request('POST', '/api/avaliacoes', f.headers('cliente'), input), status, body);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.notifications, []);
});

test('POST HTTP conserva validacao de ID e tipo numerico da nota antes da consulta', async t => {
  const f = await fixture(t);
  json(await f.request('POST', '/api/avaliacoes', f.headers('cliente'), { ...input, agendamento_id: 'invalido' }),
    400, { mensagem: 'Informe um agendamento valido' });
  json(await f.request('POST', '/api/avaliacoes', f.headers('cliente'), { ...input, nota: '4' }),
    400, { mensagem: 'A nota deve ser entre 1 e 5' });
  assert.deepEqual(f.calls, []);
});

test('GET cliente HTTP filtra pela sessao e preserva contagem e deduplicacao dos vinculos', async t => {
  const f = await fixture(t, { records: [
    { cliente_id: CLIENTE, agendamento_id: AGENDAMENTO }, { cliente_id: CLIENTE, agendamento_id: AGENDAMENTO },
    { cliente_id: CLIENTE }, { cliente_id: OUTRO, agendamento_id: OUTRO }
  ] });
  json(await f.request('GET', '/api/avaliacoes/cliente?cliente_id=' + OUTRO, f.headers('cliente')),
    200, { total: 3, agendamentos_avaliados: [AGENDAMENTO] });
  assert.deepEqual(f.calls, [{ op: 'find', value: { cliente_id: CLIENTE } },
    { op: 'select', value: 'agendamento_id' }, { op: 'lean', value: null }]);
});

test('GET cliente sem avaliacoes retorna o envelope vazio atual', async t => {
  const f = await fixture(t, { records: [{ cliente_id: OUTRO, agendamento_id: OUTRO }] });
  json(await f.request('GET', '/api/avaliacoes/cliente', f.headers('cliente')),
    200, { total: 0, agendamentos_avaliados: [] });
});

for (const invalidToken of [false, true]) {
  test(`consultas HTTP de prestador permanecem publicas, token invalido=${invalidToken}`, async t => {
    const id = PRESTADOR.toUpperCase();
    const f = await fixture(t, { records: [
      { prestador_id: id, nota: 5, comentario: 'Bom', cliente_id: { nome: 'Cliente ficticio', email: 'privado@example.invalid' },
        agendamento_id: AGENDAMENTO, servico_id: SERVICO, _id: AVALIACAO },
      { prestador_id: id, nota: 4, cliente_id: null }, { prestador_id: OUTRO, nota: 1 }
    ], aggregate: [{ media: 4.666, total: 3 }] });
    const headers = invalidToken ? { Authorization: 'Bearer invalido' } : {};
    json(await f.request('GET', '/api/avaliacoes/prestador/' + id, headers), 200,
      [{ nota: 5, comentario: 'Bom', cliente_id: { nome: 'Cliente ficticio' } },
        { nota: 4, comentario: '', cliente_id: { nome: 'Cliente' } }]);
    json(await f.request('GET', '/api/avaliacoes/prestador/' + id + '/media', headers), 200, { media: 4.7, total: 3 });
    assert.deepEqual(f.calls, [
      { op: 'find', value: { prestador_id: id } }, { op: 'populate', value: ['cliente_id', 'nome'] },
      { op: 'sort', value: { data_criacao: -1 } }, { op: 'aggregate', value: [
        { $match: { prestador_id: PRESTADOR } },
        { $group: { _id: '$prestador_id', media: { $avg: '$nota' }, total: { $sum: 1 } } }
      ] }
    ]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.dispatches, []);
  });
}

test('consultas publicas vazias preservam array e media zero; ID invalido tem contratos distintos', async t => {
  const f = await fixture(t);
  json(await f.request('GET', '/api/avaliacoes/prestador/' + PRESTADOR), 200, []);
  json(await f.request('GET', '/api/avaliacoes/prestador/' + PRESTADOR + '/media'), 200, { media: 0, total: 0 });
  const before = plain(f.calls);
  json(await f.request('GET', '/api/avaliacoes/prestador/invalido'), 400, { mensagem: 'Informe um prestador valido' });
  const res = await f.request('GET', '/api/avaliacoes/prestador/invalido/media');
  assert.equal(res.status, 500);
  const body = JSON.parse(res.text);
  assert.deepEqual(Object.keys(body).sort(), ['erro', 'mensagem']);
  assert.equal(body.mensagem, 'Erro ao calcular media');
  assert.match(body.erro, /Argument passed in/);
  assert.deepEqual(f.calls, before);
});

for (const [method, url, failure, mensagem] of [
  ['POST', '/api/avaliacoes', 'create', 'Erro ao criar avaliacao'],
  ['GET', '/api/avaliacoes/cliente', 'lean', 'Erro ao consultar suas avaliacoes'],
  ['GET', '/api/avaliacoes/prestador/' + PRESTADOR, 'sort', 'Erro ao listar avaliacoes'],
  ['GET', '/api/avaliacoes/prestador/' + PRESTADOR + '/media', 'aggregate', 'Erro ao calcular media']
]) test(`${method} ${url} preserva erro HTTP de ${failure}`, async t => {
  const f = await fixture(t, { failure });
  const body = failure === 'aggregate' ? { mensagem, erro: 'falha-sintetica-avaliacoes' } : { mensagem };
  json(await f.request(method, url, f.headers('cliente'), input), 500, body);
  assert.equal(f.calls.at(-1).op, failure);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.notifications, []);
});

test('avaliacoes preservam barra final, HEAD, OPTIONS e rejeicao de caminhos semelhantes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/avaliacoes/', f.headers('cliente'), input)).status, 201);
  for (const url of ['/api/avaliacoes/cliente', '/api/avaliacoes/prestador/' + PRESTADOR,
    '/api/avaliacoes/prestador/' + PRESTADOR + '/media']) {
    assert.equal((await f.request('GET', url + '/', f.headers('cliente'))).status, 200);
    const head = await f.request('HEAD', url, f.headers('cliente'));
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  }
  assert.equal((await f.request('HEAD', '/api/avaliacoes/cliente')).status, 401);
  const before = plain(f.calls);
  for (const url of ['/api/avaliacoes', '/api/avaliacoes/cliente', '/api/avaliacoes/prestador/' + PRESTADOR,
    '/api/avaliacoes/prestador/' + PRESTADOR + '/media']) {
    assert.equal((await f.request('OPTIONS', url)).status, 204);
    assert.equal((await f.request('PUT', url, f.headers('cliente'), input)).status, 404);
    assert.equal((await f.request('GET', url + '/extra', f.headers('cliente'))).status, 404);
  }
  assert.deepEqual(f.calls, before);
  assert.deepEqual(f.dispatches, []);
});
