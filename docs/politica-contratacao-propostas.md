# Política de contratação por propostas — proposta para aprovação

**Estado do documento: proposta, sem aprovação e sem implementação.**
Base: branch `refactor/arquitetura-mvc`, commit `288fa65`, em 8 de novembro de 2026.
Somente documentação é alterada na Fase 6C.0. As recomendações abaixo não descrevem
garantias já implementadas e não autorizam migrações, índices ou acesso a dados existentes.

Referência de evidências: [pendencias-funcionais.md](pendencias-funcionais.md), FUNC-001
a FUNC-006. A última suíte informada tem 797 aprovações, nenhuma falha ou teste ignorado;
nenhum teste foi executado novamente nesta fase documental.

## 1. Estado atual confirmado

| Entidade | Valores exatos do enum | Padrão | Fonte |
|---|---|---|---|
| Pedido | `aberto`, `em andamento`, `finalizado`, `cancelado` | `aberto` | [pedidoModel.js](../Models/pedidoModel.js) |
| Proposta | `enviada`, `aceita`, `recusada` | `enviada` | [propostaModel.js](../Models/propostaModel.js) |
| Agendamento | `pendente`, `confirmado`, `cancelado`, `finalizado` | `pendente` | [agendamentoModel.js](../Models/agendamentoModel.js) |

As tabelas propostas usam exclusivamente esses estados. Metadados de vínculo/controle
citados adiante são alterações futuras de persistência, não estados novos dos schemas.

- Pedido tem cliente, categoria e data desejada opcional; não registra a proposta vencedora.
- Proposta referencia pedido/prestador e tem valor, prazo e descrição. O índice declarado
  único `(pedido_id, prestador_id)` impede duas propostas desse par, não duas aceitações por pedido.
- Serviço tem prestador/categoria/preço, sem unicidade declarada por prestador/categoria.
- Agendamento referencia cliente/prestador/serviço e tem data/hora/status; não tem vínculo
  declarado com proposta/pedido nem garantia de unicidade da contratação ou horário.
- Não há endpoint atual específico para finalizar pedido nem coordenação automática
  implementada entre conclusão/cancelamento de agendamento e estado do pedido.

O [service atual](../services/propostaService.js) carrega proposta e pedido, verifica
propriedade, salva proposta aceita, salva pedido em andamento, recusa as demais propostas,
busca o primeiro serviço correspondente e cria agendamento se o encontrar. Usa data desejada
ou data atual e hora fixa `09:00`. Notifica depois dessas operações. Não valida os estados
anteriores nem implementa idempotência, reserva de horário ou atomicidade entre documentos.

O [helper de notificação](../utils/notificacaoHelper.js) captura erros de gravação sem
propagá-los. Portanto, apenas aguardá-lo não garante que a notificação foi persistida.

## 2. Invariantes propostas

Para novas contratações, após aprovação das decisões da seção 8:

1. Cada pedido pode originar uma única contratação efetiva e ter uma única proposta vencedora.
2. Somente cliente proprietário pode aceitar; IDs de cliente/prestador recebidos no corpo
   não substituem os vínculos persistidos nem a identidade autenticada.
3. Sucesso na aceitação significa contratação consistente com agendamento existente e vinculado.
4. Repetição não cria novo agendamento, não repete notificação e não altera a proposta vencedora.
5. Um pedido encerrado não é reaberto por aceitação ou por repetição de requisição.
6. Histórico de proposta aceita permanece identificável, inclusive se a contratação for cancelada.
7. Contratação direta, por proposta e mudanças que reocupem horário obedecem à mesma regra de reserva.
8. Falha não pode deixar sucesso parcial invisível. A estratégia de consistência precisa
   permitir identificar o resultado após perda da resposta HTTP ou reinício do processo.

## 3. Elegibilidade e avaliação da requisição

### Primeira aceitação

