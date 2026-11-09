const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { A, B, C } = require('./helpers/chatFixtures');
const CHAT='3'.repeat(24), OTHER='4'.repeat(24);
const flush=()=>new Promise(setImmediate);
const response=(body,status=200)=>({ok:status>=200&&status<300,status,async json(){return body;}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const token=id=>[Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url'),Buffer.from(JSON.stringify({id,tipo:'cliente',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'assinatura'].join('.');
function harness(fetcher) {
  const storage=new Map(), events={}, requests=[], intervals=new Map(), notices=[], redirects=[];
  const nodes={};let timer=0;
  for(const key of ['chatMessages','mensagemInput','btnEnviar','chatNome','chatAvatar','formMensagem'])nodes[key]={
    value:'',innerHTML:'',textContent:'',disabled:false,listeners:{},focus(){},
    addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},
    removeEventListener(name,fn){this.listeners[name]=(this.listeners[name]||[]).filter(f=>f!==fn);},
    emit(name){for(const fn of this.listeners[name]||[])fn({preventDefault(){}});}
  };
  function store(id){storage.set('token',token(id));storage.set('usuario',JSON.stringify({id,tipo:'cliente',nome:'Ficticio'}));}
  store(A);
  const location={href:'https://iservice.test/chat.html',origin:'https://iservice.test',pathname:'/chat.html',search:'',replace(url){redirects.push(url)},reload(){redirects.push('reload')}};
  const document={documentElement:{classList:{add(){},remove(){}}},querySelectorAll(){return[]},getElementById:key=>nodes[key],addEventListener(){}};
  const context=vm.createContext({document,location,URL,URLSearchParams,Headers,Request,Response,AbortController,console,
    atob:value=>Buffer.from(value,'base64').toString('binary'),
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(){return ++timer},clearTimeout(){},setInterval(fn){intervals.set(++timer,fn);return timer},clearInterval(id){intervals.delete(id)},
    addEventListener(name,fn){(events[name]||=[]).push(fn)},
    async fetch(url,options={}){requests.push({url,options});return fetcher(url,options)}
  });context.window=context;
  for(const file of ['app.js','chat.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),context);
  context.IS.toast=(text)=>notices.push(text);
  return {context,nodes,storage,requests,intervals,notices,redirects,store,
    event(name,event={}){for(const fn of events[name]||[])fn(event)},
    mount(search='?chatId='+CHAT+'&destinatarioId='+B+'&usuarioId='+A){location.search=search;context.IS.chat.montar()},
    poll(){return [...intervals.values()][0]?.()},
    open(id){return context.IS.chat.abrir(id)}
  };
}
function data(other=B,chatId=CHAT,content='Texto sintetico',sender=A){return {chat:{id:chatId,participants:[{_id:A,nome:'Conta A'},{_id:other,nome:'Profissional '+other[0]}]},messages:[{sender,receiver:sender===A?other:A,content,createdAt:'2026-01-01T12:00:00Z',read:true}]};}
function started(other=B,chatId=CHAT){return {chat:{_id:chatId,participants:[A,other]}};}

test('ultima selecao prevalece: resposta antiga nao navega e mesma selecao nao duplica requisicao',async()=>{
  const first=deferred(),second=deferred();let n=0;
  const p=harness(()=>++n===1?first.promise:second.promise);
  const a=p.open(B),again=p.open(B);assert.equal(p.requests.length,1);
  const b=p.open(C);assert.equal(p.requests[0].options.signal.aborted,true);
  second.resolve(response(started(C,OTHER)));await b;
  assert.match(p.context.location.href,new RegExp('chatId='+OTHER+'&destinatarioId='+C));
  const selected=p.context.location.href;first.resolve(response(started(B)));await Promise.all([a,again]);assert.equal(p.context.location.href,selected);
});

test('abertura rejeita proprio ID e respostas de par diferente antes da navegacao',async()=>{
  const p=harness(()=>response(started(C)));
  await p.open(A);assert.equal(p.requests.length,0);
  await p.open(B);assert.equal(p.context.location.href,'https://iservice.test/chat.html');assert.equal(p.notices.length,2);
});

test('mudanca de sessao cancela abertura pendente e impede redirecionamento tardio',async()=>{
  const pending=deferred();const p=harness(()=>pending.promise);const work=p.open(B);
  p.store(C);p.event('storage',{key:'usuario'});
  pending.resolve(response(started(B)));await work;assert.equal(p.context.location.href,'https://iservice.test/chat.html');
  assert.equal(p.requests[0].options.signal.aborted,true);
});

test('nome e mensagens sao exibidos apenas depois de validar par, chatId e destinatario',async()=>{
  const p=harness(()=>response(data()));p.mount();assert.equal(p.nodes.btnEnviar.disabled,true);await flush();
  assert.equal(p.nodes.chatNome.textContent,'Profissional a');assert.match(p.nodes.chatMessages.innerHTML,/Texto sintetico/);assert.equal(p.nodes.btnEnviar.disabled,false);
  for(const wrong of [data(C),data(B,OTHER),{...data(),messages:[{sender:A,receiver:C,content:'Nao exibir'}]}, {...data(),chat:{id:CHAT,participants:[{_id:A},{_id:B},{_id:C}]}}]){
    const bad=harness(()=>response(wrong));bad.mount();await flush();assert.equal(bad.nodes.btnEnviar.disabled,true);assert.doesNotMatch(bad.nodes.chatMessages.innerHTML,/Nao exibir|Texto sintetico/);
  }
});

test('falha HTTP e falha de rede permitem restaurar mensagens identicas na proxima consulta',async()=>{
  for(const network of [false,true]) {
    let n=0;const p=harness(()=>{n++;if(n===2){if(network)throw Error('Rede sintetica');return response({mensagem:'Falha sintetica'},503)}return response(data())});
    p.mount();await flush();const original=p.nodes.chatMessages.innerHTML;
    await p.poll();assert.match(p.nodes.chatMessages.innerHTML,/Erro ao carregar/);assert.equal(p.nodes.btnEnviar.disabled,true);
    await p.poll();assert.equal(p.nodes.chatMessages.innerHTML,original);assert.equal(p.nodes.btnEnviar.disabled,false);
  }
});

test('polling antigo nao sobrescreve uma resposta mais recente',async()=>{
  const first=deferred(),second=deferred();let n=0;
  const p=harness(()=>++n===1?first.promise:second.promise);p.mount();const polling=p.poll();
  second.resolve(response(data(B,CHAT,'Resposta atual')));await polling;
  first.resolve(response(data(B,CHAT,'Resposta antiga')));await flush();
  assert.match(p.nodes.chatMessages.innerHTML,/Resposta atual/);assert.doesNotMatch(p.nodes.chatMessages.innerHTML,/Resposta antiga/);
});

for(const mode of ['logout','troca de conta','storage sem evento'])test(mode+' limpa conteudo e descarta mensagens tardias',async()=>{
  const pending=deferred();let n=0;const p=harness(()=>++n===1?response(data()):pending.promise);
  p.mount();await flush();p.nodes.mensagemInput.value='Rascunho privado';const poll=p.poll();
  if(mode==='logout')p.context.IS.sair();else {p.store(C);if(mode==='troca de conta')p.event('storage',{key:'token'});}
  if(mode!=='storage sem evento'){assert.equal(p.nodes.chatMessages.innerHTML,'');assert.equal(p.nodes.mensagemInput.value,'');assert.equal(p.intervals.size,0)}
  pending.resolve(response(data(B,CHAT,'Tardia privada')));await poll;
  assert.equal(p.nodes.chatMessages.innerHTML,'');assert.equal(p.nodes.chatNome.textContent,'Conversa');assert.equal(p.nodes.btnEnviar.disabled,true);
});

test('URL criada para outra conta nao consulta nem exibe conversa apos troca',async()=>{
  const p=harness(()=>response(data()));p.store(B);p.event('storage',{key:'usuario'});p.mount();await flush();assert.equal(p.requests.length,0);assert.equal(p.nodes.btnEnviar.disabled,true);
});

test('URL antiga sem destinatario continua funcionando somente com par valido',async()=>{
  const p=harness(()=>response(data()));p.mount('?chatId='+CHAT);await flush();assert.equal(p.nodes.btnEnviar.disabled,false);
});

test('GET validado aciona PUT de leitura; conteudo e escapado',async()=>{
  const d=data(B,CHAT,'<script>privado</script>',B);d.messages[0].read=false;
  const p=harness((url,options)=>options.method==='PUT'?response({marcadas:1}):response(d));p.mount();await flush();
  assert.match(p.nodes.chatMessages.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(p.nodes.chatMessages.innerHTML,/<script>/);
  assert.equal(p.requests[1].options.method,'PUT');assert.equal(p.requests[1].url,'/api/chat/'+CHAT+'/read');
});

test('envio usa identidade da sessao, preserva rascunho na falha e limpa na confirmacao',async()=>{
  let fail=true;const p=harness((url,options)=>options.method==='POST'?response(fail?{mensagem:'Falha sintetica'}:{message:{sender:A,receiver:B,content:'Teste'}},fail?503:201):response(data()));
  p.mount();await flush();p.nodes.mensagemInput.value='Teste';p.nodes.formMensagem.emit('submit');await flush();assert.equal(p.nodes.mensagemInput.value,'Teste');
  fail=false;p.nodes.formMensagem.emit('submit');await flush();assert.equal(p.nodes.mensagemInput.value,'');
  const sent=p.requests.find(r=>r.options.method==='POST');assert.deepEqual(JSON.parse(sent.options.body),{chat_id:CHAT,content:'Teste'});
  assert.equal(sent.options.headers.Authorization,'Bearer '+p.storage.get('token'));
});

test('resposta 401 limpa conteudo imediatamente pelo encerramento real da sessao',async()=>{
  let fail=false;const p=harness(()=>response(fail?{mensagem:'Token invalido'}:data(),fail?401:200));p.mount();await flush();fail=true;await p.poll();assert.equal(p.nodes.chatMessages.innerHTML,'');assert.equal(p.context.IS.logado,false);
});

test('atualizacao de nome da mesma sessao em outra aba preserva conversa',async()=>{
  const p=harness(()=>response(data()));p.mount();await flush();
  p.storage.set('usuario',JSON.stringify({id:A,tipo:'cliente',nome:'Outro nome ficticio'}));p.event('storage',{key:'usuario'});
  assert.match(p.nodes.chatMessages.innerHTML,/Texto sintetico/);assert.equal(p.nodes.btnEnviar.disabled,false);
});
