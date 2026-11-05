'use strict';

// Ensaio fixo: nunca aceita URI, banco, credenciais ou arquivos de backup externos.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ObjectId, BSON } = require('mongoose').mongo;
const { disposableMongo } = require('../tests/helpers/disposableMongo');
const { pairKey, validChat, hasPairIndex, PAIR_INDEX } = require('../utils/chatIntegrity');

function findTool(name) {
  const candidates = [name];
  if (process.platform === 'win32') candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MongoDB', 'Tools', '100', 'bin', name + '.exe'));
  for (const binary of candidates) {
    const check = spawnSync(binary, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (!check.error && check.status === 0) {
      const version = check.stdout.match(new RegExp('^' + name + ' version: (\\d+\\.\\d+\\.\\d+)', 'm'));
      if (version) return { binary, version: version[1] };
    }
  }
  throw Error(name.toUpperCase() + '_UNAVAILABLE');
}

async function runTool(binary, args) {
  // Nao retransmite stdout/stderr: ferramentas podem incluir namespaces e dados de erros.
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore', timeout: 30000 });
    child.once('error', () => reject(Error('BACKUP_TOOL_FAILED')));
    child.once('exit', code => code === 0 ? resolve() : reject(Error('BACKUP_TOOL_FAILED')));
  });
}

