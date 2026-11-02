const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const jwt=require('jsonwebtoken');
const express=require('express');
const {A}=require('./helpers/chatFixtures');
const secret='chave-sintetica-somente-do-teste';
function load(file,dependencies){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{module,exports:module.exports,require:name=>dependencies[name],process:{env:{JWT_SECRET:secret}}});return module.exports;}
const auth=load('middleware/authMiddleware.js',{jsonwebtoken:jwt});
const names=['startChat','sendMessage','getChatMessages','getUserChats','markAsRead','getUnreadCount'];
const handlers=Object.fromEntries(names.map(name=>[name,(req,res)=>res.json({handler:name,usuarioId:req.usuarioId})]));
const router=load('routes/chatRoutes.js',{express,'../controllers/chatController':handlers,'../middleware/authMiddleware':auth});
function request(method,url,token){return new Promise((resolve,reject)=>{
  const req={method,url,headers:token?{authorization:'Bearer '+token}:{}};
  const res={code:200,headers:{},set(name,value){this.headers[name]=value;return this},status(code){this.code=code;return this},json(body){this.body=body;resolve(this);return this}};
  router.handle(req,res,error=>reject(error||Error('Rota nao encontrada')));
});}
for(const [method,url,name] of [['POST','/start','startChat'],['POST','/message','sendMessage'],['GET','/'+A,'getChatMessages'],['GET','/','getUserChats'],['PUT','/'+A+'/read','markAsRead'],['GET','/unread/count','getUnreadCount']]){
  test(method+' '+url+' exige JWT e encaminha usuario autenticado sem cache',async()=>{
    assert.equal((await request(method,url)).code,401);
    assert.equal((await request(method,url,'invalido')).code,401);
    const expired=jwt.sign({id:A,tipo:'cliente'},secret,{expiresIn:-1});assert.equal((await request(method,url,expired)).code,401);
    const signed=jwt.sign({id:A,tipo:'cliente'},secret,{expiresIn:60});const r=await request(method,url,signed);
    assert.equal(r.code,200);assert.equal(r.body.handler,name);assert.equal(r.body.usuarioId,A);assert.equal(r.headers['Cache-Control'],'no-store');
  });
}
