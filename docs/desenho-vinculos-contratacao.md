# Desenho de vínculos e identidade da contratação — Fase 6C.2

**Proposta técnica para revisão. Nenhum campo, índice ou comportamento deste desenho foi implementado ou aprovado por este documento.**

Base inspecionada: branch `refactor/arquitetura-mvc`, HEAD `7ae8ae8`, árvore inicialmente limpa, em 8 de novembro de 2026. Referência informada: 809 testes aprovados; a suíte não foi executada nesta fase documental. Não houve conexão com bancos, leitura de credenciais ou investigação de produção.

Este documento complementa a [política da 6C.0](politica-contratacao-propostas.md) e as [pendências funcionais](pendencias-funcionais.md), sem alterá-las. A descrição de comportamento atual naqueles documentos é histórica: a 6C.1 acrescentou guardas de estado e serviço e passou a rejeitar repetição sequencial com `409`. As decisões D02 e D04–D10 da política não se tornam aprovadas pela conclusão da 6C.1. FUNC-002/003/004/005 e os aspectos concorrentes de FUNC-001/006 não estão resolvidos por este desenho.

## 1. Diagnóstico confirmado no código

### Schemas e índices declarados

Os índices abaixo são declarações no código, não inventário de índices de um banco existente. As referências Mongoose não constituem chaves estrangeiras com verificação automática de existência.

| Model | Campos atuais relevantes | Estados e restrições reais |
|---|---|---|
| [Pedido](../Models/pedidoModel.js) | `cliente_id` → Usuario; `titulo`, `descricao`, `categoria`; `data_desejada` opcional; `status`, `data_criacao` | `aberto` (padrão), `em andamento`, `finalizado`, `cancelado`. Sem índice secundário declarado e sem vencedor/agendamento vinculado |
| [Proposta](../Models/propostaModel.js) | `pedido_id` → Pedido; `prestador_id` → Usuario; `valor` Number, `prazo` String obrigatórios; `descricao`, `status`, `data_criacao` | `enviada` (padrão), `aceita`, `recusada`. Único declarado `{ pedido_id: 1, prestador_id: 1 }`; impede propostas repetidas do mesmo prestador, não vencedores diferentes do mesmo pedido |
| [Servico](../Models/servicoModel.js) | `nome`, `descricao`, `preco`, `categoria`, `prestador_id` → Usuario, `data_criacao` | Campos de negócio obrigatórios. Sem unicidade declarada por prestador/categoria; vários serviços podem corresponder à busca da aceitação |
| [Agendamento](../Models/agendamentoModel.js) | `cliente_id`, `prestador_id` → Usuario; `servico_id` → Servico; `data` Date, `hora` String, `status`, `data_criacao` | `pendente` (padrão), `confirmado`, `cancelado`, `finalizado`. Referências/data/hora obrigatórias. Sem pedido/proposta de origem nem índice de contratação/horário |
| [Notificacao](../Models/notificacaoModel.js) | `usuario_id` → Usuario; `mensagem`, `tipo`, `lida` (false), `link` (vazio), `data_criacao` | Tipos `nova_proposta`, `proposta_aceita`, `novo_agendamento`, `cancelamento`, `avaliacao`. Sem identidade de evento ou índice de deduplicação |

Pedido e Servico compartilham o enum de categoria: `eletrica`, `encanamento`, `faxina`, `jardinagem`, `pintura`, `reparos`. Não se propõem novos estados de negócio. Cada documento já possui `_id`; nenhuma das relações faltantes pode ser deduzida apenas da existência desses identificadores.

### Aceitação e contratação direta hoje

O [service](../services/propostaService.js) carrega proposta com pedido populado, autoriza o proprietário, exige pedido `aberto` e proposta `enviada`, procura serviço pelo prestador/categoria e retorna conflito se ausente. Depois salva a proposta, salva o pedido, recusa concorrentes, cria agendamento e notifica. Não grava pedido/proposta no agendamento. Usa `data_desejada || new Date()` e `09:00`. O `findOne` não define qual serviço escolher entre vários. Escritas são separadas; uma falha posterior não desfaz as anteriores.

O [controller de propostas](../controllers/propostaController.js) conserva `401`/`403` nos middlewares, `404` para proposta inexistente, `403` para outro cliente, `409` nos novos conflitos e `200` com `{ mensagem, proposta, agendamento }` no sucesso. Repetição sequencial recebe `409`, não recupera o resultado anterior. Pedido referenciado removido ainda pode produzir `500`.

O [controller de agendamentos](../controllers/agendamentoController.js) recebe serviço explícito na contratação direta, deriva cliente do JWT e prestador do serviço. Consulta conflito por prestador/data/hora e estados `pendente`/`confirmado` antes de inserir. Consulta seguida de criação não é reserva concorrente. Atualização e cancelamento não coordenam Pedido; estados válidos no enum não significam transições de negócio válidas.

O [helper de notificação](../utils/notificacaoHelper.js) faz `create`, captura falhas e não as propaga. Seu `await` não comprova gravação, e ele não recebe sessão. O [controller de serviços](../controllers/servicoController.js) permite exclusão física pelo proprietário, sem verificar contratação: persistir uma referência não impede que seu destino desapareça.

