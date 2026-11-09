# Demonstração local descartável da contratação

Esta demonstração usa o frontend atual e a composição HTTP isolada das Entregas 1 e 2. Não ativa a contratação vinculada nas rotas hospedadas e não certifica prontidão para produção.

## Pré-requisitos e início

- Node.js e dependências do projeto já instalados.
- `mongod` local: no Windows o helper procura `MongoDB\Server\8.0\bin\mongod.exe` em Program Files e, depois, no PATH. Não baixa executáveis nem utiliza o serviço MongoDB instalado.
- Dois navegadores, perfis separados ou uma janela normal e outra privada. Duas abas do mesmo perfil compartilham localStorage e não isolam as contas.
- Use exclusivamente nomes, emails e senhas fictícios. Não é necessário abrir ou configurar `.env`.

No CMD, dentro da raiz do projeto:

```bat
node scripts\demoContratacaoLocal.js
```

Abra nos dois perfis a URL `http://127.0.0.1:PORTA/` exibida no terminal. A porta é dinâmica; use a mesma URL nos dois perfis. O launcher só anuncia essa URL após verificar o processo MongoDB próprio, diretório temporário, banco exclusivo, replica set primary, conexão dos Models e índices I1–I5, email e pedido/prestador.

O terminal mostra o PID, porta, banco e diretório temporário exclusivos para conferência. Não fornece conexão alternativa nem aceita URI externa. A aplicação HTTP escuta somente em `127.0.0.1` e serve apenas HTML, CSS, JS, imagens e fontes da pasta pública; arquivos ocultos, workspace, documentação, testes e código do servidor não são servidos. Não há endpoint HTTP para trocar fases ou controlar MongoDB.

## Roteiro em dois perfis

1. Na primeira janela, abra **Criar Conta**, escolha **Cliente**, preencha dados fictícios (por exemplo, email `cliente@example.invalid`) e escolha uma senha de teste. Faça login e deixe o dashboard aberto.
2. Na segunda janela, cadastre um **Prestador** com outro email fictício, faça login e deixe seu dashboard aberto.
3. No dashboard do prestador, cadastre **um único serviço** na categoria escolhida, por exemplo faxina, com nome, descrição e preço fictícios. Confira a listagem de serviços.
4. No dashboard do cliente, publique um pedido da mesma categoria, com título, descrição e data futura. O servidor atribui a certificação; não envie marcadores pelo navegador.
5. Recarregue o dashboard do prestador. Em pedidos da sua área, preencha valor e prazo e envie a proposta. Confira **Minhas propostas**.
6. Recarregue o dashboard do cliente e confirme que a proposta aparece. **Ambas as sessões precisam estar autenticadas antes de mudar a fase.** Cadastro e login serão bloqueados depois.
7. No terminal, digite `aceitar` e pressione Enter. Aguarde **DRENANDO** e, depois, **ACEITAÇÃO**. Novas criações são bloqueadas imediatamente; operações admitidas são aguardadas e a prontidão é verificada novamente. Não prossiga se houver erro.
8. No dashboard do cliente, clique em **Aceitar** e confirme. Confira a mensagem retornada, o pedido em andamento e o agendamento com nome do serviço e do prestador.
9. Recarregue o dashboard do prestador. Confira a agenda e a notificação de proposta aceita no sino. A notificação aponta para o próprio dashboard.

Comandos do terminal: `estado`, `ajuda`, `aceitar`, `sair`. Não existe retorno à preparação sobre o mesmo banco. Se a transição falhar, a aceitação permanece fechada; use `sair` e inicie um ensaio novo. Se ainda houver operação em andamento, o encerramento aguarda sua conclusão antes de descartar os recursos. Evite encerrar o processo à força ou fechar a janela do terminal pelo gerenciador de tarefas.

## Replay autenticado

Depois da aceitação, a interface remove/desabilita a ação correspondente. Não foi criado botão especial de replay. Para conferir manualmente:

1. No DevTools da janela do cliente, aba Network, anote apenas o ID da proposta no PUT `/api/propostas/ID/aceitar`. Não copie nem compartilhe o JWT.
2. No Console **dessa mesma origem local e sessão de cliente**, substitua o ID no trecho abaixo. A chamada é deliberada e única; não há retry automático:

