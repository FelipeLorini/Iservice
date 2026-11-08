'use strict';
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { MongoClient } = require('mongoose').mongo;

function localBinary() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MongoDB/Server/8.0/bin/mongod.exe'), 'mongod']
    : ['mongod'];
  for (const binary of candidates) {
    const result = spawnSync(binary, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (!result.error && result.status === 0) return binary;
  }
  throw Error('MONGOD_REQUIRED: executavel local obrigatorio; nenhum download ou servidor alternativo');
}

async function disposableReplicaSet() {
  const binary = localBinary();
  const prefix = 'iservice-repl-test-';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const setName = 'iservice_' + randomUUID().replace(/-/g, '');
  const databaseName = 'iservice_tx_' + randomUUID().replace(/-/g, '');
  let child, closed, exited = false, client, port, uri;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function cleanup() {
    const errors = [];
    if (client) { try { await client.close(); } catch (error) { errors.push(error); } }
    if (child && !exited) child.kill();
    if (closed) {
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Processo temporario nao encerrou')), 15000);
      })]); } finally { clearTimeout(timer); }
    }
    // Nunca remover dbPath enquanto o processo ainda o utiliza.
    assert.ok(!child || exited);
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith(prefix));
    const real = await fs.realpath(resolved).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (real) {
      assert.equal(real, resolved);
      await fs.rm(resolved, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
    }
    if (errors.length) throw new AggregateError(errors, 'Falha ao fechar cliente temporario');
  }

  async function assertIdentity(candidate = client, initialized = true) {
    assert.ok(child && !exited && Number.isSafeInteger(child.pid) && child.pid > 0);
    const admin = candidate.db('admin');
    const server = await admin.command({ serverStatus: 1 });
    assert.equal(server.pid, child.pid);
    const options = (await admin.command({ getCmdLineOpts: 1 })).parsed;
    assert.equal(options.net.bindIp, '127.0.0.1'); assert.equal(options.net.port, port);
    assert.equal(path.resolve(options.storage.dbPath), path.resolve(directory));
    assert.equal(await fs.realpath(directory), path.resolve(directory));
    assert.deepEqual(options.replication, { replSet: setName });
    if (initialized) {
      const hello = await admin.command({ hello: 1 });
      assert.equal(hello.setName, setName); assert.equal(hello.isWritablePrimary, true);
      assert.deepEqual(hello.hosts, ['127.0.0.1:' + port]);
      assert.ok(Number.isFinite(hello.logicalSessionTimeoutMinutes));
    }
  }

  try {
    port = await new Promise((resolve, reject) => {
      const listener = net.createServer(); listener.on('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const selected = listener.address().port;
        listener.close(error => error ? reject(error) : resolve(selected));
      });
    });
    assert.ok(port > 0 && port !== 27017);
    const directUri = 'mongodb://127.0.0.1:' + port + '/?directConnection=true';
    child = spawn(binary, ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', String(port),
      '--replSet', setName, '--quiet'], { windowsHide: true, stdio: 'ignore' });
    let startError;
    closed = new Promise(resolve => {
      child.once('close', () => { exited = true; resolve(); });
      child.once('error', error => { startError = error; });
    });
    client = new MongoClient(directUri, { serverSelectionTimeoutMS: 500, connectTimeoutMS: 1000 });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (exited || startError) throw startError || Error('Processo temporario encerrou durante inicializacao');
      try { await client.connect(); await client.db('admin').command({ ping: 1 }); ready = true; break; }
      catch (error) { if (attempt === 59) throw error; await delay(100); }
    }
    assert.ok(ready);
    // Unica inicializacao administrativa: autorizada SOMENTE depois de identificar o processo criado.
    await assertIdentity(client, false);
    const before = await client.db('admin').command({ hello: 1 });
    assert.equal(before.setName, undefined, 'Nao inicializar replica set preexistente');
    await client.db('admin').command({ replSetInitiate: {
      _id: setName, members: [{ _id: 0, host: '127.0.0.1:' + port }]
    } });
    let primary = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (exited) throw Error('Replica set temporario encerrou');
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary && hello.setName === setName) { primary = true; break; }
      await delay(100);
    }
    assert.ok(primary, 'Replica set temporario nao e primary');
    await assertIdentity();
    uri = 'mongodb://127.0.0.1:' + port + '/?replicaSet=' + setName + '&directConnection=true';
    const url = new URL(uri);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(url.searchParams.get('replicaSet'), setName);
    return { uri, client, port, pid: child.pid, directory, setName, databaseName, assertIdentity, cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Inicializacao e limpeza falharam'); }
    throw error;
  }
}

module.exports = { disposableReplicaSet };
