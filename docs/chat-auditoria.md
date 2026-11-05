# Auditoria de integridade de chats — somente leitura

## Estado e limites desta entrega

A ferramenta é um inventário para revisão; não corrige dados e não autoriza implantação. Analisa a coleção `chats` inteira, incluindo documentos inativos, e consulta somente os `_id` da coleção `usuarios` para verificar referências.

A CLI desta versão aceita exclusivamente URI explícita `mongodb://127.0.0.1:PORTA` sem autenticação, parâmetros, lista de hosts ou SRV, junto de um banco chamado `iservice_chat_audit_NOME`. Não lê `.env`, `MONGO_URI` nem qualquer credencial. Host remoto, Atlas, credenciais na URI e opções desconhecidas são recusados antes de abrir uma conexão. Não há opção de aplicar correções ou habilitar produção.

**Endereço local e nome de banco não são prova de que os dados são descartáveis. Não usar túnel, proxy ou encaminhamento de porta para produção.** Confirmar que o processo e seu diretório pertencem à fixture local. A CLI sem autenticação destina-se somente a esse processo isolado; não remover autenticação de um banco existente para executá-la.

O módulo `scripts/lib/chatAudit.js` recebe uma conexão já estabelecida e também foi testado com autenticação e papel de leitura. Essa API interna não deve ser utilizada para contornar o bloqueio da CLI. Uma futura versão com destino remoto e credenciais exige nova revisão e autorização específica.

## Execução local futura

Requisitos: dependências do projeto instaladas e MongoDB local descartável 8.0 (validado com 8.0.34). Os pipelines usam `$setWindowFields` e não são destinados a versões antigas sem revisão. Os testes criam seus próprios processos e dados, sem depender de um banco local já aberto.

Para verificar ajuda, sem conectar:

```powershell
node scripts/auditChats.js --help
```

Para um processo descartável previamente criado e identificado pelo operador, com ambas as coleções existentes:

```powershell
# Exemplo exclusivamente local. Substituir PORTA pela porta da fixture.
node scripts/auditChats.js --local-disposable --uri mongodb://127.0.0.1:PORTA --database iservice_chat_audit_fixture
```

Alternativa: `npm.cmd run audit:chat -- --local-disposable --uri mongodb://127.0.0.1:PORTA --database iservice_chat_audit_fixture`.

A CLI não cria o banco nem as coleções. Ausência de `chats` ou `usuarios` é erro, não um relatório de integridade limpo. Coleções existentes e vazias são válidas. O tempo máximo de execução da agregação é 30 segundos, configurável por `--max-time-ms` entre 1000 e 300000. A conexão tem timeout de seleção de servidor de 5 segundos. Não há paginação parcial nem relatório parcial aprovado em caso de erro.

Códigos de saída:

- `0`: auditoria concluída sem achados no conjunto de regras.
- `1`: auditoria concluída com achados, inclusive chave ausente em legado.
- `2`: uso inválido, destino recusado, coleção ausente, limite excedido, erro de leitura ou outro erro operacional. O stderr contém somente um código sanitizado e `relatorio_completo: false`.

O stdout contém exclusivamente o JSON resumido. Não há gravação de arquivo pela ferramenta. Uma eventual captura do relatório deve ser feita pelo operador em destino aprovado; mesmo contagens agregadas merecem controle de acesso.

## O que é contado

O relatório possui `versao`, `somente_leitura`, `consistencia`, `conversas`, `mensagens`, `referencias` e `pares`. Não inclui IDs, chaves canônicas, nomes, e-mails, telefone, conteúdo de mensagens, URI ou nomes de banco escolhidos pelo operador.

### Conversas