### Rotas e consumidores a preservar

| Caminho público | Contrato de acesso atual | Dependência relevante |
|---|---|---|
| `PUT /api/propostas/:id/aceitar` | `auth`, `verificarCliente`, propriedade no service | `dashboard-cliente.html`, função `aceitarProposta`: envia PUT sem serviço no corpo; mostra “agendamento foi criado” em qualquer sucesso e recarrega pedidos/agenda |
| `POST /api/propostas` | `auth`, `verificarPrestador` | Dashboard do prestador envia pedido/valor/prazo/descrição, sem serviço escolhido |
| `GET /api/propostas/pedido/:id` e `/api/propostas/prestador` | Cliente proprietário / prestador autenticado | Dashboards leem IDs, status, valor, prazo e dados populados de prestador/pedido |
| `POST /api/agendamentos` | `auth`, `verificarCliente` | `profissionais.html` e `faxina.html` enviam serviço/data/hora; retorno `201` |
| `GET /api/agendamentos/cliente` e `/prestador` | Papel correspondente e filtro de sessão | Dashboards usam `servico_id` populado (`nome`, `preco`), outro usuário (`nome`, `telefone`), data/hora/status e `_id` |
| `PUT /api/agendamentos/:id/status` e `/:id/cancelar` | Prestador / cliente, com propriedade | Ações dos dashboards; não sincronizam pedido hoje |
| `/api/notificacoes`, `/:id/lida`, `/nao-lidas` | `auth`, filtros/propriedade por conta | `notificacoes.js` usa `_id`, tipo, mensagem, lida, data e link; lista limitada a 30, contagem separada |

Fontes: [propostaRoutes](../routes/propostaRoutes.js), [agendamentoRoutes](../routes/agendamentoRoutes.js), [pedidoRoutes](../routes/pedidoRoutes.js), [notificacaoRoutes](../routes/notificacaoRoutes.js), [userRoutes](../routes/userRoutes.js), [app](../src/app.js). Prefixos, montagem, JWT e papéis devem permanecer iguais. Campos internos novos não devem vazar automaticamente nos documentos serializados/populados: a futura implementação precisa definir projeção compatível, sem remover os campos públicos atuais.

### Evidência disponível e limites

- [propostas-rotas.test.js](../tests/propostas-rotas.test.js): ordem das consultas/escritas, autorização, guardas, repetição `409`, serviço ausente, sete pontos de falha e contratos HTTP com modelos simulados.
- [propostas-agendamentos-mongodb.integration.test.js](../tests/propostas-agendamentos-mongodb.integration.test.js): persistência real do caminho feliz, ausência de escrita em conflitos, repetição sequencial, falhas intermediárias, conflito direto/proposta, transições permissivas e duas reservas diretas após leituras sincronizadas. O teste chamado “vínculos” verifica os campos existentes; não prova relações Pedido → Agendamento ainda inexistentes.
- [agendamentos-rotas.test.js](../tests/agendamentos-rotas.test.js) e [pedidos-rotas.test.js](../tests/pedidos-rotas.test.js): identidade, propriedade, filtros, cancelamento e comportamentos imperfeitos atuais.
- [disposableMongo.js](../tests/helpers/disposableMongo.js) inicia standalone temporário. Não prova transações. A corrida entre propostas distintas é risco do desenho atual; não confundir com a corrida de reservas diretas já reproduzida.

## 2. Alternativas de modelagem

| Critério | A — vínculos nos documentos atuais | B — coleção Contratacao independente |
|---|---|---|
| Identidade | Pedido como raiz para proposta; Agendamento como raiz direta | `_id` de Contratacao, com origem e referências ao pedido/proposta/serviço/agenda |
| Complexidade inicial | Menor: amplia Models e caso de uso existentes | Maior: novo Model/coleção, consultas, ciclo de vida e adaptação dos dois fluxos |
| Compatibilidade | Mantém rotas e documentos consumidos; exige leitura tolerante a vínculos ausentes | Precisa construir contrato novo e manter projeções antigas |
| Consistência | Referências redundantes exigem invariantes e escrita coordenada | Centraliza identidade/termos, mas ainda depende de atomicidade com pedido, agenda e notificação |
| Idempotência | Chave natural por pedido; replay por vínculo completo | Chave própria, índice único por pedido e eventual chave de operação direta |
| Testes | Amplia fixtures atuais, cenários de legado e concorrência | Acrescenta fixtures e falhas envolvendo mais uma coleção |
| Evolução | Adequada a uma contratação e um agendamento por pedido | Melhor se houver pagamentos, recontratações, múltiplas visitas ou agenda independente do contrato |
| Prazo do TCC | Menor expansão de escopo | Benefício futuro, sem necessidade demonstrada para a jornada atual |

**Recomendação: alternativa A**, com um pequeno subdocumento de contratação em Pedido e vínculos inversos em Agendamento. Não criar coleção Contratacao, framework de workflow ou novo endpoint agora. A identidade deve sobreviver a cancelamento/finalização; não reutilizar pedido para outra contratação. A alternativa B volta a ser pertinente se essa cardinalidade mudar. Ela não eliminaria a necessidade de índices e consistência multidocumento.