```js
const propostaId = 'SUBSTITUA_PELO_ID_DA_PROPOSTA';
const respostaReplay = await fetch('/api/propostas/' + encodeURIComponent(propostaId) + '/aceitar', {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + IS.token }
});
console.log(respostaReplay.status, await respostaReplay.json());
```

Espere HTTP 200, mensagem **Contratacao existente recuperada com sucesso** e os mesmos IDs de proposta/agendamento da primeira resposta. Recarregue as duas agendas e as notificações: permanece um agendamento e um evento de aceitação. Se a notificação foi marcada como lida, o replay não a torna não lida novamente. O ensaio automatizado também verifica esses contratos; não interprete 409 como sucesso. Em 503 ou erro de comunicação, consulte as leituras e mantenha o resultado como não confirmado, sem repetir a escrita automaticamente.

## Encerramento

Digite `sair` ou use Ctrl+C e aguarde a mensagem **Encerrado**. SIGINT, SIGTERM quando suportado e fechamento normal da entrada do terminal usam a mesma rotina, protegida contra execução duplicada. Ela fecha admissão HTTP, aguarda handlers, fecha conexões e encerra/remove somente o processo e diretório criados pelo helper descartável. Contas, serviços, pedidos, propostas, agendas e notificações desse ensaio deixam de existir. O serviço MongoDB instalado e qualquer outro banco permanecem fora desse ciclo.

O navegador pode conservar a sessão fictícia em localStorage da origem antiga. Feche as janelas do ensaio. Na próxima execução use a nova URL e crie novas contas; nenhuma conta é importada ou persistida entre ensaios.

## Limites conhecidos

- Cancelamento de pedido, reserva direta, alteração/cancelamento de agenda e exclusão de serviço ficam bloqueados. Durante ACEITAÇÃO também ficam bloqueados cadastro, login e criação de serviços, pedidos e propostas.
- Chat, favoritos, avaliações, FAQ via API e edição de perfil não estão montados. Links continuam visíveis no frontend; podem apresentar 404, avisos de indisponibilidade ou erros no Console. A contagem de avaliações pode ficar indisponível. Esses domínios não foram ativados para esconder mensagens de erro.
- O formulário de cadastro do prestador possui informações adicionais de apresentação que o fluxo atual não envia ao backend; para a jornada, cadastre o serviço pelo dashboard.
- O prestador consulta atualizações periodicamente; uma recarga explícita facilita a demonstração. Não há promessa de atualização instantânea.
- O service mantém horário fixo **09:00**. Não há reserva concorrente de horários entre contratações distintas. Prepare pedidos/prestadores sem conflitos de agenda.
- Mais de um serviço do mesmo prestador/categoria torna a escolha ambígua e retorna 409. Pedidos legados não certificados também retornam conflito.
- Ícones/fontes externos podem depender de internet; os recursos públicos locais são servidos pela mesma origem da API.
- A barreira é de processo único e não resolve coordenação distribuída. Não usar este launcher como servidor hospedado.

## Evidência e validação

O teste `tests/demo-contratacao-local.test.js` inicia o CLI real e verifica arquivos estáticos, bloqueio de arquivos privados/traversal, cadastro/login, serviço/pedido/proposta, transição, aceitação/replay e limpeza. Testes adicionais exercitam SIGINT/SIGTERM, prontidão inválida e encerramento durante drenagem com persistência real descartável. As Entregas 1 e 2 cobrem vínculos, rollback, privacidade dos GETs e lógica real do frontend com DOM simulado.

**Validação visual manual pendente:** nesta implementação, o acesso direto ao navegador estava indisponível e o Computer Use interrompeu a automação por não conseguir identificar a URL atual com segurança. Não foi possível comprovar visualmente o roteiro completo em dois perfis; os testes HTTP e de scripts não substituem essa evidência. Execute o roteiro acima antes de considerar a demonstração visual aprovada.

Testes específicos: `node --test tests/demo-contratacao-local.test.js`. Suíte: `npm test`, com o `mongod` local disponível no PATH somente do processo de testes quando necessário. Nenhum teste deve usar banco persistente.