Recomendação sujeita a aprovação: exigir pedido `aberto`, proposta `enviada` pertencente
àquele pedido, cliente proprietário, prestador existente com papel correto, serviço
inequivocamente correspondente e data/horário aprovados e disponíveis. As condições de
estado e propriedade devem participar das escritas condicionais, além da validação de leitura.

Não aceitar IDs derivados apenas da interface. Referência removida, múltiplas propostas
já aceitas ou vínculo legado ambíguo devem produzir conflito revisável, sem reparo automático.

### Repetição da mesma aceitação

Primeiro autorizar a conta e verificar se existe resultado de contratação concluída e
inequivocamente vinculado à mesma proposta. Esse resultado deve ser recuperado antes de
reaplicar as precondições de uma nova contratação, pois o pedido já terá mudado de estado.

Recomendação: retornar `200` com a mesma proposta/agendamento e seus estados atuais,
sem novas escritas ou notificações, quando o pedido estiver `em andamento` ou `finalizado`.
Não exigir que o serviço ainda esteja publicado para devolver uma contratação já concluída.

Se a contratação foi cancelada posteriormente, recomendar `409`, sem recriação. Isso
preserva idempotência dos efeitos, embora a resposta possa variar com uma mudança legítima
de estado posterior. Alternativa de resposta histórica `200` está na decisão D02.

Proposta marcada aceita sem vínculo completo não prova sucesso: retornar conflito de
consistência ou acionar recuperação aprovada. Não criar outro agendamento por dedução.

### Outra proposta já aceita

Recomendação: `409` para tentar aceitar outra proposta do mesmo pedido. Não substituir
o vencedor, não recusar a proposta já aceita e não cancelar implicitamente o agendamento.
Concorrência entre candidatos deve produzir no máximo um vencedor persistido.

## 4. Tabelas propostas de transições

Todas as permissões pressupõem autenticação, papel e propriedade corretos. Transições
não listadas como permitidas ficam proibidas na proposta mínima. Repetir um estado não
é uma nova transição: a operação deve conferir resultado consistente e evitar efeitos extras.

### Pedidos

| Origem | Destino/ação | Política proposta | Responsável e condição |
|---|---|---|---|
| `aberto` | `em andamento` | Permitida | Caso de uso de aceitação conclui contratação vinculada |
| `aberto` | `cancelado` | Permitida | Cliente proprietário; concorre com aceitação; propostas enviadas são recusadas de forma coordenada |
| `aberto` | `finalizado` | Proibida | Sem contratação concluída não há conclusão a registrar |
| `em andamento` | `finalizado` | Permitida, dependente de D06 | Consequência da conclusão do agendamento vinculado; fluxo atual ainda não a implementa |
| `em andamento` | `cancelado` | Somente cancelamento coordenado, D06 | Cancelamento permitido do agendamento vinculado; não alteração isolada do pedido |
| `em andamento` | aceitar outra proposta ou voltar a `aberto` | Proibida | Nova contratação exige novo pedido |
| `finalizado` ou `cancelado` | reabrir ou aceitar nova proposta | Proibida | Estados terminais para novas contratações |
| `em andamento` ou `finalizado` | repetir a mesma aceitação concluída | Consulta idempotente `200`, D02 | Recuperar o vínculo existente, sem transição |
| `cancelado` | repetir aceitação anterior | Conflito `409`, D02 | Não recriar contratação |
| `cancelado` | repetir cancelamento autorizado | `200` sem novos efeitos, D06 | Mesmo resultado persistido |

### Propostas

| Origem | Destino/ação | Política proposta | Condição |
|---|---|---|---|
| `enviada` | `aceita` | Permitida | Primeira aceitação elegível e consistente |
| `enviada` | `recusada` | Permitida automaticamente | Outra proposta venceu ou pedido aberto foi cancelado |
| `recusada` | `aceita` ou `enviada` | Proibida | Não reativar candidato encerrado |
| `aceita` | `recusada` ou `enviada` | Proibida | Preservar o vencedor/histórico, mesmo após cancelamento da contratação |
| `aceita` | repetir aceitação | Somente replay de resultado vinculado, D02 | Não é nova contratação |

