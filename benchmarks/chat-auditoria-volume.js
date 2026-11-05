'use strict';

// Ensaio explicito, fora da descoberta de node --test. Nao aceita URI nem banco externo.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { MongoClient, ObjectId } = require('mongoose').mongo;
const { auditChats } = require('../scripts/lib/chatAudit');
const { main: auditCli } = require('../scripts/auditChats');
const { disposableMongo } = require('../tests/helpers/disposableMongo');

const PROFILES = [
  { nome: 'pequeno', conversas: 300, mensagensPorConversa: 20, historicosLongos: 4, mensagensPorHistoricoLongo: 500 },
  { nome: 'ampliado', conversas: 1200, mensagensPorConversa: 100, historicosLongos: 8, mensagensPorHistoricoLongo: 1500 }
];
const mb = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100;
const round = value => Math.round(value * 100) / 100;
const provider = new ObjectId('a'.repeat(24));
const text = 'MENSAGEM TOTALMENTE FICTICIA PARA ENSAIO LOCAL. '.repeat(3);
const id = i => new ObjectId((i + 1000).toString(16).padStart(24, '0'));
let phase = 'inicializacao';
let lastDriverCode = null;

async function seed(client, profile) {
  const db = client.db('iservice_chat_audit_volume_' + profile.nome);
  await db.createCollection('chats'); await db.createCollection('usuarios');
  // Apenas a fixture usa insertMany. A conexao de auditoria permanece separada.
  await db.collection('usuarios').insertMany([{ _id: provider }, ...Array.from({ length: profile.conversas }, (_, i) => ({ _id: id(i) }))]);
  let batch = [], totalMessages = 0, missingKeys = 0, inactive = 0;
  for (let i = 0; i < profile.conversas; i++) {
    const clientId = id(i % 5 === 4 ? i - 1 : i);
    const length = i < profile.historicosLongos ? profile.mensagensPorHistoricoLongo : profile.mensagensPorConversa;
    const document = { participants: [clientId, provider], isActive: i % 4 !== 0,
      messages: Array.from({ length }, (_, m) => ({ sender: m % 2 ? provider : clientId, receiver: m % 2 ? clientId : provider, content: text, read: false })) };
    if (i % 3 === 0) missingKeys++;
    else document.pairKey = [clientId.toHexString(), provider.toHexString()].sort().join(':');
    if (!document.isActive) inactive++;
    totalMessages += length; batch.push(document);
    if (batch.length === 25) { await db.collection('chats').insertMany(batch); batch = []; }
  }
  if (batch.length) await db.collection('chats').insertMany(batch);
  return { db, expected: { messages: totalMessages, missingKeys, inactive, groups: Math.floor(profile.conversas / 5) } };
}

async function measure(client, operation) {
  const admin = client.db('admin');
  const cpu = process.cpuUsage();
  let peakClient = process.memoryUsage().rss, peakMongo = 0, samples = 0, failures = 0, sampling;
  async function sample() {
    peakClient = Math.max(peakClient, process.memoryUsage().rss);
    const status = await admin.command({ serverStatus: 1 });
    const resident = status.mem.resident * 1024 * 1024;
    peakMongo = Math.max(peakMongo, resident); samples++;
    return { resident, cache: status.wiredTiger.cache['bytes currently in the cache'], read: status.wiredTiger.cache['bytes read into cache'] };
  }
  const first = await sample();
  const timer = setInterval(() => {
    if (!sampling) sampling = sample().catch(() => { failures++; }).finally(() => { sampling = null; });
  }, 100);
  const start = performance.now();
  try {
    let result, failure;
    try { result = await operation(); } catch (error) { failure = error; }
    const elapsed = performance.now() - start;
    clearInterval(timer); if (sampling) await sampling;
    const last = await sample(), cpuDelta = process.cpuUsage(cpu);
    return { result, failure, metrics: {
      duracao_ms: round(elapsed), cpu_processo_node_ms: round((cpuDelta.user + cpuDelta.system) / 1000),
      rss_node_pico_amostrado_mb: mb(peakClient), rss_mongo_inicio_mb: mb(first.resident), rss_mongo_pico_amostrado_mb: mb(peakMongo),
      rss_mongo_fim_mb: mb(last.resident), cache_mongo_inicio_mb: mb(first.cache), cache_mongo_fim_mb: mb(last.cache),
      bytes_lidos_cache_delta_mb: mb(Math.max(0, last.read - first.read)), amostras: samples, falhas_amostragem: failures
    } };
  } finally { clearInterval(timer); if (sampling) await sampling; }
}

