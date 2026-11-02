const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Chat = require('../Models/chatModel');
const { pairKey, hasPairIndex } = require('../utils/chatIntegrity');
const { A, B, C, D, index, invoke, fixture } = require('./helpers/chatFixtures');

test('A-B, A-C e C-B sao pares distintos e isolam conteudos por cliente e prestador', async () => {
  const f = fixture();
  const ab = await f.start(A,B), ac = await f.start(A,D), cb = await f.start(C,B);
  assert.deepEqual([ab.code,ac.code,cb.code], [201,201,201]);
  assert.equal(new Set([ab.body.chat._id,ac.body.chat._id,cb.body.chat._id]).size,3);
  const sent = await invoke(f.api.sendMessage,{usuarioId:A,body:{chat_id:ab.body.chat._id,content:'Texto sintetico A-B'}});
  assert.equal(sent.code,201); assert.equal(sent.body.message.receiver,B);
  for (const [usuarioId,result] of [[A,ac],[C,cb]]) {
    const got=await invoke(f.api.getChatMessages,{usuarioId,params:{chatId:result.body.chat._id}});
    assert.equal(got.code,200); assert.deepEqual(got.body.messages,[]);
  }
  assert.equal((await f.start(A,B)).body.chat._id,ab.body.chat._id);
  assert.equal(f.creates,3);
});

test('A-B e B-A, inclusive hexadecimal maiusculo, recuperam o mesmo par', async () => {
  const f=fixture(); const ab=await f.start(A,B.toUpperCase()), ba=await f.start(B,A);
  assert.equal(ab.body.chat._id,ba.body.chat._id);
  assert.equal(ab.body.chat.pairKey,pairKey([B,A])); assert.equal(f.creates,1);
});

test('chat consigo mesmo e rejeitado antes de consultar, mesmo com conversa anterior', async () => {
  const f=fixture(); f.add([A,B]);
  assert.equal((await f.start(A,A)).code,400); assert.equal(f.queries,0); assert.equal(f.creates,0);
});

for(const value of [undefined,null,'','abcdefghijkl','g'.repeat(24),B+'\n',B+'\r\n',123,{$ne:null},{_id:B},[B]]) {
  test('entrada de destinatario exige string hexadecimal: '+JSON.stringify(value),async()=>{
    const f=fixture(); assert.equal((await invoke(f.api.startChat,{body:{prestador_id:value}})).code,400); assert.equal(f.queries,0);
  });
  test('consulta, envio e leitura rejeitam ID invalido antes do banco: '+JSON.stringify(value),async()=>{
    const f=fixture();
    for(const handler of ['getChatMessages','sendMessage','markAsRead']) {
      const res=await invoke(f.api[handler],{body:{chat_id:value,content:'Sintetico'},params:{chatId:value}});
      assert.equal(res.code,400);
    }
    assert.equal(f.lookups,0);
  });
}

test('usuario ausente e destinatario inexistente sao rejeitados; sessao invalida nao consulta',async()=>{
  const f=fixture({users:[A]});
  assert.equal((await f.start(A,B)).code,404); assert.equal((await f.start(C,A)).code,401);
  assert.equal((await f.start('invalido',A)).code,401); assert.equal(f.creates,0);
});

test('chat inexistente retorna 404 e terceiro nao le, envia nem marca',async()=>{
  const f=fixture(); const chat=f.add([A,B]);
  for(const handler of ['getChatMessages','sendMessage','markAsRead']) {
    const request={usuarioId:C,body:{chat_id:chat._id,content:'Sintetico'},params:{chatId:chat._id}};
    const denied=await invoke(f.api[handler],request); assert.equal(denied.code,403); assert.equal(denied.body.messages,undefined);
    request.body.chat_id='f'.repeat(24);request.params.chatId='f'.repeat(24);
    assert.equal((await invoke(f.api[handler],request)).code,404);
  }
  assert.equal(f.saves,0);assert.equal(chat.messages.length,0);
});

for(const [label,participants,extra] of [
  ['duplicados',[A,A],{}],['extras',[A,B,C],{}],['um participante',[A],{}],
  ['chave divergente',[A,B],{pairKey:pairKey([A,C])}],['inativo',[A,B],{isActive:false}],
  ['mensagem externa',[A,B],{messages:[{sender:A,receiver:C,content:'Nao divulgar'}]}],
  ['mensagem para si',[A,B],{messages:[{sender:A,receiver:A,content:'Nao divulgar'}]}]
]) test('documento '+label+' bloqueia leitura, envio e marcacao sem alterar historico',async()=>{
  const f=fixture();const chat=f.add(participants,extra);
  for(const handler of ['getChatMessages','sendMessage','markAsRead']) {
    const r=await invoke(f.api[handler],{body:{chat_id:chat._id,content:'Sintetico'},params:{chatId:chat._id}});
    assert.equal(r.code,409); assert.equal(r.body.messages,undefined);
  }
  assert.equal(f.saves,0);
});