Não se propõe endpoint de recusa manual nesta etapa. Um `updateMany` futuro deve atingir
apenas concorrentes elegíveis, sem reclassificar propostas historicamente aceitas.

### Agendamentos

| Origem | Destino/ação | Política mínima proposta | Responsável |
|---|---|---|---|
| criação | `pendente` | Permitida com reserva válida | Contratação direta ou aceitação |
| `pendente` | `confirmado` | Permitida | Prestador proprietário |
| `pendente` | `cancelado` | Permitida, D06 | Cliente proprietário cancela ou prestador proprietário recusa |
| `pendente` | `finalizado` | Proibida | Exigir confirmação antes da conclusão |
| `confirmado` | `finalizado` | Permitida | Prestador proprietário; atualizar pedido vinculado conforme D06 |
| `confirmado` | `cancelado` | Bloqueada na opção mínima, D06 | Alternativa requer aprovar quem pode cancelar e em que prazo |
| `finalizado` ou `cancelado` | voltar a `pendente`/`confirmado` | Proibida | Sem reabertura silenciosa de reserva |
| `finalizado` | `cancelado` | Proibida | Preservar conclusão, histórico e avaliações |
| `cancelado` | repetir cancelamento | `200` sem efeitos extras, D06 | Proprietário autorizado |

Cancelar contratação vinculada deve atualizar pedido/agendamento juntos, liberar a reserva
conforme D05 e manter a proposta como `aceita` para histórico. Não gerar um novo pedido
nem reativar propostas automaticamente. A mesma transição de agendamento direto não
deve procurar pedido inexistente. Casos legados sem vínculo exigem tratamento separado.

## 5. Serviço, agenda e termos da contratação

- **Sem serviço:** recomendar rejeição `409` antes de alterar qualquer documento.
  Preservar pedido/propostas e não emitir notificação de sucesso. Uma simples leitura
  antecipada reduz falhas, mas não resolve remoção concorrente do serviço.
- **Mais de um serviço correspondente:** o `findOne` atual não expressa uma escolha de
  negócio. D04 decide se o serviço deve ser vinculado à proposta ou se a ambiguidade é rejeitada.
- **Termos:** o valor/prazo aceitos são os da proposta, não uma substituição silenciosa
  pelo preço atual do serviço. Proposta/agendamento ainda não têm todos os vínculos e
  snapshots necessários; qualquer campo novo será proposta de schema separada.
- **Agenda:** D05 define data, hora e fuso. A opção mínima mantém `09:00` somente se
  informado visivelmente na confirmação, em data futura válida. Sem data, rejeitar em
  vez de usar automaticamente o dia atual. Alternativa: horário explicitamente negociado.
- **Conflito mínimo:** mesma chave normalizada de prestador, dia e hora, ocupada por
  `pendente`/`confirmado`. Intervalos sobrepostos não podem ser prometidos sem modelo de
  duração e política próprios. Finalização/cancelamento e eventual liberação precisam ser coerentes.

## 6. Requisitos de persistência e concorrência

### Identidade e unicidade duráveis

Propor vínculo explícito pedido → proposta vencedora → agendamento e identidade estável
do evento de aceitação. Esses vínculos não existem hoje. A chave de idempotência deve
representar o pedido/proposta autorizado, não apenas uma chave arbitrária enviada pelo cliente.

Requisitos a desenhar e validar antes de índices:

- Uma contratação vencedora por pedido, resistente a requisições em processos diferentes.
- Um agendamento por contratação, distinguindo a origem por proposta de agendamentos diretos.
- Uma notificação de aceitação por evento/destinatário. Não deduplicar apenas por texto,
  pois isso pode juntar aceitações legítimas de pedidos diferentes.