function checkReport(report, profile, expected) {
  assert.equal(report.conversas.total, profile.conversas);
  assert.equal(report.mensagens.total, expected.messages);
  assert.equal(report.conversas.pair_key_ausente, expected.missingKeys);
  assert.equal(report.conversas.inativas, expected.inactive);
  assert.equal(report.pares.grupos_duplicados, expected.groups);
  assert.equal(report.pares.conversas_excedentes, expected.groups);
  assert.equal(report.mensagens.inconsistentes, 0);
}

async function cliProbe(mongo, database, { maxTimeMS, interrupt = false } = {}) {
  let stdout = '', stderr = '', driverCode = null, aggregateStarted;
  const started = new Promise(resolve => { aggregateStarted = resolve; });
  const start = performance.now();
  const args = ['--local-disposable', '--uri', mongo.uri, '--database', database];
  if (maxTimeMS) args.push('--max-time-ms', String(maxTimeMS));
  const operation = auditCli(args, {
    stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    createClient(uri, options) {
      const reader = new MongoClient(uri, { ...options, monitorCommands: true, retryReads: false });
      reader.on('commandStarted', event => { if (event.commandName === 'aggregate') aggregateStarted(); });
      reader.on('commandFailed', event => { if (event.commandName === 'aggregate' && Number.isInteger(event.failure.code)) driverCode = event.failure.code; });
      return reader;
    }
  });
  let interruption;
  if (interrupt) {
    interruption = (async () => {
      // Nao aguardar indefinidamente se a conexao falhar antes do aggregate.
      const issued = await Promise.race([started.then(() => true), operation.then(() => false)]);
      assert.equal(issued, true);
      await new Promise(resolve => setTimeout(resolve, 20));
      await mongo.stop();
    })();
  }
  const status = await operation;
  if (interruption) await interruption;
  const result = { duracao_ms: round(performance.now() - start), status_cli: status, codigo_driver: driverCode,
    relatorio_emitido: stdout !== '', relatorio_parcial: status === 2 && stdout !== '' };
  if (status === 2) {
    assert.equal(stdout, '');
    assert.deepEqual(JSON.parse(stderr), { erro: 'AUDIT_READ_FAILED', relatorio_completo: false });
    result.erro_publico = 'AUDIT_READ_FAILED';
  } else {
    assert.equal(stderr, ''); assert.ok(status === 0 || status === 1);
    JSON.parse(stdout);
  }
  if (interrupt) assert.equal(status, 2);
  return result;
}

async function deadlineProbe(mongo, database) {
  const reader = new MongoClient(mongo.uri, { monitorCommands: true, retryReads: false, retryWrites: false });
  let code = null, failedCommand = null;
  reader.on('commandFailed', event => {
    if (['aggregate', 'listCollections'].includes(event.commandName) && Number.isInteger(event.failure.code)) {
      code = event.failure.code; failedCommand = event.commandName;
    }
  });
  try {
    await reader.connect();
    const start = performance.now();
    await assert.rejects(auditChats(reader.db(database), { maxTimeMS: 1 }), error => error.code === 'AUDIT_READ_FAILED' && error.message === 'AUDIT_READ_FAILED');
    assert.equal(code, 50, 'O teste exige MaxTimeMSExpired real do servidor');
    return { duracao_ms: round(performance.now() - start), limite_solicitado_ms: 1, interface: 'api_interna',
      codigo_driver: code, comando: failedCommand, erro_publico: 'AUDIT_READ_FAILED', relatorio_emitido: false, relatorio_parcial: false };
  } finally { await reader.close(); }
}