## 3. Campos candidatos da alternativa recomendada

Nomes abaixo formam uma proposta concreta e coerente, ainda sujeita a aprovação. Todos os novos campos são inicialmente opcionais para leitura de legados, **sem defaults que transformem documentos antigos em novos**. Para novas operações ativadas, o conjunto exigido deve ser validado integralmente pelo caso de uso; “opcional no schema” não significa opcional na nova escrita.

| Documento / campo candidato | Tipo e referência | Regra proposta |
|---|---|---|
| Pedido.`fluxo_contratacao` | Number, único valor inicialmente `1` | Marca adesão ao protocolo; atribuído explicitamente apenas na criação nova pelo servidor ou em reconciliação autorizada. Não é status de negócio nem prova de contratação concluída |
| Pedido.`contratacao` | Subdocumento opcional, sem `_id` próprio | Ausente antes de contratar; completo no commit. Não aceitar objeto parcial/vazio/null como contratação válida |
| Pedido.`contratacao.proposta_id` | ObjectId, ref `Proposta` | Vencedor único, imutável após contratação. A proposta deve pertencer ao pedido |
| Pedido.`contratacao.servico_id` | ObjectId, ref `Servico` | Serviço efetivamente escolhido, preservado mesmo se sair do catálogo |
| Pedido.`contratacao.agendamento_id` | ObjectId, ref `Agendamento` | Identificador único alocado pelo servidor; não trocar em retry/cancelamento |
| Proposta.`servico_id` | ObjectId, ref `Servico` | No escopo mínimo, preenchido somente para a vencedora, na aceitação; deve ser igual ao serviço do contrato. Não exigir retroativamente nas propostas enviadas/legadas |
| Agendamento.`origem` | String: `direta` ou `proposta` | Obrigatório no protocolo novo; ausência significa origem não certificada, nunca inferência automática de contratação direta |
| Agendamento.`pedido_id` | ObjectId, ref `Pedido` | Obrigatório para origem proposta; ausente para novas diretas |
| Agendamento.`proposta_id` | ObjectId, ref `Proposta` | Obrigatório junto com pedido para origem proposta; deve ser o vencedor |
| Notificacao.`pedido_id` | ObjectId, ref `Pedido` | Para novo evento de aceitação, permite localizar a raiz sem interpretar texto/link |
| Notificacao.`evento_chave` | String canônica gerada no servidor | `pedido:<ObjectId hexadecimal minúsculo>:proposta_aceita:v1`; fixa por pedido/evento, sem data aleatória |

Não adicionar `contratacao_id` independente que repita Pedido._id, nem outro status de execução na solução transacional mínima. Se for escolhida recuperação sem transação, serão necessários metadados técnicos adicionais em desenho separado; não fingir que estes campos já implementam esse protocolo.

Pedido é a fonte de verdade do vencedor e dos IDs da contratação; Agendamento é a fonte de verdade do compromisso de agenda e de seu estado. As cópias de serviço e os vínculos inversos servem para consultas/integridade e devem concordar. Divergência não autoriza escolher silenciosamente uma cópia: bloqueia nova mutação e exige revisão.

O preço/prazo acordados continuam na proposta, distintos de `Servico.preco`; não substituir valor negociado pelo preço atual do catálogo. Um snapshot de nome/categoria/termos é uma opção futura, caso se aprove remoção ou alteração de catálogo sem perda de apresentação histórica. Não copiá-lo retroativamente a partir do catálogo atual como se fosse o valor histórico.

### Diagrama textual proposto

```text
Usuario cliente ──< Pedido (_id = identidade da contratação por proposta)
                      │ fluxo_contratacao = 1
                      │ contratacao.proposta_id ──> Proposta ──> Usuario prestador
                      │                              │ pedido_id ──> mesmo Pedido
                      │                              └ servico_id ──> Servico
                      │ contratacao.servico_id ─────────────────────> mesmo Servico
                      └ contratacao.agendamento_id ──> Agendamento
                                                        │ origem = proposta
                                                        │ pedido_id ──> mesmo Pedido
                                                        └ proposta_id ──> mesma Proposta

Notificacao ── pedido_id ──> Pedido
             evento_chave + usuario_id = evento único por destinatário

Contratação direta: Agendamento (_id = identidade direta), origem = direta
                   cliente_id / prestador_id / servico_id já existentes
                   sem pedido_id e sem proposta_id
```

## 4. Identidade, regras e recuperação

### Identidade estável e cardinalidade