- `total`, `com_achados` e `inativas`.
- `participantes_formato_invalido`: campo ausente ou que não é array.
- `participantes_quantidade_invalida`: comprimento diferente de dois; não array é tratado como zero posições para essa contagem.
- `participantes_id_invalido`: pelo menos uma posição não é ObjectId nem string hexadecimal exata de 24 caracteres.
- `participantes_tipo_bson_incorreto`: pelo menos uma posição não tem tipo BSON ObjectId. Strings hexadecimais válidas entram nesta categoria, sem serem silenciosamente corrigidas.
- `participantes_repetidos`: IDs reconhecíveis repetidos após normalização, em qualquer comprimento de array. Valores inválidos repetidos não são interpretados como a mesma pessoa.
- `participantes_usuario_ausente`: pelo menos uma referência reconhecível sem usuário ObjectId correspondente. `referencias.participantes_ausentes` conta as posições ausentes, incluindo repetições.
- `pair_key_ausente`: campo inexistente. `null`, array e número são inválidos, não ausentes.
- `pair_key_invalida`: não string, formato diferente de dois hexadecimais minúsculos com `:`, comprimento diferente de 49 ou IDs que não estão em ordem crescente estrita.
- `pair_key_divergente`: existe string armazenada e o par é calculável, mas a chave difere da canônica; pode coincidir com `pair_key_invalida`.
- `pair_key_nao_verificavel`: há chave armazenada, mas não é possível calcular um par de dois participantes válidos e distintos.
- `historico_formato_invalido`: `messages` inexistente ou não array.
- `historico_inconsistente`: histórico não array ou pelo menos uma mensagem inconsistente/não verificável.
- `par_duplicado`: documento pertencente a grupo de dois ou mais chats com o mesmo par recalculado.
- `chave_armazenada_repetida`: documento com string `pairKey` repetida, mesmo quando os participantes são diferentes ou a string é malformada.

### Pares e chaves repetidas

O par é calculado sem confiar no `pairKey` persistido, sem filtrar `isActive` e sem preencher dados. Strings hexadecimais são normalizadas somente em expressões de análise para reconhecer duplicidades com ObjectIds; seu tipo BSON incorreto continua sendo apontado. O par é calculável somente para exatamente dois IDs reconhecíveis e distintos. Uma conversa com três participantes não é arbitrariamente atribuída a nenhum de seus subconjuntos.

`pares.grupos_duplicados` conta grupos com mais de uma conversa; `conversas_excedentes` soma `quantidade - 1` em cada grupo, sem sugerir qual documento escolher ou remover. `grupos_chaves_repetidas` e `chaves_excedentes` fazem o equivalente para strings armazenadas. Campos de chave não string são apontados separadamente como inválidos; o relatório não pretende reproduzir todos os conflitos multikey de um índice sobre dados malformados.

### Mensagens

`total` considera os elementos dos arrays `messages`; históricos de tipo incorreto não são convertidos em mensagens. `inconsistentes` conta cada mensagem com pelo menos um dos seguintes achados:

- `estrutura_invalida`: elemento não é um documento BSON.
- `id_invalido`: remetente ou destinatário não reconhecível.
- `tipo_bson_incorreto`: remetente/destinatário não armazenado como ObjectId.
- `remetente_igual_destinatario`.
- `fora_dos_participantes`: referência reconhecível fora de um par calculável.
- `usuario_ausente`: remetente/destinatário reconhecível sem usuário correspondente, inclusive referências externas ao par.
- `conteudo_invalido`: conteúdo não string ou vazio depois de remover os mesmos espaços de `String.trim()`.
- `par_nao_verificavel`: participantes do chat não permitem verificar o par. Isso não afirma que o conteúdo está errado; afirma que sua vinculação não pode ser certificada.

Os campos são sobrepostos: somar todas as categorias não produz o total de documentos. A auditoria não valida neste momento datas, metadados de leitura, anexos, identidade humana, autoria histórica, se o par foi escolhido corretamente no passado ou unicidade do índice real. Não certifica sozinha a implantação.

## Garantias de leitura e privacidade

- Usa o driver nativo disponibilizado pela dependência existente `mongoose`, sem instanciar modelos, executar hooks, popular referências ou carregar `server.js`/`config/database.js`.
- Os únicos acessos da auditoria são `listCollections` e uma agregação fixa de leitura, com eventuais comandos de cursor do driver. Não há updates, exclusões, inserts, criação de coleção/índice, migração, `$out` ou `$merge`.
- Tipos BSON e conteúdo são examinados dentro do MongoDB. O conteúdo é reduzido a um booleano ainda no pipeline; dados de usuários são limitados a `_id` no lookup. O resultado enviado ao cliente contém somente contagens.
- A collation da análise é `simple`, independente de padrões da coleção. Não há coerção/escrita de dados históricos.
- `allowDiskUse: false` desabilita spill do pipeline; se os limites de memória/tempo forem atingidos, a ferramenta falha. Não aumentar limites ou habilitar spill automaticamente.
- Erros do driver não são impressos nem encadeados na saída. Um timeout ou falha não produz relatório parcial.
- `consistencia: sem_snapshot` é deliberado: a leitura usa majority, mas não constitui snapshot transacional. Com escritores ativos, resultados podem refletir mudanças durante a execução. Não usar esse levantamento como inventário final de migração sem uma janela consistente e procedimento revisado.
- “Somente leitura” refere-se às operações sobre dados/índices da aplicação; não implica ausência de I/O, logs operacionais, sessões ou atividade interna normal do servidor.