async function main() {
  if (process.argv.length !== 2) throw Error('Este ensaio nao aceita argumentos, URI ou configuracao de producao');
  const mongo = await disposableMongo();
  try {
    // Antes de semear, confirmar que a porta atende o processo que acabamos de criar.
    const identity = await mongo.client.db('admin').command({ serverStatus: 1 });
    assert.equal(identity.pid, mongo.pid);
    const info = await mongo.client.db('admin').command({ buildInfo: 1 });
    const results = { mongo_versao: info.version, plataforma: process.platform + '-' + process.arch,
      somente_dados_ficticios: true, cenarios: [], verificacoes: [] };
    let last;
    for (const profile of PROFILES) {
      phase = 'fixture_' + profile.nome;
      const fixture = await seed(mongo.client, profile);
      const reader = new MongoClient(mongo.uri, { appName: 'iservice-chat-audit-volume', monitorCommands: true, retryWrites: false, retryReads: false, maxPoolSize: 2 });
      reader.on('commandFailed', event => {
        if (event.commandName === 'aggregate' && Number.isInteger(event.failure.code)) lastDriverCode = event.failure.code;
      });
      try {
        await reader.connect();
        phase = 'medicao_' + profile.nome;
        lastDriverCode = null;
        const measured = await measure(mongo.client, () => auditChats(reader.db(fixture.db.databaseName), { maxTimeMS: 60000 }));
        phase = 'contagens_' + profile.nome;
        let status = 'concluido';
        if (measured.failure) {
          assert.equal(profile.nome, 'ampliado');
          assert.equal(measured.failure.code, 'AUDIT_READ_FAILED');
          assert.equal(lastDriverCode, 292, 'Apenas limite de memoria conhecido e um desfecho esperado neste cenario');
          assert.equal(measured.result, undefined);
          status = 'limite_memoria_sem_spill';
        } else checkReport(measured.result, profile, fixture.expected);
        results.cenarios.push({ ...profile, mensagens_total: fixture.expected.messages, sem_pair_key: fixture.expected.missingKeys,
          inativas: fixture.expected.inactive, grupos_duplicados: fixture.expected.groups, status,
          codigo_driver: lastDriverCode, relatorio_parcial: false, ...measured.metrics });
      } finally { await reader.close(); }
      last = fixture;
    }
    if (results.cenarios.at(-1).status === 'limite_memoria_sem_spill') {
      phase = 'limite_memoria_cli';
      const memory = await cliProbe(mongo, last.db.databaseName, { maxTimeMS: 60000 });
      assert.equal(memory.status_cli, 2); assert.equal(memory.codigo_driver, 292);
      results.verificacoes.push({ caso: 'limite_memoria_cli', ...memory });
    }
    phase = 'timeout';
    results.verificacoes.push({ caso: 'maxTimeMS_real_1', ...await deadlineProbe(mongo, last.db.databaseName) });
    phase = 'interrupcao';
    results.verificacoes.push({ caso: 'interrupcao_mongod_descartavel', ...await cliProbe(mongo, last.db.databaseName, { interrupt: true }) });
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } finally { await mongo.cleanup(); }
}

main().catch(error => {
  const code = ['AUDIT_INVALID_RESULT', 'AUDIT_READ_FAILED'].includes(error.code) ? error.code : null;
  process.stderr.write(JSON.stringify({ erro: 'LOCAL_VOLUME_CHECK_FAILED', etapa: phase, erro_auditoria: code, codigo_driver: lastDriverCode, dados_reais: false }) + '\n');
  process.exitCode = 1;
});