- Por proposta: identidade lógica `pedido:<pedido._id>`. Não usar apenas proposta como chave, pois candidatos diferentes compartilham o pedido. Não depender de chave arbitrária enviada pelo navegador.
- Direta: identidade `agendamento:<agendamento._id>`. Os namespaces distinguem os fluxos. Não criar Pedido/Proposta fictícios para a contratação direta.
- Um pedido pode ter zero ou uma contratação ao longo de sua vida; a vencedora não muda após cancelamento/finalização. Uma contratação tem exatamente um agendamento no sucesso, inclusive se depois cancelado. Múltiplas visitas/recontratação exigiriam política nova.
- O `_id` da agenda identifica uma contratação direta já criada, mas não deduplica POSTs diretos cujo cliente perdeu a resposta antes de receber esse ID. Idempotência do POST direto exigirá chave de operação com escopo de conta e payload persistido, em tarefa própria. Reserva de horário e idempotência não são a mesma garantia.

### Primeira aceitação e concorrência

Após JWT/papel e propriedade, distinguir resultado existente, legado e pedido novo elegível. No protocolo novo: pedido `aberto`, proposta `enviada`, referências e identidades coerentes, serviço escolhido válido. Uma escrita condicional no mesmo Pedido deve filtrar `_id`, `cliente_id`, `status: aberto`, `fluxo_contratacao: 1` e ausência de `contratacao`, e gravar o conjunto de vínculos e o estado `em andamento`. Não usar upsert para fabricar um pedido ausente.

Essa operação escolhe no máximo um vencedor entre escritores que obedecem ao protocolo; o perdedor deve reler e classificar o resultado, não sobrescrever. A proposta também precisa de atualização condicional pelo pedido, prestador e estado esperado, com conferência de correspondência. Recusar apenas concorrentes `enviada`; uma segunda proposta já `aceita` é inconsistência, não algo a apagar com `updateMany`.

Conjunto recomendado para commit único futuro: escolha no Pedido, vencedor/serviço na Proposta, recusa dos concorrentes elegíveis, Agendamento com vínculos e Notificacao com identidade. Falha em qualquer etapa aborta o conjunto. IDs são alocados antes das escritas dessa tentativa e reutilizados dentro de retries transacionais; após commit, o resultado é recuperado pelos vínculos persistidos.

Cancelamento de pedido precisa concorrer no mesmo documento por condição de estado, e não executar `save` descondicionado depois da aceitação. Exclusão de serviço precisa participar de um protocolo comum: apenas ler o serviço dentro de uma transação não impede que outra operação o remova sem conflito de escrita. Recomenda-se impedir exclusão física de serviço contratado e coordenar a aquisição/exclusão, em mudança específica. Até isso ser projetado e testado, não declarar encerrado o aspecto concorrente de FUNC-006.

### Replay proposto, ainda não implementado

1. Autorizar a conta antes de revelar vínculos ou conflitos; manter `401`/`403`/`404` atuais nos casos aplicáveis.
2. Se há contratação completa da mesma proposta, conferir relações bidirecionais, cliente/prestador, serviço gravado e presença da agenda. Não executar novamente a seleção de serviço ou o cálculo de data/hora.
3. Para estados coerentes de pedido `em andamento`/`finalizado`, recomendar `200`, mesmo envelope e mesmos IDs, com estados atuais. Não promete bytes idênticos após mudanças legítimas. Isso substituirá o `409` sequencial da 6C.1 somente após aprovação e testes.
4. Se outra proposta venceu: `409`, sem nova agenda, notificação ou troca de vencedor. Proposta enviada no retry não define a identidade do contrato.
5. Se pedido ou agenda está cancelado: recomendar `409`, preservando todos os vínculos; nunca recriar. Alternativa: `200` histórico com mensagem inequívoca. Decisão D02 permanece aberta. Estados cruzados incoerentes exigem conflito/revisão, não replay de sucesso.
6. Vínculo parcial, agenda ausente, duas vencedoras ou legado ambíguo: conflito de consistência sem escrita automática. `status: aceita` isolado não comprova conclusão. Não criar agenda para “completar” um legado sem plano aprovado.
7. Serviço retirado após sucesso não exige nova escolha no replay: devolver IDs históricos e agenda existente. `populate` nulo deve ser tolerado pela apresentação; referência contratada continua identificável, mas não restaura descrição/preço apagados.
8. Resultado de commit incerto: consultar a identidade antes de qualquer nova tentativa de efeito. Se não for possível determinar conclusão, devolver erro transitório aprovado, sem afirmar sucesso nem criar outra contratação. Preferir `503` com mensagem pública de consulta/repetição segura, sujeito à decisão de contrato; não usar `202` sem mecanismo real de acompanhamento.

### Serviço correspondente e notificação

Opção mínima recomendada para D04: nenhum correspondente mantém `409`; exatamente um pode ser escolhido e vinculado; mais de um retorna conflito sem escrita. Alternativas: (a) prestador escolhe serviço ao enviar proposta, validado pelo backend — mais claro, mas muda formulário/API; (b) regra determinística de escolha aprovada — simples, mas pode contratar o serviço inadequado. Ordenar por `_id` não transforma escolha técnica em consentimento de negócio. Serviço explícito futuro deve ser do prestador e categoria corretos; cliente não pode forjar essa relação.