## Testes com banco descartável

Executar:

```powershell
node --test tests/chat-auditoria.test.js tests/chat-auditoria.integration.test.js
```

O helper procura `mongod` no PATH, em `MONGOD_BINARY` (caminho somente do executável) ou na instalação Windows padrão `C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe`. A integração da auditoria falha explicitamente se não houver binário, em vez de reportar aprovação sem banco.

Os processos são ligados apenas a `127.0.0.1`, com portas e diretórios temporários próprios. Uma fixture inclui autorização real do MongoDB, administrador fictício para preparar dados e leitor com papel `read`. Somente as fixtures criam dados, coleções e usuários; a auditoria não o faz. São verificados:

- Categorias acima com dados fictícios, ativos, inativos e legados.
- Comparação BSON integral de documentos e definições dos índices antes/depois.
- Monitoração dos comandos emitidos pela conexão de auditoria, recusando comandos de escrita.
- Execução sob usuário com leitura, sem permissão de inserir documentos ou criar índices.
- Saída sem marcadores privados, IDs, chaves ou dados pessoais; erros sanitizados.
- CLI real com códigos 0/1/2, bloqueio de destinos remotos e inexistência de coleções.

Ao terminar, o helper encerra o processo e remove exclusivamente o diretório temporário que criou. Nenhum teste aceita URI externa ou credenciais de produção.

## Revisão e autorização antes de qualquer produção

Esta entrega NÃO autoriza uma auditoria no Atlas. Antes de liberar uma futura execução:

1. Revisar código, dependências, pipeline, comandos permitidos e controles de saída. Definir versão exata da ferramenta e confirmar compatibilidade com MongoDB/topologia de destino.
2. Aprovar separadamente a eventual liberação remota e a forma de injetar credenciais fora do repositório, sem URI em argumentos/logs. Não reutilizar a credencial da aplicação com privilégios de escrita. Não contornar a restrição local por túnel ou chamando o módulo diretamente.
3. Identificar banco/coleções e responsável; obter autorização explícita com escopo somente leitura, janela, limites de carga, condições de interrupção, destino/retenção do relatório e proibição de alterações.
4. Ensaiar em dados fictícios e, se autorizado separadamente, numa cópia protegida. Verificar contagens conhecidas e privacidade da saída. Não publicar relatórios ou snapshots com informações identificáveis.
5. Confirmar conta técnica restrita a leitura das duas coleções e permissões necessárias para listá-las; verificar política de logs/profiler e monitoramento do banco. Ausência de comandos de escrita no código complementa, não substitui, a limitação de privilégio no servidor.
6. Avaliar o impacto de varredura integral, lookups, ordenações e agrupamentos em memória. Não há limite de quantidade de conversas: o levantamento deve ser completo ou falhar. Planejar horário, observabilidade e cancelamento. Não tratar ausência de relatório como ausência de problemas.
7. Confirmar backup/restauração revisados como pré-condição da etapa posterior de migração. A auditoria não migra e não restaura. Repetir a análise em estado consistente antes de qualquer saneamento; nenhum flag transforma o relatório atual em autorização de escrita.
8. Revisar os achados. Duplicidades, referências externas ou pares indeterminados exigem decisão separada que preserve todos os históricos. Não inferir ou corrigir destinatários automaticamente.

A autorização para essa futura auditoria não autoriza criação de índice, saneamento, migração, commit ou deploy. Essas operações continuam com planos e decisões próprios.


## Resultado local registrado

O primeiro conjunto da auditoria adicionou 19 casos, elevando a suíte a 344 aprovações, sem falhas ou ignorados, com MongoDB descartável 8.0.34. Essa contagem é histórica; a etapa de robustez acrescenta os casos abaixo. Não houve consulta a dados reais ou execução no Atlas.

## Validação rigorosa do resultado

