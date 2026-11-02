'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAuditResult, TOTAL_FIELDS, AuditError } = require('../scripts/lib/chatAudit');
const { main } = require('../scripts/auditChats');
function fixture() {
  return [{ totals: [Object.fromEntries(TOTAL_FIELDS.map(field => [field, 0]))], pairs: [{ grupos: 0, excedentes: 0 }], keys: [{ grupos: 0, excedentes: 0 }] }];
}
function invalid(rows) { assert.throws(() => validateAuditResult(rows), error => error instanceof AuditError && error.code === 'AUDIT_INVALID_RESULT' && error.message === 'AUDIT_INVALID_RESULT'); }

test('relatorio vazio explicito e relatorio integro nao vazio sao aceitos', () => {
  assert.equal(validateAuditResult(fixture()).totals.c_total, 0);
  const rows=fixture();Object.assign(rows[0].totals[0],{c_total:2,c_com_achados:2,c_pair_key_ausente:2,c_par_duplicado:2,m_total:5});
  rows[0].pairs[0]={grupos:1,excedentes:1};assert.equal(validateAuditResult(rows).pairs.grupos,1);
});

for(const field of TOTAL_FIELDS)test('contador obrigatorio ausente e rejeitado: '+field,()=>{
  const rows=fixture();delete rows[0].totals[0][field];invalid(rows);
});

for(const section of ['pairs','keys'])for(const field of ['grupos','excedentes'])test(section+'.'+field+' e obrigatorio',()=>{
  const rows=fixture();delete rows[0][section][0][field];invalid(rows);
});

test('tipos invalidos, negativos, fracionarios e inteiros inseguros sao rejeitados em todos os contadores',()=>{
  for(const section of ['totals','pairs','keys'])for(const field of Object.keys(fixture()[0][section][0])){
    for(const value of [undefined,null,'0',false,NaN,Infinity,-1,-0,0.5,Number.MAX_SAFE_INTEGER+1,0n,{},[]]){
      const rows=fixture();rows[0][section][0][field]=value;invalid(rows);
    }
  }
});

test('estrutura ausente, vazia, duplicada, inesperada ou com campos herdados nao vira zeros',()=>{
  for(const rows of [undefined,null,{},[],[null],[{}],[fixture()[0],fixture()[0]]])invalid(rows);
  for(const section of ['totals','pairs','keys']){
    for(const value of [undefined,null,{},[],[null],[{}],[fixture()[0][section][0],fixture()[0][section][0]]]){
      const rows=fixture();rows[0][section]=value;invalid(rows);
    }
    const missing=fixture();delete missing[0][section];invalid(missing);
    const inherited=fixture();inherited[0][section][0]=Object.create(inherited[0][section][0]);invalid(inherited);
    const extra=fixture();extra[0][section][0].PRIVADO='nao divulgar';invalid(extra);
  }
  const rows=fixture();rows[0].documentos='nao divulgar';invalid(rows);
});

const contradictions = [
  {c_total:1,c_com_achados:2}, {c_total:1,c_inativas:2},
  {c_total:1,c_pair_key_ausente:1}, {c_total:1,c_com_achados:1},
  {c_total:1,c_com_achados:1,c_pair_key_ausente:2},
  {c_total:1,c_com_achados:1,c_pair_key_ausente:1,c_pair_key_invalida:1},
  {c_total:1,c_com_achados:1,c_pair_key_divergente:1,c_pair_key_nao_verificavel:1},
  {c_total:1,c_com_achados:1,c_participantes_formato_invalido:1},
  {c_total:1,c_com_achados:1,c_participantes_id_invalido:1},
  {c_total:1,c_com_achados:1,c_participantes_usuario_ausente:1},
  {c_total:1,r_participantes_ausentes:1},
  {c_total:0,m_total:1},
  {c_total:1,m_total:0,m_inconsistentes:1},
  {c_total:1,m_total:1,m_conteudo_invalido:1},
  {c_total:1,m_total:1,m_inconsistentes:1,c_com_achados:1,c_historico_inconsistente:1},
  {c_total:1,c_com_achados:1,c_historico_inconsistente:1},
  {c_total:1,c_com_achados:1,c_historico_formato_invalido:1},
  {c_total:1,c_com_achados:1,c_historico_formato_invalido:1,c_historico_inconsistente:1,m_total:1},
  {c_total:1,c_com_achados:1,c_historico_inconsistente:1,m_total:1,m_inconsistentes:1,m_par_nao_verificavel:1},
  {c_total:1,c_com_achados:1,c_pair_key_nao_verificavel:1}
];
for(const [i,values] of contradictions.entries())test('totais contraditorios sao rejeitados: caso '+(i+1),()=>{
  const rows=fixture();Object.assign(rows[0].totals[0],values);invalid(rows);
});