test('listagem e nao lidas omitem chats inconsistentes, removidos e alheios',async()=>{
  const f=fixture();const good=f.add([A,B],{messages:[{sender:B,receiver:A,content:'Valida',read:false}]});
  f.add([A,B,C]);f.add([A,A]);f.add([A,'f'.repeat(24)]);
  f.add([A,D],{messages:[{sender:B,receiver:A,content:'Nao divulgar',read:false}]});
  f.add([C,B],{messages:[{sender:B,receiver:C,content:'Nao divulgar',read:false}]});
  const list=await invoke(f.api.getUserChats);assert.equal(list.code,200);assert.deepEqual(list.body.map(c=>c.id),[good._id]);
  const unread=await invoke(f.api.getUnreadCount);assert.equal(unread.code,200);assert.equal(unread.body.total_nao_lidas,1);
});

test('participante removido bloqueia envio e consulta sem escrever',async()=>{
  const f=fixture();const chat=f.add([A,B]);f.users.delete(B);
  assert.equal((await invoke(f.api.sendMessage,{body:{chat_id:chat._id,content:'Teste'}})).code,409);
  assert.equal((await invoke(f.api.getChatMessages,{params:{chatId:chat._id}})).code,409);assert.equal(f.saves,0);
});

test('GET nao salva nem altera leitura; PUT marca somente recebidas',async()=>{
  const f=fixture();const chat=f.add([A,B],{messages:[{sender:B,receiver:A,content:'Recebida',read:false},{sender:A,receiver:B,content:'Enviada',read:false}]});
  assert.equal((await invoke(f.api.getChatMessages,{params:{chatId:chat._id}})).code,200);
  assert.equal(f.saves,0);assert.equal(chat.messages[0].read,false);
  assert.equal((await invoke(f.api.markAsRead,{params:{chatId:chat._id}})).body.marcadas,1);
  assert.equal(chat.messages[1].read,false);
});

test('legado integro sem pairKey e reutilizado sem backfill ou exigencia de indice',async()=>{
  const f=fixture({noIndex:true});const old=f.add([A,B]);
  const r=await f.start();assert.equal(r.code,201);assert.equal(r.body.chat._id,old._id);
  assert.equal(old.pairKey,undefined);assert.equal(f.saves,0);assert.equal(f.creates,0);
});

test('duplicidade historica e participante extra bloqueiam recuperacao sem criar ou apagar',async()=>{
  for(const extra of [false,true]) {
    const f=fixture();f.add([A,B]);if(extra)f.add([A,B,C]);else f.add([B,A]);
    assert.equal((await f.start()).code,409);assert.equal(f.creates,0);assert.equal(f.records.length,2);
  }
  const f=fixture();f.add([A,B,C]);assert.equal((await f.start()).code,409);assert.equal(f.creates,0);
});

test('sem indice real criacao falha fechada, sem upsert ou indices automaticos',async()=>{
  const f=fixture({noIndex:true});const r=await f.start();assert.equal(r.code,503);assert.equal(r.body.codigo,'CHAT_PAIR_INDEX_REQUIRED');assert.equal(f.creates,0);
  assert.equal(Chat.schema.options.autoIndex,false);assert.equal(Chat.schema.options.autoCreate,false);
  assert.equal(hasPairIndex([index]),true);
  for(const unsafe of [{...index,unique:false},{...index,key:{participants:1}},{...index,partialFilterExpression:undefined},{...index,partialFilterExpression:{pairKey:{$type:'string'},isActive:true}}])assert.equal(hasPairIndex([unsafe]),false);
});

test('aberturas concorrentes e ordem inversa usam upsert com a mesma chave unica',async()=>{
  const f=fixture();const results=await Promise.all(Array.from({length:20},(_,i)=>i%2?f.start(B,A):f.start(A,B)));
  assert.ok(results.every(r=>r.code===201));assert.equal(new Set(results.map(r=>r.body.chat._id)).size,1);assert.equal(f.creates,1);
});

test('conflito 11000 no indice do par recupera a conversa vencedora',async()=>{
  const f=fixture({duplicateKey:true});const r=await f.start();assert.equal(r.code,201);assert.equal(f.creates,1);
});

test('schema real valida cardinalidade, mensagens, chave e preserva legado hidratado',async()=>{
  for(const participants of [[],[A],[A,A],[A,B,C]]) assert.ok(new Chat({participants}).validateSync()?.errors.participants);
  for(const message of [{sender:A,receiver:C,content:'Teste'},{sender:A,receiver:A,content:'Teste'}])assert.ok(new Chat({participants:[A,B],messages:[message]}).validateSync()?.errors.messages);
  const valid=new Chat({participants:[B,A],messages:[{sender:A,receiver:B,content:'Teste'}]});await valid.validate();assert.equal(valid.pairKey,pairKey([A,B]));
  const legacy=Chat.hydrate({_id:new mongoose.Types.ObjectId(),participants:[A,B],messages:[]});await legacy.validate();assert.equal(legacy.pairKey,undefined);
  assert.ok(new Chat({participants:[A,B],pairKey:pairKey([A,C])}).validateSync()?.errors.pairKey);
  assert.equal(require('../Models/chat'),Chat);assert.equal(mongoose.connection.readyState,0);
});

