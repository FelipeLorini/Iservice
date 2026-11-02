'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { MongoClient, ObjectId, BSON } = require('mongoose').mongo;
const { auditChats } = require('../scripts/lib/chatAudit');
const { disposableMongo } = require('./helpers/disposableMongo');
const A='1'.repeat(24), B='a'.repeat(24), C='2'.repeat(24), MISSING='f'.repeat(24);
const oid=id=>new ObjectId(id);
const key=(a,b)=>[a,b].sort().join(':');
const PRIVATE='PRIVADO-SINTETICO-NAO-EXPORTAR';
const message=(extra={})=>({sender:oid(A),receiver:oid(B),content:PRIVATE,read:false,...extra});
const chat=(extra={})=>({participants:[oid(A),oid(B)],pairKey:key(A,B),messages:[message()],isActive:true,...extra});
let sequence=0;
function validateOutput(report) {
  const text=JSON.stringify(report);
  for(const value of [PRIVATE,A,B,C,MISSING,'example.invalid','senha','nome','email','content','sender','receiver'])assert.ok(!text.includes(value));
  function leaves(value){if(value&&typeof value==='object'){for(const item of Object.values(value))leaves(item)}else assert.ok((Number.isSafeInteger(value)&&value>=0)||value===true||value==='sem_snapshot');}
  leaves(report);
}
async function prepare(client,documents=[],users=[A,B,C]) {
  const name='iservice_chat_audit_fixture_'+(++sequence);
  const db=client.db(name);await db.createCollection('chats');await db.createCollection('usuarios');
  if(users.length)await db.collection('usuarios').insertMany(users.map(_id=>({_id:oid(_id),nome:PRIVATE,email:PRIVATE+'@example.invalid',senha:PRIVATE})));
  if(documents.length)await db.collection('chats').insertMany(documents);
  return db;
}
async function snapshot(db) {
  const result={};
  for(const name of ['chats','usuarios'])result[name]={documents:await db.collection(name).find({}).sort({_id:1}).toArray(),indexes:await db.collection(name).listIndexes().toArray()};
  return BSON.EJSON.stringify(result,{relaxed:false});
}
const allowedCommands=new Set(['aggregate','listCollections','getMore','killCursors','endSessions','ping','hello']);
async function checkedAudit(uri,db,options={}) {
  const before=await snapshot(db);const commands=[];
  const reader=new MongoClient(uri,{monitorCommands:true,...options});
  try{
    await reader.connect();reader.on('commandStarted',e=>commands.push(e));
    const report=await auditChats(reader.db(db.databaseName));validateOutput(report);
    assert.ok(commands.some(e=>e.commandName==='aggregate'));
    for(const e of commands)assert.ok(allowedCommands.has(e.commandName),'Comando inesperado: '+e.commandName);
    const aggregate=commands.find(e=>e.commandName==='aggregate').command;
    assert.equal(aggregate.allowDiskUse,false);assert.equal(aggregate.maxTimeMS,30000);
    assert.equal(await snapshot(db),before,'Auditoria nao pode alterar documentos, colecoes ou indices');
    return report;
  }finally{await reader.close()}
}