- Reserva concorrente comum aos fluxos direto e por proposta, com normalização de horário.
- Repetição após commit e perda da resposta recupera os mesmos vínculos; não reexecuta efeitos.

Uma atualização condicional do pedido com proprietário e estado esperado pode escolher
um vencedor atomicamente naquele documento, mas não torna as demais coleções atômicas.
Sem garantia adicional, falhar depois dessa escolha ainda pode deixar contratação incompleta.
`updateMany` também não é uma transação de todo o conjunto. [MongoDB: atomicidade](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)

Índices únicos são candidatos para garantir unicidade persistente. O índice existente
de proposta por pedido/prestador não substitui as garantias acima. A definição exata
das chaves e do filtro parcial para documentos novos/vinculados depende do desenho aprovado.
Campos ausentes/nulos e duplicidades legadas precisam de análise: um índice único pode
recusar dados atuais e falhar na criação. Não preencher vínculos históricos por suposição.
Um filtro parcial para novos vínculos não autoriza ignorar uma contratação legada e
criar outra para o mesmo pedido. Casos sem identificação confiável devem ser bloqueados
para revisão; leitura e escrita precisam considerar essa convivência durante a transição.
[MongoDB: índices únicos](https://www.mongodb.com/docs/manual/core/index-unique/)

### Estratégia A — Transação multidocumento (preferida, condicionada à viabilidade)

Recomendação: tratar escolha do vencedor, proposta, pedido, recusa dos concorrentes,
agendamento e notificação persistida como uma unidade de commit. Se algum passo falhar,
não devolver sucesso parcial. Usar sessão explícita da mesma conexão em todas as
operações relevantes, inclusive leituras/populate, e validar isso com testes.

MongoDB standalone não suporta transações multidocumento. É necessário replica set ou
cluster fragmentado compatível. A topologia real não foi consultada e não está presumida.
O helper atual inicia standalone; os testes das Fases 6B não provam transações. Um futuro
ensaio precisa de replica set local temporário próprio, com identificação e limpeza tão
restritas quanto as atuais, sem converter um serviço persistente.
[MongoDB: requisitos de transações](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)

O projeto declara Mongoose `^7.5.0` e a instalação inspecionada é `7.8.10`. A API de
transação da conexão/sessão deve ser validada nessa versão. Preferir sessão explícita,
operações sequenciais e encerramento garantido; não depender de propagação implícita.
Callbacks podem ser repetidos em erros transitórios: nenhum efeito externo não idempotente
deve ser disparado dentro deles. [Mongoose 7: transações](https://mongoosejs.com/docs/7.x/docs/transactions.html)

O helper de notificações atual não recebe sessão e suprime falhas. Não o chamar inalterado
e presumir participação na transação. Uma futura operação de notificação transacional
precisa aceitar a sessão e propagar falhas, sem mudar inadvertidamente os outros chamadores.
Alternativa: gravar evento durável na mesma transação e materializar a notificação depois,
com deduplicação e recuperação; isso acrescenta mecanismo operacional e depende de D07.

Transação não cria chaves estrangeiras nem elimina todas as corridas de disponibilidade:
duas transações que apenas leem horário vazio e inserem documentos distintos precisam
também de uma garantia compartilhada de reserva. Exclusão/alteração concorrente de serviço,
cancelamento e aceitação devem obedecer ao mesmo protocolo de escrita.

### Estratégia B — Operações condicionais e recuperação durável

Alternativa se transações não forem viáveis: identidade persistente da operação, escolha
atômica do vencedor, efeitos idempotentes com unicidade e protocolo de recuperação.
Não usar apenas uma flag em memória ou apenas verificar `status === aceita`.

Vantagem: pode evitar dependência de transação multidocumento. Riscos/custo: dados podem
ficar temporariamente parciais; é necessário detectar retomada, falha após reinício e
resultado desconhecido. Metadados técnicos de execução precisam de desenho próprio,
sem acrescentar estados de negócio aos enums por este documento.

Essa alternativa só pode ser considerada adequada para FUNC-003 se estados parciais
forem identificáveis e recuperáveis segundo contrato aprovado. Não prometer atomicidade
igual à Estratégia A. Não apagar registros para compensar nem reverter dados concorrentes
legítimos sem protocolo testado. Um lock local não coordena múltiplas instâncias.

## 7. Contratos HTTP e impacto na interface — sujeitos a aprovação

Manter URLs e métodos, incluindo `PUT /api/propostas/:id/aceitar`, e JWT/papéis atuais.

| Situação | Contrato proposto | Diferença em relação ao atual |
|---|---|---|
| Primeira aceitação concluída | `200`, mesmas chaves `mensagem`, `proposta`, `agendamento` não nulo | Retira sucesso sem agendamento |
| Repetição da mesma contratação concluída | `200`, mesmos IDs, mensagem de resultado existente | Não duplica efeitos; interface não anuncia nova criação |
| Sem token / token inválido | `401`, mensagens atuais | Preservado |
| Papel errado ou cliente não proprietário | `403`, mensagens atuais | Preservado; autorizar antes de revelar vínculos |
| Proposta inexistente | `404`, mensagem atual | Preservado |
| Pedido/proposta não elegível, outro vencedor ou contratação cancelada | `409`, `mensagem` e código estável a aprovar | Hoje alguns desses casos retornam sucesso |
| Serviço ausente/ambíguo, referência quebrada ou vínculo inconsistente | `409`, sem efeitos | Hoje pode haver `null` ou `500` |
| Horário ocupado na aceitação | `409`, sem efeitos | Hoje não há bloqueio |
| Falha inesperada antes de commit | `500`, mensagem pública segura | Contrato de detalhe em `erro` exige decisão própria, FUNC-012 |
| Commit com resultado incerto / recuperação em curso | Consultar identidade persistida antes de responder; sem sucesso presumido | Resposta final depende da estratégia aprovada, D08/D10 |

Não unificar incidentalmente o `400` atual de conflito no agendamento direto nem a
validação de IDs de todos os domínios. Mudanças para `400`/`409` e sanitização de erros
devem ser especificadas, aprovadas e testadas com FUNC-011/012/013.

O dashboard do cliente anuncia hoje que o agendamento foi criado para qualquer sucesso.
Deverá reconhecer replay, conflito e ausência de conclusão, mostrar mensagem coerente,
atualizar pedido/propostas/agenda e permitir recuperação da resposta sem nova contratação.
Bloquear duplo clique ajuda a experiência, mas não substitui a proteção persistente.
Botões de cancelamento/conclusão devem seguir D06; esconder botão não é autorização.

## 8. Decisões que exigem aprovação

| ID | Recomendação para o TCC | Alternativa razoável | Vantagem e risco a decidir |
|---|---|---|---|
| D01 | Aceitar somente pedido aberto e proposta enviada; uma contratação por pedido | Permitir reabertura/troca de vencedor em fluxo separado | Regra mínima é simples e preserva histórico; alternativa exige cancelamento e nova contratação coordenados |
| D02 | Replay `200` em contrato em andamento/finalizado; `409` após cancelamento | Sempre `409` na repetição, ou `200` histórico inclusive cancelado | `200` ajuda retry após resposta perdida; exige vínculo confiável. `409` é simples, mas não demonstra por si só se a primeira tentativa concluiu |
| D03 | Ausência de serviço impede aceitação com `409`, sem escrita | Aceitar sem agendamento e apresentar isso explicitamente | Obrigatoriedade mantém promessa da interface; alternativa muda o significado de contratação e mantém fluxo adicional |
| D04 | Serviço inequívoco; rejeitar ambiguidade até vínculo explícito na proposta | Acrescentar escolha de serviço na proposta agora; ou regra de seleção determinística aprovada | Vínculo explícito é mais claro, mas altera API/frontend e exige tratar legados; seleção automática pode escolher serviço inadequado. Preservar valor/prazo acordados |
| D05 | Data futura obrigatória na aceitação, fuso único de negócio; `09:00` visível e confirmado; conflito por slot normalizado | Horário negociado e modelo de duração/sobreposição | Opção mínima reduz escopo, mas é limitada; negociação exige campos/contratos adicionais. Fuso sugerido: `America/Sao_Paulo`, ainda a aprovar |
| D06 | Transições da seção 4; cancelamento de pendente coordenado; confirmado/finalizado sem cancelamento comum; conclusão atualiza pedido vinculado | Permitir cancelamento de confirmado com prazo e responsáveis definidos | Regra mínima protege histórico, mas restringe situações legítimas; alternativa exige prazo, consequências e notificações. Não existe hoje coordenação implementada |
| D07 | Notificação MongoDB da aceitação no mesmo commit, com identidade única de evento | Evento durável transacional e entrega posterior deduplicada | Primeira opção simplifica consistência, mas falha de notificação bloqueia aceitação; alternativa desacopla entrega com custo de recuperação/execução operacional |
| D08 | Estratégia A se topologia compatível for validada | Estratégia B com protocolo de recuperação aprovado | A facilita all-or-nothing; B evita dependência transacional, mas é mais complexa e tem consistência temporária explícita |
| D09 | Aplicação estrita a novas contratações; legados ambíguos bloqueados para revisão, sem apagar dados | Reconciliação/migração histórica específica e autorizada | Abordagem conservadora preserva contas/históricos, mas pode restringir replay de registros antigos; migração exige prova e backup isolado |
| D10 | Contratos da seção 7, mantendo envelope de sucesso e erros de autorização atuais | Introduzir versionamento/códigos adicionais ou contrato assíncrono de recuperação | Mudança mínima reduz impacto; novos contratos precisam de frontend compatível e testes próprios |

Nenhuma recomendação desta tabela está aprovada por este documento. Não inferir decisão
de negócio do enum, do teste de caracterização ou da existência de um botão na interface.

## 9. Ordem incremental de implementação futura

| Etapa | Escopo proposto | Dependências e limite de conclusão |
|---|---|---|
| 6C.1 | Aprovar D01–D10, matriz HTTP e critérios. Criar testes das regras aprovadas; acrescentar guardas de elegibilidade/serviço para FUNC-001/006 | Escopo de contrato separado. Guardas de leitura não encerram concorrência nem FUNC-002/003; aceitação/cancelamento concorrentes continuam pendentes até protocolo comum |
| 6C.2 | Desenhar vínculos persistentes e identidade de aceitação/notificação; testar compatibilidade de documentos antigos em cópia fictícia | Preparação de schema backward compatible em tarefa própria; campos propostos não são obrigatórios retroativamente sem avaliação |
| 6C.3 | Validar solução em replica set descartável se A for escolhida, ou ensaiar recuperação durável se B | Não alterar helper/chat existente incidentalmente; reproduzir isolamento por PID, porta, diretório e banco. Nenhuma topologia de produção presumida |
| 6C.4 | Projetar/verificar garantias de unicidade e reserva; ensaiar índices candidatos somente em banco descartável | Alteração de declaração, criação operacional de índices e eventual migração são tarefas separadas. Dados existentes exigem inventário/backup e aprovação próprios |
| 6C.5 | Implementar idempotência e consistência de aceitação, FUNC-002/003, com precondições e identidade aprovadas | Tratar como caso de uso coeso: não anunciar replay seguro apenas com teste de status. Ativar somente com garantias persistentes/topologia exigidas disponíveis |
| 6C.6 | Integrar disponibilidade e transições coordenadas, FUNC-004/005, em contratação direta, aceitação e cancelamento/conclusão | Unicidade de contratação não impede conflito de horário. Conclusão desses itens exige testes de todas as entradas e corridas entre elas |
| 6C.7 | Ajustar frontend conforme contrato aprovado e ensaiar jornada completa | Resposta perdida/retry, outra conta, cancelamento, conclusão e mensagens coerentes; nenhuma correção declarada só por toast/estado local |

É possível preparar testes/topologia e documentação em paralelo ao desenho, mas produção
não deve receber uma solução parcial apresentada como garantia completa. FUNC-001 inclui
corrida com cancelamento; FUNC-006 inclui serviço removido durante a operação. Seus
critérios completos dependem da consistência e da coordenação das fases seguintes.

Preservar contas, hashes, IDs, históricos, avaliações e chat. Não executar drop/syncIndexes,
remover duplicados automaticamente ou inferir vencedor histórico por ordem/data aproximada.
Índices únicos em dados antigos exigem levantamento de duplicidades e de campos ausentes
em cópia protegida autorizada; o plano de reconciliação não é parte desta fase documental.

## 10. Testes existentes a rever e testes adicionais

Somente a futura correção autorizada poderá alterar expectativas de comportamento defeituoso.
Preservar evidência desta fase por commits e referências, mantendo os cenários de teste.

| Testes atuais | Expectativas que devem mudar após aprovação |
|---|---|
| [propostas-rotas.test.js](../tests/propostas-rotas.test.js) | Aceitação de recusada/pedido cancelado; duplicação por repetição; `agendamento: null`; efeitos parciais em sete pontos; ordem atual de operações se houver transação |
| [agendamentos-rotas.test.js](../tests/agendamentos-rotas.test.js) | Reabertura de finalizado, cancelamento em qualquer estado, duas criações após consultas sincronizadas; respostas de conflito se aprovadas |
| [pedidos-rotas.test.js](../tests/pedidos-rotas.test.js) | Cancelamento de pedido finalizado/em andamento e coordenação de propostas/agenda |
| [propostas-agendamentos-mongodb.integration.test.js](../tests/propostas-agendamentos-mongodb.integration.test.js) | As evidências FUNC-001 a FUNC-006 passam a verificar prevenção, ausência de duplicação e atomicidade/recuperação conforme estratégia escolhida |
| Testes de interface do dashboard e novos cenários de contratação | Mensagem de replay, conflitos, restrição de ações e recuperação após perda de resposta; hoje a jornada de propostas não tem essa cobertura completa |

Acrescentar testes reais enxutos para:

- Duas aceitações simultâneas da mesma proposta e de propostas distintas do mesmo pedido:
  um vencedor, agendamento único e evento único, com verificação após recarga.
- Repetição após commit sem resposta HTTP; repetição após cancelamento/finalização;
  serviço removido após contratação concluída; vínculo legado incompleto.
- Falha em cada escrita da unidade consistente e na notificação, além de erro de commit,
  com comprovação de rollback real ou recuperação aprovada, sem mocks de escritas anteriores.
- Concorrência entre aceitação e cancelamento de pedido/agenda, exclusão de serviço e
  reservas de horário por entradas diferentes; isolamento entre contas permanece obrigatório.
- Datas equivalentes com representações diferentes, fuso e limites do slot; políticas
  de duração somente se aprovadas e modeladas.
- Índices candidatos, dados legados sem novos vínculos, duplicidades fictícias e caminho
  que bloqueia reconciliação ambígua sem alterar contas/históricos.

Todos os ensaios de persistência serão exclusivamente descartáveis. A suíte atual standalone
continua útil para caracterização; uma suíte de replica set própria será necessária para
provar transações. Não substituir esse ensaio por mocks nem usar banco persistente como fallback.

## 11. Critério para iniciar correções

Registrar aprovação de D01–D10, contratos e estratégia de consistência; delimitar a tarefa
seguinte e seus critérios de teste. Planejamento de índices/migração, acesso a dados
existentes e publicação exigem escopos específicos posteriores. Este documento não executa
nem autoriza tais ações. Os defeitos funcionais permanecem pendentes.
