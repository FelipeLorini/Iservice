const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const BaseChat = require('../Models/chatModel');
const { A, B, C, index, controller, invoke } = require('./helpers/chatFixtures');
const probe = spawnSync('mongod', ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
const available = !probe.error && probe.status === 0;

// Nao aceita URI externa nem carrega .env. Sempre cria seu proprio processo e diretorio.
test('MongoDB descartavel: indice real, upserts concorrentes e isolamento de mensagens', {
  skip: available ? false : 'mongod ausente; executar esta integracao antes de publicar', timeout: 45000
}, async () => {
  const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iservice-chat-test-'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const number=server.address().port; server.close(()=>resolve(number)); });
  });
  const child = spawn('mongod', ['--dbpath', taskDir, '--bind_ip', '127.0.0.1', '--port', String(port), '--quiet'], { windowsHide: true, stdio: 'ignore' });
  let exited = false, spawnError;
  const closed = new Promise(resolve => { child.once('exit', () => { exited=true; resolve(); }); child.once('error', error => { spawnError=error; exited=true; resolve(); }); });
  const db = new mongoose.Mongoose();
  try {
    const uri='mongodb://127.0.0.1:'+port+'/iservice_chat_disposable';
    let connected=false;
    for(let i=0;i<60&&!connected;i++) {
      if(exited)throw spawnError||Error('MongoDB temporario encerrou antes da conexao');
      try { await db.connect(uri,{serverSelectionTimeoutMS:200,autoIndex:false,autoCreate:false}); connected=true; }
      catch(error){if(i===59)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    const Chat=db.model('Chat',BaseChat.schema.clone());
    const userSchema=require('../Models/usuarioModel').schema.clone();userSchema.set('autoIndex',false);userSchema.set('autoCreate',false);
    const Usuario=db.model('Usuario',userSchema);
    await db.connection.createCollection('usuarios');await db.connection.createCollection('chats');
    await Usuario.collection.insertMany([A,B,C].map((_id,i)=>({_id:new mongoose.Types.ObjectId(_id),nome:'Conta ficticia '+i,tipo:i===1?'prestador':'cliente',email:'teste'+i+'@example.invalid',telefone:'000000000',senha:'valor-sintetico-sem-login'})));
    const {api}=controller(Chat,Usuario);
    const start=(sender,receiver)=>invoke(api.startChat,{usuarioId:sender,body:{prestador_id:receiver}});
    assert.equal((await start(A,B)).code,503);
    const {key,...options}=index;await Chat.collection.createIndex(key,options);
    const results=await Promise.all(Array.from({length:20},(_,i)=>i%2?start(B,A):start(A,B)));
    assert.ok(results.every(r=>r.code===201));assert.equal(new Set(results.map(r=>r.body.chat._id)).size,1);assert.equal(await Chat.countDocuments(),1);
    const chatId=results[0].body.chat._id;
    assert.equal((await invoke(api.sendMessage,{usuarioId:A,body:{chat_id:chatId,content:'Texto sintetico exclusivo A-B'}})).code,201);
    const other=await start(C,B);assert.equal(other.code,201);assert.notEqual(other.body.chat._id,chatId);
    const empty=await invoke(api.getChatMessages,{usuarioId:C,params:{chatId:other.body.chat._id}});assert.equal(empty.code,200);assert.deepEqual(empty.body.messages,[]);
    assert.equal((await invoke(api.getChatMessages,{usuarioId:C,params:{chatId}})).code,403);
    const received=await invoke(api.getChatMessages,{usuarioId:B,params:{chatId}});assert.equal(received.body.messages.length,1);
    assert.equal((await invoke(api.markAsRead,{usuarioId:B,params:{chatId}})).body.marcadas,1);
    assert.equal((await Chat.findById(chatId)).messages[0].read,true);
    // Concorrencia real de documentos: uma versao antiga nao pode sobrescrever um envio.
    const older=await Chat.findById(chatId),newer=await Chat.findById(chatId);
    newer.messages.push({sender:B,receiver:A,content:'Resposta sintetica'});await newer.save();
    older.messages[0].readAt=new Date();await assert.rejects(older.save(),{name:'VersionError'});
    assert.equal((await Chat.findById(chatId)).messages.length,2);
  } finally {
    await db.disconnect();
    if(!exited)child.kill();
    await closed;
    const resolved=path.resolve(taskDir),tempRoot=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('iservice-chat-test-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
