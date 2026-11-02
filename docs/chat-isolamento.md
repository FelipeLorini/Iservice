# Isolamento de conversas — etapa 1

## Escopo e estado

Esta alteração isola conversas de dois usuários, valida referências e mensagens e protege o estado do frontend. Não implementa caixa de entrada. Não altera cadastro, login ou recuperação de senha. O único ajuste compartilhado em `app.js` permite ao chat encerrar seu estado quando a sessão muda.

Nenhum script desta etapa migra, exclui, une ou corrige documentos históricos. Nenhum índice é criado automaticamente pelo modelo de chat (`autoIndex: false`, `autoCreate: false`). Não executar `syncIndexes()` como atalho de implantação.

## Contrato e decisões

- IDs HTTP: somente strings hexadecimais de 24 caracteres, normalizadas para minúsculas. Objetos e arrays são rejeitados antes de consultas.
- Participantes: exatamente dois IDs válidos, distintos. O par é independente da ordem e não do serviço contratado.
- `pairKey`: IDs normalizados, ordenados e unidos por `:`. Participantes e chave são imutáveis nas operações normais do modelo.
- O destinatário e o usuário autenticado precisam existir para abrir o chat. Consulta, envio e marcação verificam novamente a existência de ambos os participantes. O campo `prestador_id` foi preservado no contrato, mas representa o outro usuário: a ordem inversa B–A é permitida, sem introduzir restrição nova de papel.
- Toda leitura, envio e marcação exige participação e integridade de todo o documento. Mensagens precisam ter remetente/destinatário diferentes e pertencentes ao par. Conversas inativas ou inconsistentes retornam 409 nas operações individuais; não aparecem em listagem/contagem. Nenhum conteúdo é apagado.
- Referências ausentes são preservadas como posições nulas no populate e invalidam o documento. Isso evita transformar um array antigo de três participantes em um par aparentemente válido.
- `/start` procura conflitos por par e por chave, incluindo chats inativos. Dois candidatos retornam 409. Um documento íntegro sem `pairKey` continua acessível e é reutilizado sem backfill implícito. Um inativo não é reativado silenciosamente.
- Sem candidato, a criação exige a presença do índice real descrito abaixo. O índice é apenas consultado; jamais é criado pelo controller. A conta do banco precisa poder listar os índices da coleção. Índice ausente retorna 503 com `CHAT_PAIR_INDEX_REQUIRED`; falha operacional nessa consulta retorna erro interno sanitizado.
- Criação usa `findOneAndUpdate` com `$setOnInsert`, `upsert`, validadores e índice único. Conflito 11000 na chave recupera o vencedor. Não depende de mutex em memória de uma instância do Render.
- O índice é único em `pairKey`, nunca em `participants`, e vale tanto para chats ativos quanto inativos.
- `GET /chat/:chatId` agora é somente leitura. A tela chama `PUT /chat/:chatId/read` após validar o retorno. Integrações externas que dependiam da marcação automática por GET precisam se adaptar.
- Escritas por documento usam concorrência otimista (`__v`). Um conflito de versão retorna 409 para nova tentativa, sem sobrescrever um envio mais recente. O frontend preserva o texto quando o envio falha. Não há reenvio automático de POST, para evitar duplicação após falha de rede ambígua.
- A abertura devolve `_id`, participantes e chave, sem devolver histórico. O frontend confere par e ID antes de navegar/exibir/enviar. URLs novas incluem `destinatarioId` e `usuarioId`; links antigos somente com `chatId` permanecem sujeitos à validação de participação no backend.
- Seleções diferentes cancelam a requisição anterior; seleções iguais compartilham a requisição pendente. Uma resposta antiga não ganha da seleção atual. Uma requisição abortada pode já ter criado um chat vazio legítimo no servidor; o cancelamento não desfaz operações confirmadas.
- Logout/troca de conta cancela consultas e envios, remove texto/rascunho/nome, desativa o formulário e interrompe o polling. Respostas também conferem o storage atual, mesmo antes de um evento de sincronização. O armazenamento de sessão continua compartilhado por abas da mesma origem.
- As mensagens são renderizadas novamente após cada sucesso, inclusive após falhas HTTP temporárias. Rotas de chat enviam `Cache-Control: no-store`.

## Bloqueio antes de publicar

**Não publicar esperando criar novos pares antes de preparar e revisar os dados e o índice.** O fallback seguro permite reutilizar chats legados íntegros, mas bloqueia a criação de novos pares com 503 quando falta o índice. Não existe fallback inseguro com `create()`.