function fixtures() {
  const ids = ['1', '2', '3'].map(char => new ObjectId(char.repeat(24)));
  const when = new Date('2026-01-01T12:00:00.000Z');
  let sequence = 10;
  const nextId = () => new ObjectId((sequence++).toString(16).padStart(24, '0'));
  const message = (sender, receiver, read = false) => ({
    _id: nextId(), sender, receiver, content: 'Mensagem fictícia de ensaio: ação ✓', read,
    ...(read ? { readAt: when } : {}), createdAt: when, updatedAt: when
  });
  const chat = (a, b, messages, legacy = false) => ({
    _id: nextId(), participants: [a, b], ...(legacy ? {} : { pairKey: pairKey([a, b]) }),
    messages, isActive: !legacy, lastMessage: when, createdAt: when, updatedAt: when, __v: 0
  });
  return {
    usuarios: ids.map((_id, i) => ({ _id, nome: 'Fixture ' + (i + 1), email: 'fixture' + i + '@example.invalid', createdAt: when })),
    chats: [
      chat(ids[0], ids[1], [message(ids[0], ids[1]), message(ids[1], ids[0], true), message(ids[0], ids[1], true), message(ids[1], ids[0])]),
      chat(ids[0], ids[2], [message(ids[0], ids[2]), message(ids[2], ids[0], true)]),
      chat(ids[2], ids[1], [message(ids[1], ids[2])], true)
    ]
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

async function snapshot(db) {
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray()).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(collections.map(item => item.name), ['chats', 'usuarios']);
  const result = {};
  for (const collection of collections) {
    const documents = await db.collection(collection.name).find({}).sort({ _id: 1 }).toArray();
    const indexes = (await db.collection(collection.name).listIndexes().toArray()).sort((a, b) => a.name.localeCompare(b.name));
    result[collection.name] = {
      documents: documents.map(doc => BSON.serialize(doc).toString('hex')),
      indexes: JSON.stringify(stable(indexes)),
      options: JSON.stringify(stable(collection.options)), type: collection.type
    };
  }
  return result;
}

async function verifyIntegrity(db) {
  const users = await db.collection('usuarios').find({}).toArray();
  const chats = await db.collection('chats').find({}).toArray();
  assert.equal(await db.collection('usuarios').countDocuments(), 3);
  assert.equal(await db.collection('chats').countDocuments(), 3);
  const userIds = new Set(users.map(user => user._id.toHexString()));
  const pairs = new Set();
  let messages = 0, read = 0, inactive = 0, legacy = 0;
  for (const chat of chats) {
    assert.ok(validChat(chat));
    assert.ok(chat.participants.every(id => id instanceof ObjectId && userIds.has(id.toHexString())));
    const key = pairKey(chat.participants);
    assert.ok(!pairs.has(key)); pairs.add(key);
    if (chat.pairKey === undefined) legacy++;
    if (!chat.isActive) inactive++;
    for (const message of chat.messages) {
      assert.ok(message.sender instanceof ObjectId && message.receiver instanceof ObjectId);
      assert.ok(userIds.has(message.sender.toHexString()) && userIds.has(message.receiver.toHexString()));
      assert.ok(message._id instanceof ObjectId && message.createdAt instanceof Date);
      if (message.read) { read++; assert.ok(message.readAt instanceof Date); }
      messages++;
    }
  }
  assert.equal(messages, 7); assert.equal(read, 3); assert.equal(inactive, 1); assert.equal(legacy, 1);
  const indexes = await db.collection('chats').listIndexes().toArray();
  assert.ok(hasPairIndex(indexes)); assert.equal(indexes.length, 5);
  assert.equal((await db.collection('usuarios').listIndexes().toArray()).length, 2);
  return { usuarios: users.length, conversas: chats.length, mensagens: messages, mensagens_lidas: read, conversas_inativas: inactive, conversas_sem_pair_key: legacy, indices_chats: indexes.length, indices_usuarios: 2 };
}

async function databaseAbsent(client, name) {
  const databases = await client.db('admin').admin().listDatabases({ nameOnly: true });
  assert.ok(!databases.databases.some(db => db.name === name));
}

async function rehearsal() {
  let mongo, directory, report, stage = 'pre_condicoes', failed = false, cleaned = true;
  try {
    if (process.argv.length !== 2) throw Error('BACKUP_ARGUMENTS_FORBIDDEN');
    const dump = findTool('mongodump'), restore = findTool('mongorestore');
    stage = 'instancia_descartavel';
    mongo = await disposableMongo();
    const endpoint = new URL(mongo.uri);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.ok(/^\d+$/.test(endpoint.port) && Number(endpoint.port) !== 27017);
    const status = await mongo.client.db('admin').command({ serverStatus: 1 });
    assert.equal(status.pid, mongo.pid);
    const suffix = randomBytes(12).toString('hex');
    const sourceName = 'iservice_backup_fixture_src_' + suffix;
    const targetName = 'iservice_backup_fixture_dst_' + suffix;
    assert.notEqual(sourceName, targetName);
    await databaseAbsent(mongo.client, sourceName); await databaseAbsent(mongo.client, targetName);
    const source = mongo.client.db(sourceName), target = mongo.client.db(targetName);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iservice-chat-backup-'));
    const archive = path.join(directory, 'fixture.archive.gz');
    stage = 'preparacao_ficticia';
    await source.createCollection('usuarios');
    await source.createCollection('chats', { validator: { $jsonSchema: { bsonType: 'object', required: ['participants', 'messages'], properties: { participants: { bsonType: 'array', minItems: 2, maxItems: 2 }, messages: { bsonType: 'array' } } } }, validationLevel: 'strict', validationAction: 'error' });
    await source.collection('usuarios').createIndex({ email: 1 }, { unique: true, name: 'fixture_email_unique' });
    await source.collection('chats').createIndex({ pairKey: 1 }, { name: PAIR_INDEX, unique: true, partialFilterExpression: { pairKey: { $type: 'string' } } });
    await source.collection('chats').createIndex({ participants: 1 });
    await source.collection('chats').createIndex({ 'messages.sender': 1 });
    await source.collection('chats').createIndex({ lastMessage: -1 });
    const fixture = fixtures();
    await source.collection('usuarios').insertMany(fixture.usuarios);
    await source.collection('chats').insertMany(fixture.chats);
    const expected = await snapshot(source);
    const sourceCounts = await verifyIntegrity(source);
    const connection = ['--host', '127.0.0.1', '--port', endpoint.port];
    stage = 'backup';
    let started = performance.now();
    await runTool(dump.binary, [...connection, '--db', sourceName, '--archive=' + archive, '--gzip']);
    const dumpMs = performance.now() - started;
    const bytes = await fs.readFile(archive); assert.ok(bytes.length > 0);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(await snapshot(source), expected);
    stage = 'restauracao';
    await databaseAbsent(mongo.client, targetName);
    assert.equal((await mongo.client.db('admin').command({ serverStatus: 1 })).pid, mongo.pid);
    started = performance.now();
    await runTool(restore.binary, [...connection, '--archive=' + archive, '--gzip', '--nsInclude=' + sourceName + '.*', '--nsFrom=' + sourceName + '.*', '--nsTo=' + targetName + '.*', '--stopOnError', '--objcheck']);
    const restoreMs = performance.now() - started;
    stage = 'verificacao';
    assert.deepEqual(await snapshot(target), expected);
    assert.deepEqual(await snapshot(source), expected);
    assert.deepEqual(await verifyIntegrity(target), sourceCounts);
    assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'), digest);
    report = {
      concluido: true, mongodb: status.version, mongodump: dump.version, mongorestore: restore.version,
      instancia_propria_confirmada: true, porta_27017_utilizada: false, destino_novo_confirmado: true,
      backup: { concluido: true, bytes: bytes.length, tempo_ms: Math.round(dumpMs) },
      restauracao: { concluida: true, tempo_ms: Math.round(restoreMs) },
      dados: sourceCounts, documentos_bson_identicos: true, indices_identicos: true,
      opcoes_colecoes_identicas: true, origem_preservada: true, arquivo_sha256_inalterado: true, integridade_validada: true
    };
  } catch (error) {
    failed = true;
    const code = ['MONGODUMP_UNAVAILABLE', 'MONGORESTORE_UNAVAILABLE', 'BACKUP_ARGUMENTS_FORBIDDEN'].includes(error.message) ? error.message : 'BACKUP_REHEARSAL_FAILED';
    report = { concluido: false, erro: code, etapa: stage };
  } finally {
    // As duas limpezas sao tentadas mesmo que uma delas falhe.
    if (mongo) { try { await mongo.cleanup(); } catch { cleaned = false; } }
    if (directory) {
      try {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('iservice-chat-backup-'));
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        assert.equal(await fs.stat(resolved).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
      } catch { cleaned = false; }
    }
  }
  report.recursos_temporarios_limpos = cleaned;
  if (!cleaned) { report.concluido = false; report.erro = 'BACKUP_REHEARSAL_CLEANUP_FAILED'; }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = failed || !cleaned ? 1 : 0;
}

rehearsal();
