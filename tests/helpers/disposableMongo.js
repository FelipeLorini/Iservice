'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { MongoClient } = require('mongoose').mongo;

function mongodBinary() {
  const candidates = [process.env.MONGOD_BINARY, 'mongod'];
  if (process.platform === 'win32') candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MongoDB/Server/8.0/bin/mongod.exe'));
  for (const binary of candidates.filter(Boolean)) {
    const check = spawnSync(binary, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (!check.error && check.status === 0) return binary;
  }
  throw Error('MONGOD_REQUIRED: instale mongod ou configure MONGOD_BINARY para os testes descartaveis');
}

async function disposableMongo({ auth = false } = {}) {
  const binary = mongodBinary();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iservice-chat-audit-'));
  let processHandle, exited = false, closeProcess, client;
  const stop = async () => {
    if (processHandle && !exited) processHandle.kill();
    if (closeProcess) await closeProcess;
  };
  const cleanup = async () => {
    if (client) await client.close();
    await stop();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('iservice-chat-audit-')) throw Error('Diretorio temporario inesperado');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    if (port === 27017) throw Error('Porta padrao proibida para MongoDB descartavel');
    const uri = 'mongodb://127.0.0.1:' + port;
    const args = ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', String(port), '--quiet'];
    if (auth) args.push('--auth');
    processHandle = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
    let startError;
    closeProcess = new Promise(resolve => {
      processHandle.once('exit', () => { exited = true; resolve(); });
      processHandle.once('error', error => { startError = error; exited = true; resolve(); });
    });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      if (exited) throw startError || Error('MongoDB descartavel encerrou');
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 200 });
      try { await client.connect(); await client.db('admin').command({ ping: 1 }); ready = true; }
      catch (error) { await client.close(); if (attempt === 59) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (auth) {
      await client.db('admin').command({ createUser: 'fixture_admin', pwd: 'senha-sintetica-fixture', roles: ['root'] });
      await client.close();
      client = new MongoClient(uri, { auth: { username: 'fixture_admin', password: 'senha-sintetica-fixture' }, authSource: 'admin' });
      await client.connect();
    }
    return { uri, client, cleanup, stop, pid: processHandle.pid };
  } catch (error) { await cleanup(); throw error; }
}
module.exports = { disposableMongo };