Chats inválidos ficam indisponíveis; duplicados não podem ser escolhidos automaticamente por `/start`. Um link direto de um chat duplicado ainda permite acesso ao próprio documento se ele for íntegro e o usuário participar. Os históricos duplicados não são fundidos nem removidos, e podem permanecer separados até uma decisão de produto/migração. A listagem e a contagem continuam incluindo cada documento individual íntegro.

A restrição de unicidade parcial, sozinha, NÃO corrige registros antigos sem chave e NÃO é prova de saneamento. A verificação do índice no runtime é uma proteção contra concorrência, não uma certificação dos dados históricos.

## Plano separado de saneamento e migração (não executado)

1. Revisar em ambiente descartável uma cópia anonimizada ou fixtures; aprovar procedimento e backup/restauração antes de qualquer operação real. Levantar contagens agregadas, sem registrar textos, nomes, tokens ou dados de contato.
2. Inventariar cardinalidade/duplicação dos participantes, IDs inválidos, usuários removidos, mensagens fora do par, chaves divergentes, chats inativos e duplicidades pelo par normalizado. Não inferir o destinatário correto apenas pelo nome.
3. Tratar inconsistentes por decisão humana. Não adicionar participantes a partir de uma mensagem, atribuir mensagens a outra conta, apagar registros ou fundir conteúdo automaticamente. Preservar IDs e históricos, com eventual relação de substituição/arquivamento apenas em migração específica aprovada.
4. Para pares duplicados, definir política explícita de consulta e continuidade do histórico que preserve todos os documentos. Se isso exigir aliases ou agrupamento, implementar/revisar essa compatibilidade em outra etapa antes de atribuir a mesma chave a todos os registros. Esta etapa não implementa essa política.
5. Pausar todas as instâncias/escritores de chat durante o procedimento final, incluindo versões antigas da aplicação. Com todos os pares resolvidos, preencher a chave somente nos documentos aprovados. Validar que cada chave corresponde aos participantes e que não há repetição. Campos ausentes não podem ocultar conflitos históricos pendentes.
6. Somente após revisão, um operador autorizado deve criar e conferir o índice abaixo. Não executar o bloco em produção nesta etapa:

   ```javascript
   // Especificação de referência; não é uma migração executável desta alteração.
   db.chats.createIndex(
     { pairKey: 1 },
     {
       name: 'chat_pair_key_unique',
       unique: true,
       partialFilterExpression: { pairKey: { $type: 'string' } }
     }
   );
   ```

   Usar collation simples (padrão compatível com comparação binária); o runtime recusa um índice com collation diferente. Confirmar ausência de filtros adicionais/sparse. Confirmar a coleção efetiva em homologação. Não criar índice único multikey em `participants`.
7. Verificar índices e invariantes, executar integração e testes manuais, publicar código e frontend coordenadamente e reabrir escritores. Não manter uma versão antiga criando chats sem chave ao lado da nova.
8. Se houver regressão, pausar criações e revisar com backup preservado. Não reverter para um escritor antigo que ignore a chave nem remover o índice com escritores ativos. Nenhum comando de rollback destrutivo é fornecido aqui.

## Testes automatizados

Executar `npm test` (todos os testes) ou `node --test`.

- Backend: pares distintos, ordem inversa e normalização, rejeição de self-chat, IDs inválidos/inexistentes, participantes duplicados/extras, mensagens externas ao par, autorização de leitura/envio/leitura, referências removidas, legado sem chave, conflitos históricos e falta do índice.
- Concorrência: upsert por chave e recuperação de conflito 11000, mais teste real descrito abaixo. Testes sem banco exercitam os casts, validadores e populate reais do Mongoose no limite simulado do driver; não provam a unicidade de um servidor MongoDB.
- Frontend: última seleção, compartilhamento de abertura repetida, par incorreto, respostas fora de ordem, troca de conta/logout/401, rascunho, falhas HTTP/rede, recuperação, compatibilidade de URLs antigas e marcação explícita de leitura.
- Rotas: JWT ausente/inválido/expirado e encaminhamento autenticado, inclusive `/unread/count`, sem cache.

`tests/chat-mongodb.integration.test.js` procura `mongod` no PATH. Se ausente, marca a integração como ignorada com motivo explícito. Se presente, inicia um processo próprio ligado somente a `127.0.0.1`, com porta e diretório temporários, banco fictício e índice exclusivo desse processo. Não aceita URI de ambiente, não carrega `.env` e não usa Atlas. Ao terminar, encerra o processo e remove somente o diretório temporário criado pelo teste.

**A integração real já foi aprovada com MongoDB local descartável 8.0.34. Deve ser reexecutada na versão candidata à publicação.** Isso não comprova o estado dos dados ou da infraestrutura do Atlas. Não instalar ou conectar um banco de produção para satisfazer testes.

## Validação manual com contas fictícias