test('auditoria em MongoDB descartavel: integridade, contagens e ausencia de escrita', {timeout:60000}, async t=>{
  const mongo=await disposableMongo();t.after(mongo.cleanup);
  await t.test('colecoes vazias validas produzem zeros sem criar indices',async()=>{
    const report=await checkedAudit(mongo.uri,await prepare(mongo.client));
    assert.equal(report.conversas.total,0);assert.equal(report.conversas.com_achados,0);assert.equal(report.mensagens.total,0);
  });
  await t.test('pares integros e inativos sao auditados sem falso positivo',async()=>{
    const db=await prepare(mongo.client,[chat(),chat({participants:[oid(C),oid(B)],pairKey:key(C,B),messages:[message({sender:oid(C)})],isActive:false})]);
    const r=await checkedAudit(mongo.uri,db);assert.equal(r.conversas.total,2);assert.equal(r.conversas.inativas,1);assert.equal(r.conversas.com_achados,0);
  });
  await t.test('participantes ausentes, nulos, extras, duplicados e IDs invalidos',async()=>{
    const documents=[chat({participants:[]}),chat({participants:[oid(A)]}),chat({participants:[oid(A),oid(B),oid(C)]}),
      chat({participants:[oid(A),oid(A)]}),chat({participants:[oid(A),null]}),chat({participants:{_id:oid(A)}}),chat({participants:[oid(A),'abcdefghijkl']}),chat({participants:[oid(A),B+'\n']})];
    const absent=chat();delete absent.participants;documents.push(absent);
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,documents));
    assert.equal(r.conversas.total,9);assert.equal(r.conversas.com_achados,9);
    assert.equal(r.conversas.participantes_formato_invalido,2);assert.equal(r.conversas.participantes_quantidade_invalida,5);
    assert.equal(r.conversas.participantes_repetidos,1);assert.equal(r.conversas.participantes_id_invalido,3);
  });
  await t.test('strings hexadecimais nao sao confundidas com ObjectIds BSON',async()=>{
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[chat(),chat({participants:[A,B.toUpperCase()],messages:[message({sender:A,receiver:B})]})]));
    assert.equal(r.conversas.participantes_tipo_bson_incorreto,1);assert.equal(r.mensagens.tipo_bson_incorreto,1);
    assert.equal(r.conversas.participantes_id_invalido,0);assert.equal(r.conversas.participantes_usuario_ausente,0);
    assert.equal(r.pares.grupos_duplicados,1);assert.equal(r.conversas.par_duplicado,2);
  });
  await t.test('pairKey ausente, nula, nao string, malformada, invertida e divergente',async()=>{
    const absent=chat();delete absent.pairKey;
    const keys=[null,123,[key(A,B)],'',key(A,B)+'\n',key(A,B).toUpperCase(),B+':'+A,key(A,C)];
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[absent,...keys.map(pairKey=>chat({pairKey}))]));
    assert.equal(r.conversas.pair_key_ausente,1);assert.equal(r.conversas.pair_key_invalida,7);assert.equal(r.conversas.pair_key_divergente,5);
  });
  await t.test('pares duplicados incluem ordem inversa, legados e inativos sem chave',async()=>{
    const legacy=chat({participants:[oid(B),oid(A)],isActive:false});delete legacy.pairKey;
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[chat(),legacy,chat({pairKey:undefined}),chat({participants:[oid(A),oid(C)],pairKey:key(A,C),messages:[]})]));
    assert.equal(r.pares.grupos_duplicados,1);assert.equal(r.pares.conversas_excedentes,2);assert.equal(r.conversas.par_duplicado,3);
  });
  await t.test('colisoes de chaves armazenadas sao contadas mesmo com participantes diferentes',async()=>{
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[chat(),chat({participants:[oid(A),oid(C)],messages:[]})]));
    assert.equal(r.pares.grupos_duplicados,0);assert.equal(r.pares.grupos_chaves_repetidas,1);assert.equal(r.conversas.chave_armazenada_repetida,2);assert.equal(r.conversas.pair_key_divergente,1);
  });
  await t.test('usuarios removidos em participantes e mensagens sao contados sem consultar dados pessoais',async()=>{
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[chat({participants:[oid(A),oid(MISSING)],pairKey:key(A,MISSING),messages:[message({receiver:oid(MISSING)})]})]));
    assert.equal(r.conversas.participantes_usuario_ausente,1);assert.equal(r.referencias.participantes_ausentes,1);assert.equal(r.mensagens.usuario_ausente,1);
  });
  await t.test('mensagens invalidas, externas, autoreferentes e conteudo vazio nao sao expostas',async()=>{
    const messages=[message(),null,42,[],message({sender:null}),message({sender:oid(A),receiver:oid(A)}),message({receiver:oid(C)}),
      message({content:'\ufeff\u00a0 \t\n'}),message({content:PRIVATE+'\n'}),message({content:123}),message({receiver:oid(MISSING)})];
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[chat({messages})]));
    assert.equal(r.mensagens.total,11);assert.equal(r.mensagens.inconsistentes,9);
    assert.equal(r.mensagens.estrutura_invalida,3);assert.equal(r.mensagens.id_invalido,4);assert.equal(r.mensagens.remetente_igual_destinatario,1);
    assert.equal(r.mensagens.fora_dos_participantes,2);assert.equal(r.mensagens.usuario_ausente,1);assert.equal(r.mensagens.conteudo_invalido,5);
  });
  await t.test('historico nao array e par nao verificavel aparecem no resumo',async()=>{
    const absent=chat();delete absent.messages;
    const r=await checkedAudit(mongo.uri,await prepare(mongo.client,[absent,chat({messages:{content:PRIVATE}}),chat({messages:null}),chat({participants:[oid(A)],messages:[message()]})]));
    assert.equal(r.conversas.historico_formato_invalido,3);assert.equal(r.conversas.historico_inconsistente,4);assert.equal(r.mensagens.par_nao_verificavel,1);assert.equal(r.conversas.pair_key_nao_verificavel,1);
  });
  await t.test('CLI real imprime apenas JSON e usa codigos distintos para achados e ausencia de colecoes',async()=>{
    for(const findings of [false,true]){
      const db=await prepare(mongo.client,[chat(findings?{participants:[oid(A)]}:{})]);
      const before=await snapshot(db);
      const result=spawnSync(process.execPath,['scripts/auditChats.js','--local-disposable','--uri',mongo.uri,'--database',db.databaseName],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(result.status,findings?1:0,result.stderr);assert.equal(result.stderr,'');validateOutput(JSON.parse(result.stdout));assert.equal(await snapshot(db),before);
    }
    const result=spawnSync(process.execPath,['scripts/auditChats.js','--local-disposable','--uri',mongo.uri,'--database','iservice_chat_audit_inexistente'],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,2);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).erro,'AUDIT_COLLECTIONS_REQUIRED');
  });
});

test('auditoria funciona com usuario MongoDB restrito a leitura e sem privilegio de criar indice', {timeout:45000}, async t=>{
  const mongo=await disposableMongo({auth:true});t.after(mongo.cleanup);
  const db=await prepare(mongo.client,[chat()]);
  await db.command({createUser:'fixture_reader',pwd:'senha-sintetica-reader',roles:[{role:'read',db:db.databaseName}]});
  const auth={auth:{username:'fixture_reader',password:'senha-sintetica-reader'},authSource:db.databaseName};
  const reader=new MongoClient(mongo.uri,auth);await reader.connect();
  try{
    await assert.rejects(reader.db(db.databaseName).collection('chats').insertOne(chat()),{code:13});
    await assert.rejects(reader.db(db.databaseName).collection('chats').createIndex({pairKey:1}),{code:13});
  }finally{await reader.close()}
  const report=await checkedAudit(mongo.uri,db,auth);assert.equal(report.conversas.com_achados,0);
});
