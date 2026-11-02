'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOptions, main } = require('../scripts/auditChats');
const { auditChats, buildAuditPipeline, AuditError } = require('../scripts/lib/chatAudit');

const valid = ['--local-disposable', '--uri', 'mongodb://127.0.0.1:27017', '--database', 'iservice_chat_audit_fixture'];
function capture() { const output = { out: '', err: '' }; return { output, stdout: { write: x => { output.out += x; } }, stderr: { write: x => { output.err += x; } } }; }

test('CLI exige destino explicito local e rejeita SRV, credenciais, alternativas remotas e opcoes de escrita', async () => {
  for (const uri of ['mongodb+srv://cluster.example.invalid', 'mongodb://remote.invalid:27017', 'mongodb://localhost:27017',
    'mongodb://127.0.0.1:27017/?proxyHost=remote.invalid', 'mongodb://usuario:segredo@127.0.0.1:27017',
    'mongodb://127.0.0.1:27017,remote.invalid:27017', 'mongodb://127.0.0.1:99999', 'mongodb://127.0.0.1:27017\n']) {
    const io = capture(); let connections = 0;
    const args = [...valid]; args[2] = uri;
    const result = await main(args, { ...io, createClient() { connections++; } });
    assert.equal(result, 2); assert.equal(connections, 0); assert.equal(io.output.out, '');
    assert.doesNotMatch(io.output.err, /segredo|remote|cluster|usuario|mongodb/);
  }
  for (const args of [[], valid.slice(1), [...valid, '--uri', 'mongodb://127.0.0.1:27018'], [...valid, '--apply'],
    [...valid.slice(0,-1), 'production'], [...valid.slice(0,-1), 'iservice_chat_audit_fixture\n'], [...valid, '--max-time-ms', '0']]) {
    assert.throws(() => parseOptions(args), AuditError);
  }
  assert.equal(parseOptions(valid).database, 'iservice_chat_audit_fixture');
});

test('ajuda e independente de banco, ambiente e modelos', async () => {
  const io = capture(); const status = await main(['--help'], { ...io, createClient() { assert.fail('Nao conectar'); } });
  assert.equal(status, 0); assert.match(io.output.out, /Uso local/); assert.equal(io.output.err, '');
});

test('pipeline somente leitura possui projecao final de contagens e nao exporta conteudo', () => {
  const pipeline = buildAuditPipeline();
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { assert.ok(!['$out', '$merge', '$function', '$accumulator'].includes(key)); inspect(item); }
  }
  inspect(pipeline);
  const facet = pipeline.find(stage => stage.$facet).$facet;
  assert.ok(facet.totals);
  assert.deepEqual(facet.pairs.at(-1), { $project: { _id: 0, grupos: 1, excedentes: 1 } });
});

test('erros de leitura e conexao nao imprimem URI, documentos, stack ou relatorio parcial', async () => {
  const marker = 'PRIVADO-SINTETICO'; const io = capture(); let closes = 0;
  const code = await main(valid, { ...io, createClient() { return {
    async connect() { throw Error('mongodb://usuario:' + marker + '@host ' + marker); },
    async close() { closes++; }
  }; } });
  assert.equal(code, 2); assert.equal(closes, 1); assert.equal(io.output.out, ''); assert.doesNotMatch(io.output.err, /PRIVADO|mongodb|stack|usuario/);
  await assert.rejects(auditChats({ listCollections() { throw Error(marker); } }), error => error.code === 'AUDIT_READ_FAILED' && !error.message.includes(marker));
});

test('colecoes ausentes nao geram falso relatorio limpo', async () => {
  await assert.rejects(auditChats({ listCollections() { return { async toArray() { return [{ name: 'chats' }]; } }; } }), { code: 'AUDIT_COLLECTIONS_REQUIRED' });
});

test('opcoes invalidas e resultados malformados nao geram relatorio', async () => {
  await assert.rejects(auditChats({}, { maxTimeMS: 0 }), { code: 'AUDIT_INVALID_OPTIONS' });
  const db = { listCollections() { return { async toArray() { return ['chats','usuarios'].map(name=>({name})); } }; },
    collection() { return { aggregate() { return { async toArray() { return [{ totals: [{ c_total: 'PRIVADO' }], pairs: [], keys: [] }]; } }; } }; } };
  await assert.rejects(auditChats(db), { code: 'AUDIT_INVALID_RESULT' });
});