Usar homologação/servidor local com banco descartável já preparado. Criar clientes A e C e profissionais B e D. Usar perfis separados do navegador para sessões independentes.

1. Abrir A–B, enviar texto sintético e responder como B usando a URL do mesmo chat. A ausência de caixa de entrada permanece deliberada nesta etapa.
2. Abrir A–D e C–B: IDs diferentes e nenhum texto de A–B. Reabrir A–B: mesmo ID e histórico preservado. Solicitar B–A por API autenticada: mesmo par.
3. Tentar conversar com o próprio perfil, ID inválido e usuário inexistente. Não deve haver criação nem redirecionamento indevido.
4. Tentar ler, enviar ou marcar A–B com C. Esperar 403 e nenhum texto exposto. Sem token: 401.
5. Disparar várias primeiras aberturas do mesmo par em paralelo: um único documento. Preparar somente em fixtures um legado duplicado, um array extra e uma mensagem externa: esperar bloqueio/omissão, sem exclusão.
6. Com rede lenta, selecionar B e logo D. Somente a seleção D pode navegar. Repetir o clique no mesmo profissional: uma requisição pendente compartilhada.
7. Fazer logout/trocar A por C no mesmo navegador, com chat aberto em outra aba e requisição pendente. Mensagens, nome e rascunho antigos devem desaparecer. Voltar pelo histórico/BFCache e conferir validação da conta.
8. Simular 503 e falha de rede; restaurar a conexão sem enviar nova mensagem. A tela deve recuperar as mensagens existentes. Durante envio com falha, manter o texto para nova tentativa.
9. Confirmar que GET não marca leitura; a tela deve chamar PUT após validação. Testar envio e marcação concorrentes: nenhum histórico pode desaparecer; conflito retorna 409 para nova tentativa.
10. Em banco descartável sem o índice, conferir 503 para par novo e funcionamento de um único legado íntegro. Esse cenário documenta o bloqueio, não autoriza publicar com ele.

## Pendências antes do Render

- Manter a integração com `mongod` descartável aprovada e registrar o resultado da versão candidata à publicação.
- Revisar/aprovar saneamento e política de duplicados sem perda de históricos.
- Concluir preparação e verificação manual do índice; confirmar permissão de leitura de índices.
- Executar o roteiro acima em homologação, incluindo abas e rede lenta.
- Coordenar backend/frontend e escritores; não há compatibilidade de garantia de unicidade com escritor antigo.
- Não há caixa de entrada nesta entrega. O destinatário precisa de uma URL válida para abrir a conversa.

## Histórico de validação

O primeiro registro foi de 325 testes, com 324 aprovados e uma integração ignorada por ausência do executável no ambiente. Posteriormente, a integração de isolamento passou no MongoDB descartável 8.0.34. A entrega inicial da auditoria chegou a 344 testes aprovados, sem falhas ou ignorados. Esses registros são históricos; a execução mais recente consta abaixo.

Os testes locais incluem integrações com MongoDB real descartável e casos com dependências simuladas. Índices e dados de fixture são criados apenas em processos locais próprios. Não houve acesso ao Atlas, migração em dados reais, commit, push, merge ou deploy. Validação manual em homologação, revisão dos históricos, backup/restauração e preparação operacional de produção continuam necessários.

## Ferramenta de auditoria — etapa seguinte

Foi adicionada uma ferramenta separada em `scripts/auditChats.js`, com regras em `scripts/lib/chatAudit.js`. Ela produz somente contagens e não preenche chaves, resolve duplicidades, altera documentos ou cria índices. A CLI desta etapa está restrita a um MongoDB local explicitamente descartável; destinos remotos/Atlas estão bloqueados. A existência desse utilitário não autoriza seu uso em dados reais.

O procedimento, categorias, limites, testes e revisão/autorização necessária antes de uma eventual versão para produção estão em [chat-auditoria.md](chat-auditoria.md). A execução da auditoria não substitui a revisão de duplicidades nem o plano de migração descrito acima.


### Validação local da ferramenta de auditoria

Em 1 de novembro de 2026, a entrega inicial da auditoria foi validada com 344 aprovações e MongoDB 8.0.34 descartável. A etapa posterior adicionou 61 casos de robustez, chegando a **405 testes aprovados, zero falhas e zero ignorados**, além de um ensaio de volume executado separadamente. Os resultados e as limitações estão em [chat-auditoria.md](chat-auditoria.md).

O ensaio ampliado encontrou limite de memória com spill desabilitado; a ferramenta não emitiu relatório parcial. A aprovação dos testes de tratamento de falhas não significa que a auditoria completa esse volume, nem autoriza execução no Atlas. Continuam pendentes revisão dos dados reais mediante autorização própria, avaliação de carga, backup/restauração e plano de migração que preserve todos os históricos.