test('grupos e excedentes precisam corresponder exatamente aos documentos duplicados',()=>{
  for(const [section,field] of [['pairs','c_par_duplicado'],['keys','c_chave_armazenada_repetida']]){
    for(const summary of [{grupos:0,excedentes:1},{grupos:1,excedentes:0},{grupos:2,excedentes:1},{grupos:1,excedentes:2},{grupos:0,excedentes:0}]){
      const rows=fixture();Object.assign(rows[0].totals[0],{c_total:2,c_com_achados:2,[field]:2});rows[0][section][0]=summary;invalid(rows);
    }
    const valid=fixture();Object.assign(valid[0].totals[0],{c_total:4,c_com_achados:4,[field]:4});valid[0][section][0]={grupos:1,excedentes:3};validateAuditResult(valid);
  }
});

test('categorias sobrepostas validas nao sao somadas como documentos distintos',()=>{
  const rows=fixture();Object.assign(rows[0].totals[0],{
    c_total:1,c_com_achados:1,c_participantes_quantidade_invalida:1,c_pair_key_invalida:1,c_pair_key_nao_verificavel:1,
    c_historico_inconsistente:1,m_total:1,m_inconsistentes:1,m_conteudo_invalido:1,m_par_nao_verificavel:1
  });validateAuditResult(rows);
});

test('somas grandes usam aritmetica inteira sem overflow silencioso',()=>{
  const rows=fixture(),n=Number.MAX_SAFE_INTEGER;
  Object.assign(rows[0].totals[0],{c_total:n,c_com_achados:n,c_pair_key_invalida:n,c_pair_key_divergente:n});validateAuditResult(rows);
  rows[0].totals[0].c_pair_key_ausente=1;invalid(rows);
});

test('CLI falha sem relatorio parcial nem dados internos para resposta inconsistente',async()=>{
  let out='',err='',closed=0;
  const rows=fixture();delete rows[0].totals[0].c_total;
  rows[0].totals[0].DADO_INTERNO='PRIVADO-SINTETICO';
  const code=await main(['--local-disposable','--uri','mongodb://127.0.0.1:27017','--database','iservice_chat_audit_teste'],{
    stdout:{write:x=>{out+=x}},stderr:{write:x=>{err+=x}},createClient(){return {
      async connect(){},async close(){closed++},db(){return {
        listCollections(){return {async toArray(){return [{name:'chats'},{name:'usuarios'}]}}},
        collection(){return {aggregate(){return {async toArray(){return rows}}}}}
      }}
    }}
  });
  assert.equal(code,2);assert.equal(out,'');assert.equal(closed,1);
  assert.deepEqual(JSON.parse(err),{erro:'AUDIT_INVALID_RESULT',relatorio_completo:false});
  assert.doesNotMatch(err,/PRIVADO|DADO_INTERNO|totals|c_total/);
});

test('duplicidades nao podem incluir quantidade/IDs repetidos invalidos nem chaves ausentes',()=>{
  for(const flag of ['participantes_quantidade_invalida','participantes_id_invalido','participantes_repetidos']){
    const rows=fixture();Object.assign(rows[0].totals[0],{c_total:2,c_com_achados:2,c_par_duplicado:2,['c_'+flag]:1});
    if(flag==='participantes_id_invalido')rows[0].totals[0].c_participantes_tipo_bson_incorreto=1;
    rows[0].pairs[0]={grupos:1,excedentes:1};invalid(rows);
  }
  const rows=fixture();Object.assign(rows[0].totals[0],{c_total:2,c_com_achados:2,c_chave_armazenada_repetida:2,c_pair_key_ausente:1});
  rows[0].keys[0]={grupos:1,excedentes:1};invalid(rows);
});

test('API aceita orcamento de 1 ms; CLI mantem seu minimo de 1000 ms',async()=>{
  const {auditChats}=require('../scripts/lib/chatAudit');const {parseOptions}=require('../scripts/auditChats');let observed;
  const db={
    listCollections(){return {async toArray(){return [{name:'chats'},{name:'usuarios'}]}}},
    collection(){return {aggregate(pipeline,options){observed=options.maxTimeMS;return {async toArray(){return fixture()}}}}}
  };
  assert.equal((await auditChats(db,{maxTimeMS:1})).conversas.total,0);assert.equal(observed,1);
  assert.throws(()=>parseOptions(['--local-disposable','--uri','mongodb://127.0.0.1:27017','--database','iservice_chat_audit_teste','--max-time-ms','1']),{code:'AUDIT_LOCAL_TARGET_REQUIRED'});
});