Notificação de aceitação usa chave derivada do pedido e do tipo/versionamento do evento, com destinatário prestador vencedor. A mesma chave é reutilizada em retry; versão `v1` não muda por tentativa. Mensagem, link e status `lida` não compõem a identidade. Repetir não reinsere, não redefine `lida` para false e não altera a data. Novo tipo de evento pode ter identidade própria; não deduplicar por texto.

Preferência D07: gravar a notificação MongoDB na mesma sessão/commit; helper específico deve propagar falhas. Não mudar silenciosamente a semântica de todos os chamadores do helper atual. Alternativa de evento durável e entrega posterior é válida, mas exige executor/recuperação e está fora do mínimo. Índice sozinho garante no máximo uma notificação, não entrega eventual nem existência; se uma notificação comprovadamente necessária desaparecer depois, reparar é tarefa separada, não efeito automático do replay.

## 5. Garantias e índices candidatos

| Mecanismo | O que poderá garantir | O que não garante |
|---|---|---|
| Validação de entrada/schema/caso de uso | Tipos, combinações de campos, papel, propriedade e referências verificadas | Exclusão concorrente entre leitura e escrita; integridade referencial contínua |
| Escrita condicional no Pedido | Um vencedor no documento, se todos os escritores usam estado/vínculo esperado e verificam resultado | Agenda/notificação existentes ou ausência de efeitos parciais em outras coleções |
| Índice único efetivamente criado | No máximo um documento por chave dentro de seu escopo | Existência obrigatória do documento, relação entre coleções ou abrangência de registros fora de filtro parcial |
| Transação com sessão em todas as operações | Commit ou aborto conjunto das escritas participantes | Regra de disponibilidade sem contenção/índice compartilhado; coordenação com escritor externo ao protocolo |

Atualizações MongoDB são atômicas por documento; filtros de estado esperado permitem disputa controlada. `updateMany` não torna todo o lote atômico. [Referência oficial de atomicidade](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).

**Descrições abaixo não são comandos a executar nem índices já declarados.** Ensaiar tipos BSON, erros, versão do servidor e filtros no banco descartável antes de aprovar a especificação final.

| Candidato | Chave, unicidade e filtro propostos | Objetivo/limite |
|---|---|---|
| I1 — agenda por pedido | Agendamento `{ pedido_id: 1 }`, unique; parcial `{ pedido_id: { $type: 'objectId' } }` | No máximo uma agenda vinculada ao pedido, independentemente do status; cancelar não libera a identidade |
| I2 — agenda por proposta | Agendamento `{ proposta_id: 1 }`, unique; parcial `{ proposta_id: { $type: 'objectId' } }` | Proteção adicional contra a mesma proposta associada a duas agendas/pedidos inconsistentes |
| I3 — agenda referida por um pedido | Pedido `{ 'contratacao.agendamento_id': 1 }`, unique; parcial por `$type: 'objectId'` no mesmo campo | Impede dois pedidos apontando a mesma agenda; não verifica se ela existe |
| I4 — vencedor referido por um pedido | Pedido `{ 'contratacao.proposta_id': 1 }`, unique; parcial por `$type: 'objectId'` no mesmo campo | Impede reutilizar a referência vencedora em pedidos diferentes; pertença ainda precisa de validação |
| I5 — notificação do evento | Notificacao `{ evento_chave: 1, usuario_id: 1 }`, unique; parcial `{ evento_chave: { $type: 'string' } }` | No máximo uma por evento/destinatário; entrada nova exige chave canônica não vazia e destinatário correto |

I1 e I5 são centrais; I2–I4 defendem a redundância escolhida e podem ser ensaiados no mesmo lote de testes de índices. Não criar índice unique de `(pedido_id, proposta_id)` como substituto de I1: permitiria duas propostas diferentes no mesmo pedido. Não filtrar unicidade de contratação por `status: pendente`, por origem ou somente por versão: cancelamento ou marcador omitido não deve liberar uma nova agenda com o mesmo pedido tipado. O índice já existente de Proposta por pedido/prestador deve ser preservado.

Índice adicional de Proposta por pedido com filtro `status: aceita` não é necessário ao mínimo proposto: vencedor canônico fica no Pedido e toda aceitação deve passar pelo mesmo protocolo. Pode ser defesa posterior, mas sua criação exige tratar múltiplas aceitas legadas e não garante agenda. Não adicionar índices redundantes sem necessidade comprovada.