O cliente exige exatamente uma linha com as facetas `totals`, `pairs` e `keys`, cada uma com exatamente um registro. Todos os contadores declarados são obrigatórios, próprios do objeto, inteiros seguros não negativos. Não há coerção de string, `null`, campo ausente ou valor inválido para zero; campos inesperados também interrompem a validação. Não são impressos nomes de campos com falha, valores recebidos ou estruturas internas.

Para uma coleção vazia, o próprio pipeline emite explicitamente uma linha completa de zeros. Isso substitui somente a saída vazia conhecida do `$group`, dentro da agregação fixa. Um retorno vazio ou incompleto recebido pelo cliente é erro, mesmo que aparente representar zero documentos.

As verificações cruzadas incluem:

- Achados, categorias e inativos não podem ultrapassar os totais correspondentes; toda categoria de erro deve estar coberta por `com_achados` ou `inconsistentes`.
- Os totais de achados não podem superar a soma das categorias que representam sua união. Categorias sobrepostas continuam permitidas.
- Mensagens inconsistentes exigem histórico inconsistente em um array; histórias de tipo errado não podem contribuir com mensagens contadas.
- Ausência de usuários exige referências ausentes e vice-versa; categorias mutuamente exclusivas da chave respeitam o total de conversas.
- Em cada resumo de duplicidades, `grupos + excedentes` deve coincidir exatamente com os documentos envolvidos. Cada grupo duplicado exige pelo menos um excedente. Pares inválidos não podem entrar nesses grupos.
- Uma coleção sem conversas não pode conter contagens de mensagens, referências ou achados.

Somas de validação usam aritmética inteira `BigInt`, evitando overflow intermediário silencioso. Os contadores públicos permanecem números inteiros seguros. As relações verificadas não reconstituem dados por documento nem substituem snapshot ou revisão histórica.

Falha de estrutura, tipo ou invariantes gera somente `AUDIT_INVALID_RESULT`, sem relatório parcial. Falha de leitura continua gerando `AUDIT_READ_FAILED`. A CLI encerra a conexão e retorna código 2. Os testes incluem remoção de cada contador obrigatório, valores inválidos, campos herdados/inesperados, totais contraditórios, sobreposição válida e erro sanitizado pela CLI.

## Ensaio de volume local separado

Executar explicitamente:

```powershell
npm.cmd run test:chat-volume
```

O arquivo `benchmarks/chat-auditoria-volume.js` não está na descoberta de testes de `npm test`. Não aceita URI, nomes de banco ou argumentos de ambiente de produção. Sempre inicia seu próprio MongoDB temporário pelo helper de fixtures, ligado apenas a `127.0.0.1`, e confere o PID do servidor antes de gerar dados. O encerramento intencional atinge somente esse processo, nunca um serviço MongoDB já existente. A fixture usa inserts para preparar dados fictícios; a auditoria continua usando exclusivamente comandos de leitura.

O ensaio utiliza dois perfis fixos de observação, sem pretensão de representar produção. Inclui chaves ausentes, pares duplicados e inativos, com conteúdo artificial repetitivo. Verifica os totais conhecidos quando a consulta termina. Um erro de memória 292 no perfil ampliado é registrado como limitação observada, com erro público e ausência de resultado; não é contado como aprovação da capacidade de processar esse volume. Outros erros inesperados fazem o ensaio falhar.

As falhas verificadas separadamente são: limite de memória e interrupção pela CLI, além de expiração real com `maxTimeMS: 1` pela API interna. A CLI deve retornar código 2, erro público sanitizado e stdout vazio; a API deve lançar somente `AUDIT_READ_FAILED`, sem resultado. O módulo permite orçamentos de 1 a 300.000 ms, mas a CLI mantém a faixa anterior de 1.000 a 300.000 ms e o padrão de 30.000 ms. Não há failpoints artificiais para simular timeout. Se o conjunto não reproduzir o erro de tempo esperado em outra máquina, o ensaio falha como verificação não exercitada; o resultado não deve ser reinterpretado como garantia de desempenho. O orçamento de 1 ms existe apenas para provocar essa falha local, não como SLA.

Durante a preparação do ensaio, um orçamento de 1.000 ms alternou entre timeout e limite de memória, dependendo de qual erro ocorria primeiro. Por isso a verificação de expiração foi separada com um orçamento menor na API interna, sem aumentar memória, tempo padrão ou permissões da CLI. Isso evita tratar essa disputa como prova de desempenho.

