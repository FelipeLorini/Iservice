# Hotfix do MVP — revisão para entrega em 12/11/2026

Base: `origin/main` em `64fb585`, verificada em 10/11/2026.
Branch: `fix/mvp-entrega-cientifica`. Nenhum merge da refatoração, commit ou publicação.

## Seleção de melhorias

| Situação | Melhoria | Decisão |
|---|---|---|
| Já existe na main | Sanitização de erros de cadastro/login/chat, JWT e projeção do perfil público | Código preservado; testes existentes executados |
| Já existe na main | Navegação autenticada, recuperação de sessão e notificações na home | Preservado; jornadas de cliente e prestador verificadas |
| Já existe na main | Favoritos, avaliações, isolamento do chat e lista de conversas nos dashboards | Preservado; sem implementação duplicada |
| Reaproveitada | Guardas do commit 7ae8ae8 para aceitação de propostas | Adaptadas diretamente ao controller atual: pedido aberto, proposta enviada e serviço existente, antes de qualquer gravação |
| Reaproveitada | Helper HTTP controlado | Adaptado à montagem de server.js da main; bloqueia dotenv, DNS, conexão habitual e listen de produção nos testes |
| Reaproveitada | scripts/auditChats.js e scripts/lib/chatAudit.js, versionados em 8b7e027 | Dependências ausentes dos testes já presentes na main. Não são imports da aplicação; ensaiados somente com dados fictícios/descartáveis |
| Específica desta entrega | Home com números, avaliações e seis profissionais fictícios | Substituídos por descrições de funcionalidades e links para profissionais.html |
| Específica desta entrega | Agendamento local da home e formulário contratar.html | Formulários retirados; URL antiga preservada com explicação e caminho para o catálogo real. Dados antigos do navegador não são lidos, enviados ou apagados |
| Adiada | Routers modulares, src/app.js e public/ | Organização útil, mas sem benefício imediato para os defeitos confirmados; evitar mudança ampla de caminhos nesta entrega |
| Adiada | Contratação vinculada, transações, novos campos e índices | Não incluídos. Exigem validação e publicação próprias |
| Adiada | Mudanças do dashboard ligadas à resposta/replay do novo protocolo | Não transportar contratos que esta branch não implementa |
| Adiada | Força da senha | Melhoria secundária; cadastro e regras de senha preservados |

## Comportamento e compatibilidade

- As URLs existentes, server.js, npm start, Models, middleware e Routers foram preservados.
- Home → Profissionais → login quando necessário → Dashboard → Profissionais é o caminho existente. O login mantém seu redirecionamento original; não foi acrescentado retorno automático ao catálogo.
- O catálogo consulta GET /api/servicos e contrata por POST /api/agendamentos, enviando serviço, data e hora com JWT. O sucesso depende da resposta da API e o Dashboard lê o registro persistido.
- PUT /api/propostas/:id/aceitar agora responde 409 nos três conflitos reaproveitados. O frontend atual já exibe dados.mensagem para respostas não exitosas. A autorização continua sendo verificada antes das novas guardas.
- Uma repetição sequencial da aceitação recebe conflito e não duplica agenda/notificação. O sucesso inicial mantém resposta e horário 09:00 do fluxo antigo.
- As guardas NÃO fornecem exclusão concorrente, transação ou recuperação de falha intermediária. Esses riscos preexistentes permanecem; não apresentar o fluxo antigo como equivalente ao protocolo novo.
- Os demais estados e regras de disponibilidade/cancelamento não foram alterados. Páginas antigas de categoria e outros conteúdos ilustrativos fora da home precisam de revisão editorial posterior; a home agora leva diretamente ao catálogo real.
- Os comandos opcionais de benchmark/ensaio de backup do package.json continuam fora desta entrega. Nenhum benchmark, seed ou migração foi executado.

## Validação e teste manual rápido

Os testes de interface executam scripts reais com DOM/dependências simulados. A integração executa a montagem Express e Routers reais com controllers reais de autenticação, serviços, pedidos, propostas e agendamentos; os Models pertencem exclusivamente ao mongod temporário. Outros controllers são substituições explícitas. Não importa a configuração de banco nem lê .env.

No worktree, com dependências instaladas e mongod local disponível:
```text
node --test tests/mvp-fidelidade.test.js tests/mvp-http.integration.test.js tests/navegacao.test.js tests/api-seguranca.test.js
npm test
```
Nesta estação, as dependências existentes são reutilizadas por NODE_PATH somente no processo dos testes; não houve instalação.

Em uma instância de teste explicitamente ligada a banco descartável (não usar o .env habitual):
1. Abrir a home deslogado: conferir ausência de notas, contagens e profissionais inventados. Os CTAs devem levar ao catálogo, que exige login.
2. Abrir contratar.html diretamente: não deve haver formulário de endereço, data ou envio; seguir o link do catálogo.
3. Cadastrar contas fictícias de cliente e prestador; como prestador, cadastrar um serviço.
4. Como cliente, entrar em Profissionais e contratar o serviço. Verificar POST /api/agendamentos com 201 e o registro no Dashboard após recarregar.
5. Tentar horário ocupado: verificar erro, sem confirmação de sucesso nem novo registro.
6. Voltar ao Início e navegar entre Dashboard, Profissionais e Perfil. No Dashboard, abrir favoritos e conversas; verificar que a conta permanece a mesma.
7. Enviar uma proposta para pedido aberto e aceitá-la como seu cliente. Repetir a aceitação: deve retornar 409; pedido cancelado/finalizado ou ausência de serviço também não deve ser aceito.
8. Em duas sessões separadas, confirmar que um cliente não consulta/aceita a proposta de outro.

Não houve inspeção visual da versão hospedada nesta tarefa nem acesso a Atlas/Render. Os testes automatizados não substituem a revisão visual final do hotfix. A branch de refatoração e seu diretório permanecem intactos.