test('populate real preserva referencias ausentes e nao transforma tres participantes em dois',async()=>{
  const db=new mongoose.Mongoose();db.set('bufferCommands',false);
  const Model=db.model('Chat',Chat.schema.clone());
  const User=db.model('Usuario',require('../Models/usuarioModel').schema.clone());
  const oid=id=>new mongoose.Types.ObjectId(id),missing='f'.repeat(24);
  const records=[{_id:oid('8'.repeat(24)),participants:[oid(A),oid(B)],messages:[],isActive:true},
    {_id:oid('9'.repeat(24)),participants:[oid(A),oid(B),oid(missing)],messages:[{sender:oid(A),receiver:oid(B),content:'Nao divulgar',read:false}],isActive:true}];
  Model.collection.find=()=>({async toArray(){return records;}});
  User.collection.find=filter=>({async toArray(){return [A,B].filter(id=>filter._id.$in.some(value=>value.equals(oid(id)))).map(id=>({_id:oid(id),nome:'Ficticio'}));}});
  const {api}=require('./helpers/chatFixtures').controller(Model,User);
  const list=await invoke(api.getUserChats);assert.equal(list.code,200);assert.equal(list.body.length,1);assert.equal(list.body[0].id,'8'.repeat(24));
  const unread=await invoke(api.getUnreadCount);assert.equal(unread.body.total_nao_lidas,0);assert.equal(db.connection.readyState,0);
});

test('upsert passa pelos casts e validadores reais do Mongoose sem acesso ao banco',async()=>{
  const db=new mongoose.Mongoose();db.set('bufferCommands',false);const Model=db.model('Chat',Chat.schema.clone());
  let calls=0;
  Model.collection.findOneAndUpdate=async(filter,update,options)=>{
    calls++;assert.equal(filter.pairKey,pairKey([A,B]));assert.equal(options.upsert,true);
    assert.equal(update.$setOnInsert.participants.length,2);assert.equal(update.$setOnInsert.pairKey,filter.pairKey);
    return {value:{_id:new mongoose.Types.ObjectId(),...update.$setOnInsert}};
  };
  const document=await Model.findOneAndUpdate({pairKey:pairKey([A,B])},{$setOnInsert:{pairKey:pairKey([A,B]),participants:[A,B],messages:[],isActive:true}},{upsert:true,new:true,runValidators:true,setDefaultsOnInsert:true});
  assert.equal(document.pairKey,pairKey([A,B]));assert.equal(calls,1);assert.equal(db.connection.readyState,0);
});

test('envio ignora remetente/destinatario forjados e rejeita conteudo nao textual',async()=>{
  const f=fixture();const chat=f.add([A,B]);
  const r=await invoke(f.api.sendMessage,{body:{chat_id:chat._id,content:'  Texto  ',sender:C,receiver:C}});
  assert.equal(r.code,201);assert.equal(r.body.message.sender,A);assert.equal(r.body.message.receiver,B);assert.equal(r.body.message.content,'Texto');
  for(const content of [undefined,null,'','   ',12,{},[]])assert.equal((await invoke(f.api.sendMessage,{body:{chat_id:chat._id,content}})).code,400);
  assert.equal(chat.messages.length,1);
});

test('conflito de versao retorna 409 sem log ou detalhe privado',async()=>{
  const f=fixture();const chat=f.add([A,B]);chat.save=async()=>{throw Object.assign(Error('Detalhe privado sintetico'),{name:'VersionError'})};
  const r=await invoke(f.api.sendMessage,{body:{chat_id:chat._id,content:'Teste'}});assert.equal(r.code,409);assert.doesNotMatch(JSON.stringify(r.body),/Detalhe privado/);assert.deepEqual(f.logs,[]);
});

test('token de conta removida nao consulta, envia nem marca conversa existente',async()=>{
  const f=fixture();const chat=f.add([A,B]);f.users.delete(A);
  for(const handler of ['getChatMessages','sendMessage','markAsRead'])assert.equal((await invoke(f.api[handler],{body:{chat_id:chat._id,content:'Teste'},params:{chatId:chat._id}})).code,401);
  assert.equal(f.saves,0);
});

test('mensagem nula em legado invalida a conversa sem vazar nem lançar erro de tipo',async()=>{
  const f=fixture();const chat=f.add([A,B],{messages:[null]});
  assert.equal((await invoke(f.api.getChatMessages,{params:{chatId:chat._id}})).code,409);assert.deepEqual(f.logs,[]);
});