Índices únicos não podem ser criados sobre duplicidades incompatíveis; campos ausentes/nulos exigem cuidado. Índices parciais só protegem documentos que satisfazem seu filtro. A proposta usa tipos explícitos para excluir legados sem vínculo, não como autorização para novas escritas incompletas. [Índices únicos](https://www.mongodb.com/docs/manual/core/index-unique/) e [índices parciais](https://www.mongodb.com/docs/manual/core/index-partial/).

### Reserva compartilhada futura — separada da identidade

Agendamento já é o ponto comum aos fluxos direto e por proposta. Após aprovar D05, normalizar início/fuso e definir a unidade do slot; candidato futuro é chave de prestador + início normalizado, única para compromissos ativos. Exemplo de campo ainda não aprovado: `inicio_reserva` Date em UTC; data/hora públicas continuam compatíveis. Filtro de estados ativos precisa refletir `pendente` e `confirmado` e ser ensaiado na versão real escolhida.

Ambas as criações e toda mudança que volte a ocupar horário devem usar a mesma proteção. Transação sem índice/registro compartilhado não impede duas inserções em documentos distintos após leituras vazias. Um índice de início exato não detecta sobreposição de durações; não prometer essa capacidade. Legados ativos sem início normalizado também ocupam agenda: bloquear novos horários afetados/indeterminados até reconciliação autorizada, em vez de excluí-los do filtro e declarar disponibilidade. Não alterar `09:00`, fallback de data ou regras de cancelamento nesta fase.

## 6. Compatibilidade com documentos anteriores

### Leitura, classificação e revisão

| Situação fictícia | Leitura permitida | Aceitação/replay proposto |
|---|---|---|
| Pedido antigo sem `fluxo_contratacao` e sem vínculos | Manter listagem e campos atuais | Não classificá-lo automaticamente como novo; precisa de elegibilidade certificada em revisão autorizada |
| Novo pedido com `fluxo_contratacao: 1`, aberto, sem contratação | Listagem normal | Pode disputar primeira aceitação no protocolo novo |
| Pedido/proposta antigos marcados aceitos/em andamento, sem agenda identificável | Preservar documentos e status históricos | Conflito revisável; não inferir agenda por data/prestador/categoria |
| Vínculos completos e coerentes | Listagem e replay autorizado | Mesmos IDs, sem novos efeitos; respeitar cancelamento/finalização |
| Referências parciais, ausentes ou cruzadas | Tolerar leitura sem erro de interface; sinalização restrita ao proprietário/operador | Bloquear mutação afetada; registrar necessidade de revisão |
| Duas agendas potencialmente legadas ou duas propostas aceitas | Preservar ambos os registros | Não escolher “a primeira”, apagar ou recusar automaticamente uma delas |

Proposta conservadora de transição: pedidos antigos sem certificação ficam disponíveis para leitura, mas não para nova aceitação pelo protocolo novo. Isso pode bloquear pedidos antigos legítimos; requer aprovação explícita. Evita concluir falsamente que um pedido aberto jamais teve efeitos parciais. Para a demonstração do TCC, usar pedidos novos fictícios criados pelo protocolo aprovado. Não resolver a situação criando pedido novo automaticamente em nome de uma conta.

Uma revisão futura deve produzir relatório restrito com IDs exatos, campos observados, motivo, evidência de origem e ação proposta. São motivos: vínculo ausente/parcial, referência inexistente, divergência de contas/serviço, múltiplas vencedoras, agenda compartilhada, contrato sem agenda ou evento, origem desconhecida. O relatório não é uma nova coleção aprovada por esta fase. Não imprimir dados pessoais/credenciais. Aprovar qualquer associação caso a caso com evidência explícita de origem; datas, categorias, nomes ou proximidade temporal não bastam.

Sem evidência suficiente, preservar o legado sem novos vínculos e manter bloqueio da operação ambígua. Não remover vínculos já preenchidos para “fazer o índice passar”. Duplicidades que colidam com um índice candidato impedem sua ativação até plano de reconciliação autorizado; não apagar documentos nem sobrescrever históricos.

### Fechar brechas do filtro parcial

1. Todos os novos escritores de contratação devem validar/preencher o conjunto de campos, sem confiar no body para origem, marcador ou vínculos. Cobrir também updates/upserts e tentativas de `$unset` dos vínculos, não apenas `save`.
2. O marcador de Pedido deve ser explícito em novas criações; não usar default que apareça na hidratação de um documento antigo, nem backfill universal. Sem marcador não há autorização implícita para primeira aceitação.
3. Antes de ativar, retirar de operação todos os escritores antigos do domínio. Uma versão antiga pode criar agendas sem pedido_id e escapar de I1: execução mista não é segura. Se não for possível coordenar isso, manter a escrita de contratação suspensa.
4. Confirmar criação real dos índices antes de habilitar o novo fluxo. Declaração de schema e opção `unique` não equivalem a garantia operacional disponível.
5. Leitura/validação de legado deve considerar documentos fora dos filtros; ausência de resultado no índice parcial não prova ausência de contratação anterior.
6. Validador de coleção pode ser defesa posterior contra bypass, mas exigirá desenho de convivência com legados e tarefa própria. Sem ele, a garantia é para os escritores controlados; não alegar que índices parciais impedem escritas arbitrárias incompletas feitas diretamente no banco.

### Separação operacional e rollback

- **Declaração:** adicionar campos e especificação dos índices em mudança de código revisável, com criação automática de índices controlada; não presumir que iniciar a aplicação executará a implantação correta.
- **Ensaio:** comprovar compatibilidade e criação/rejeição dos índices somente em fixtures descartáveis, inclusive nulos, ausentes, tipos errados e duplicidades.
- **Criação operacional:** tarefa autorizada distinta, com pré-verificação, backup, versões/topologia confirmadas e janela de escrita coordenada; sem `syncIndexes` ou descarte automático de índices.
- **Reconciliação/migração:** somente quando autorizada, com evidência, plano reversível por registro e preservação de IDs/contas/históricos. Não é requisito para apagar ou “limpar” legados antes do TCC.
- **Rollback de código:** manter uma versão de leitura compatível com novos campos, suspendendo a escrita de contratação se houver regressão. Voltar simplesmente ao writer da 6C.1 reabre brechas e pode sobrescrever estados sem respeitar vínculos. Não remover índices/campos como rollback automático; gravações já confirmadas permanecem dados reais. Testar leitura das duas gerações e definir retomada de escrita antes de liberar o rollback.

## 7. Atomicidade e ensaios futuros

Preferir transação para o pequeno conjunto de escritas da aceitação, condicionada à viabilidade verificada. MongoDB standalone não oferece transações multidocumento; será necessário replica set compatível (ou cluster fragmentado compatível, complexidade desnecessária para o ensaio do TCC). A topologia de qualquer ambiente existente é desconhecida. [Requisitos oficiais](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).

`package.json` declara Mongoose `^7.5.0`; `package-lock.json` fixa `7.8.10`. O ensaio deve usar essas dependências, conexão isolada e sessão explícita em leituras, populate, escritas e notificação; executar operações sequencialmente dentro da transação. Tratar retries e resultado de commit incerto sem efeitos externos repetidos. [Transações no Mongoose 7](https://mongoosejs.com/docs/7.x/docs/transactions.html).

Planejar helper separado de replica set exclusivamente descartável, mantendo o helper standalone e as integrações de chat/auth intactos. Verificar PID, porta, diretório temporário, nome de banco, sessão, encerramento e limpeza. Nunca usar URI externa como fallback. Falha de infraestrutura deve falhar claramente, não ignorar testes.

Ensaios necessários: duas aceitações da mesma proposta, duas propostas do mesmo pedido em conexões independentes, commit seguido de perda da resposta, falhas em cada escrita/notificação, reinício antes de replay, conflito de índice, referência removida e disputa com cancelamento. Conferir estado recarregado, exatamente uma agenda/evento e ausência de escritas indevidas; mocks de banco não comprovam essas garantias.

Se transação não for viável, manter a ativação pendente até desenhar recuperação durável com etapas, tomada condicional, retomada, retries e resultado incerto. Não implementar esse plano como simples sequência de upserts nem compensação por exclusão. Sua complexidade tende a exceder o caminho transacional para o escopo atual.

## 8. Exemplos exclusivamente fictícios

Os símbolos abaixo representam IDs distintos, não registros consultados.

| Exemplo | Resultado proposto |
|---|---|
| Pedido P1 de C1, vencedor Q1 de V1, serviço S1, agenda A1; todas as referências concordam | Uma contratação `pedido:P1`; replay autorizado recupera Q1/A1 sem escrita |
| Q2 também pertence a P1 e concorre com Q1 | Apenas uma escrita condicional vence; a outra requisição relê e recebe conflito, sem agenda A2 |
| Mesma Q1, resposta do primeiro commit perdida | Resultado recuperado por P1/Q1, não por novo `findOne` de serviço nem nova data |
| P1/A1 cancelados, Q1 permanece aceita | Identidade preservada, `409` recomendado no retry; não reabrir ou criar A2 |
| Legado Q3 aceita, P3 em andamento e nenhuma agenda vinculada | Não prova ausência de agenda real; revisão, sem criar outra por aproximação |
| Legado tem A4/A5 com cliente/prestador/data iguais | Não presumir qual é a contratação de P4; preservar ambos e bloquear associação automática |
| V1 possui S1/S2 da mesma categoria | Conflito na opção mínima até escolha explícita aprovada; nenhum sorteio/primeiro resultado |
| Notificação N1 já lida tem evento de P1 e destinatário V1 | Repetição não cria N2 e não marca N1 como não lida |
| Agenda A6 direta e A7 de proposta disputam o mesmo slot | I1–I5 não bastam; a futura proteção compartilhada de reserva deve impedir a segunda ocupação |

## 9. Plano incremental proposto

Cada linha é uma futura tarefa sujeita a autorização; mudanças preparatórias não ativam o writer novo. Não se exige migrar toda a base para demonstrar a jornada com dados fictícios coerentes.

| Etapa / benefício | Arquivos envolvidos | Dependências e testes | Critério de aceite | Risco e o que permanece inalterado |
|---|---|---|---|---|
| P1 — aprovar desenho e contratos | Este documento e, depois, política/pendências | Decisões da seção 10 | Identidade, legado, replay e serviço inequívocos aprovados | Baixo; nenhum schema/banco/contrato muda |
| P2 — preparar campos opcionais e leitura compatível | Models Pedido, Proposta, Agendamento, Notificacao; testes de compatibilidade novos | P1; fixtures antigas sem campos e novas válidas/inválidas; serialização/populate; teste de não inclusão de defaults | Legados continuam legíveis; conjunto parcial não é tratado como contrato; metadados não vazam por acidente | Médio; nenhuma ativação de novas escritas, índice operacional, enum ou URL alterados |
| P3 — ensaiar transações e índices | Novo helper de replica set descartável e testes de contratação/índices | P1/P2; concorrência, aborto, ausência/nulo/tipo errado, colisões I1–I5, limpeza | Evidência real de escopo da sessão, unicidade e isolamento; nada ignorado | Médio; preservar helper standalone, integrações auth/chat, dados persistentes e dependências |
| P4 — preparar implantação e legados | Especificação operacional/índices; eventual ferramenta de auditoria em tarefa própria | P3; ensaio de versões mistas, rollback e fixtures ambíguas | Índices disponíveis e escritores antigos bloqueados antes de ativar; legado não certificado não entra como novo | Alto operacional; criação real e qualquer migração exigem autorizações separadas; não apagar dados |
| P5 — escrita vinculada e replay como caso de uso coeso | propostaService/controller, criação de Pedido, Models preparados, helper de notificação específico; testes HTTP e integração | P2–P4; ajustar expectativa de retry `409` apenas após D02 aprovada; falhas/concurrency/reload | Uma vencedora, agenda e evento; mesmo resultado recuperável; falha não deixa parcial; permissões preservadas | Alto; manter rotas/JWT/contas/chat, termos acordados e escopo dos demais eventos; não ativar metade da transação |
| P6 — coordenação de ciclo de vida e reserva | Services/controllers de pedidos/agendamentos/serviços; índices de slot aprovados; testes reais | P5 e decisões D05/D06; cancelamento versus aceitação, exclusão de serviço, direta versus proposta, reocupação de slot | Todos os escritores respeitam vínculos; nenhuma segunda reserva ativa; transições aprovadas coerentes | Alto; separar mudanças de contrato de índices/migrações; nenhum backfill por semelhança |
| P7 — ajustar interface e demonstrar jornada | Dashboards cliente/prestador, profissionais/faxina se necessário; testes de interface | P5/P6; resposta perdida, retry, conflito, cancelamento, finalização e outra conta | Mensagens não prometem nova criação em replay; histórico legível e ações coerentes | Médio; URLs, navegação, autenticação, portfólio e chat inalterados |

Agrupar P2 com testes fictícios de compatibilidade; agrupar escrita e replay de P5 numa entrega coesa, dividida em commits revisáveis futuros se necessário. P3 pode ensaiar índices e transação no mesmo ambiente descartável. Manter decisões/contratos, criação operacional de índices, reconciliação histórica e reserva de horário em mudanças separadas. P6 não deve ser omitida se a demonstração alegar proteção de disponibilidade/cancelamento; P5 sozinha demonstra identidade e consistência da aceitação, não resolve toda a contratação.

Reaproveitar [httpApp.js](../tests/helpers/httpApp.js), testes de autorização e cenários existentes. Alterar expectativas defeituosas somente na correção correspondente, mantendo rastreabilidade por commit. A referência é a suíte de 809 testes informada, não um resultado produzido nesta fase. Novos testes devem acrescentar garantias de persistência, sem duplicar todos os testes de montagem de Router.

## 10. Decisões abertas e critério de aprovação

| Decisão | Recomendação mínima | Alternativa / custo |
|---|---|---|
| Identidade e cardinalidade | A, uma contratação vitalícia por Pedido, sem nova coleção | B ou recontratação no mesmo pedido ampliam modelo e ciclo de vida |
| Replay (D02/D10) | `200` para vínculo completo coerente em andamento/finalizado; `409` cancelado | `200` histórico cancelado exige mensagem inequívoca; manter sempre `409` não recupera resultado perdido |
| Legados (D09) | Leitura preservada; primeira aceitação somente com protocolo novo ou certificação explícita | Liberar pedidos antigos com heurísticas reduz bloqueios, mas não comprova ausência de contratação anterior; não recomendado |
| Serviço (D04) | Vincular único correspondente na aceitação e rejeitar ambiguidade | Escolha na proposta muda formulário/API; seleção automática exige regra aprovada |
| Atomicidade/evento (D07/D08) | Transação, notificação no mesmo commit, índices verificados | Recuperação durável/outbox exigem protocolo e operação adicional |
| Termos e catálogo | Preservar valor/prazo da proposta e referências; definir bloqueio/coordenação de exclusão | Snapshot ou arquivamento do serviço ampliam schema; referência sozinha não preserva apresentação de item apagado |
| Agenda/transições (D05/D06) | Slot normalizado comum e transições coordenadas em tarefa própria | Duração/sobreposição, reagendamento e cancelamento de confirmado exigem regras adicionais |
| Respostas novas | Preservar envelope; aprovar mensagens de replay/legado/ambiguidade e erro transitório | Códigos adicionais/novo endpoint somente se necessários à interface e aprovados |

**Pronto para implementação somente após** aprovação da alternativa, dos campos/protocolos, dos impactos sobre legados e das decisões de contrato aplicáveis; definição do ensaio descartável e do plano operacional sem acesso implícito a bancos existentes. Nenhum índice único parcial, transação ou garantia descrita está disponível apenas pela existência deste documento. Não há autorização para editar produção, alterar contas ou executar migrações.