Medições aproximadas:

- Tempo de parede da chamada de auditoria, excluindo a criação da fixture.
- CPU do processo Node; não mede CPU do MongoDB. Inclui custos de monitoração e GC do cliente.
- RSS do Node e RSS residente do MongoDB amostrados a cada aproximadamente 100 ms, usando `serverStatus` apenas na conexão da fixture local. Picos entre amostras podem ser perdidos.
- Cache WiredTiger no início/fim e delta de bytes lidos no cache. Não é um medidor de I/O físico ou carga de produção.

Os campos `_mb` do JSON usam divisão por 1024² (MiB). A memória inclui baseline do servidor, cache, dados recém-inseridos, buffers e estado do cliente; não é memória exclusivamente atribuível à consulta. A preparação deixa o cache aquecido, e o texto repetitivo/compressível não representa a distribuição real dos históricos. Uma execução não fornece percentis, capacidade máxima ou comparação reproduzível entre máquinas.

### Observações em MongoDB 8.0.34, Windows x64

Em uma execução local da etapa de robustez:

| Perfil | Conversas | Mensagens | Sem chave / inativas / grupos duplicados | Resultado | Tempo | Pico RSS Node / MongoDB amostrado |
|---|---:|---:|---|---|---:|---:|
| Pequeno | 300 | 7.920 | 100 / 75 / 60 | Concluído, contagens conferidas | 196,95 ms | 86,37 / 154 MiB |
| Ampliado | 1.200 | 131.200 | 400 / 300 / 240 | Falhou com código 292, sem relatório | 1.171,02 ms | 97,19 / 285 MiB |

O perfil pequeno contém quatro históricos de 500 mensagens, e o ampliado oito históricos de 1.500. Os demais têm, respectivamente, 20 e 100 mensagens por conversa. CPU do Node observada: 78 ms em cada perfil. RSS inicial do MongoDB: 143 e 181 MiB. Cache inicial/final: aproximadamente 1,98 MiB e 31,90 MiB em cada perfil, sem aumento de bytes lidos no cache durante as medições. Nenhuma falha de amostragem foi observada nessa execução.

Na mesma execução, a falha de memória via CLI ocorreu em 1.254,04 ms (erro 292); o orçamento real de 1 ms da API expirou em 6,23 ms de parede, no aggregate (erro 50); a interrupção do processo temporário foi tratada em 123,39 ms. As verificações de CLI terminaram com código 2, e as três verificações apresentaram somente `AUDIT_READ_FAILED`, sem relatório completo ou parcial. Esses tempos são observações locais, não limites garantidos.

**O achado operacional principal é que o perfil ampliado não completou a auditoria com spill desabilitado.** Não se aumentou memória, timeout padrão ou `allowDiskUse` para esconder esse resultado. Também não se otimizou ou redesenhou o pipeline nesta etapa. Antes de usar volumes semelhantes, será necessária avaliação específica em cópia protegida e, se apropriado, revisão do desenho da consulta.

## Verificações que continuam pendentes antes de produção

O bloqueio de destinos remotos da CLI permanece. As melhorias não liberam o Atlas. Continuam necessárias autorização explícita, credencial mínima de leitura, cópia protegida e consistente como primeiro destino de dados existentes, avaliação do plano/custo da consulta, políticas de logs e retenção, cancelamento operacional, backup com restauração ensaiada e revisão separada de qualquer saneamento ou índice. A auditoria continua declarando `sem_snapshot`; uso simultâneo, replicação, failover e rede real não foram certificados por estes testes. Um relatório aprovado também não prova intenção do destinatário ou legitimidade histórica das mensagens.

## Resultado da suíte de robustez

Suíte normal executada em 1 de novembro de 2026 com `npm.cmd test` e MongoDB 8.0.34 descartável: **405 testes aprovados, zero falhas e zero ignorados**. Foram acrescentados 61 casos à base anterior de 344, incluindo validação rigorosa do relatório e separação do limite mínimo de tempo da API/CLI. O ensaio de volume foi executado separadamente, sem integrar essa contagem: perfil pequeno concluído, perfil ampliado com limite de memória observado e verificações de memória, timeout e interrupção sanitizadas. Não houve aumento de capacidade comprovado, execução remota, uso de dados reais, migração, commit ou publicação.
