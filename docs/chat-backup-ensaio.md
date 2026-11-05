# Ensaio fictício de backup e restauração do chat

Este procedimento é exclusivamente local e descartável. Não autoriza conexão, backup, restauração, criação de índice ou migração no Atlas. Não lê `.env`, não inicia a aplicação e não recebe credenciais, URI, banco ou arquivo externo. Os usuários da fixture são documentos de exemplo da aplicação, não contas de autenticação do MongoDB.

## Executar o ensaio

Na raiz do repositório:

```powershell
npm.cmd run test:chat-backup
```

Alternativa equivalente:

```powershell
node scripts/rehearseChatBackup.js
```

Pré-condições: dependências do projeto instaladas e executáveis `mongod`, `mongodump` e `mongorestore` acessíveis. As ferramentas de backup são procuradas no PATH e, no Windows, em `C:\Program Files\MongoDB\Tools\100\bin`. O helper existente procura o servidor no PATH, em `MONGOD_BINARY` ou na instalação Windows padrão do MongoDB 8.0. O ensaio verifica as versões antes de iniciar o banco. Se uma ferramenta de backup estiver indisponível, informa somente `MONGODUMP_UNAVAILABLE` ou `MONGORESTORE_UNAVAILABLE` e encerra, sem procurar outro banco.

O comando não faz parte da suíte normal `npm test`. Não aceita argumentos adicionais. Cada execução cria uma instância própria ligada a `127.0.0.1`, em porta efêmera diferente de 27017, com diretório temporário próprio. Confere o PID retornado pelo servidor contra o processo criado antes de inserir dados e novamente antes de restaurar. Não reutiliza serviços instalados ou bancos existentes.

Os nomes de origem e destino têm prefixos fictícios diferentes e sufixo aleatório. O programa confirma que ambos estão ausentes antes da preparação e que o destino continua ausente antes da restauração. Não usa `--drop`, `dropDatabase`, `--oplog`, `--oplogReplay` ou importação de usuários/papéis administrativos. As criações de coleções, documentos e índices acontecem apenas na instância pertencente ao ensaio.

## Comandos executados internamente

Os exemplos abaixo documentam a forma dos comandos. Os marcadores são gerados internamente pelo programa; não são instruções para apontar as ferramentas a outro servidor ou reaproveitar nomes existentes.

```text
mongodump --host 127.0.0.1 --port <porta-efemera> --db <origem-ficticia> --archive=<arquivo-temporario> --gzip

mongorestore --host 127.0.0.1 --port <mesma-porta-efemera> --archive=<arquivo-temporario> --gzip --nsInclude=<origem-ficticia>.* --nsFrom=<origem-ficticia>.* --nsTo=<destino-ficticio>.* --stopOnError --objcheck
```

Os argumentos são passados diretamente aos executáveis, sem shell. Cada operação tem timeout local de 30 segundos; esse valor é uma condição de interrupção deste ensaio pequeno, não uma expectativa de desempenho para outros bancos. Saídas e erros das ferramentas não são retransmitidos, pois podem conter namespaces e detalhes de documentos. O relatório inclui somente contagens, versões, tempos e resultados booleanos. Não imprime nomes, IDs, conteúdo, arquivo, PID, porta ou string de conexão.

## Verificações

- Fixture conhecida: três usuários, três conversas entre pares distintos e sete mensagens embutidas em `chats.messages`; não há coleção separada de mensagens no modelo atual.
- Inclui mensagens nas duas direções, três mensagens lidas com datas, uma conversa inativa e uma conversa histórica sem `pairKey` (a mesma conversa neste conjunto).
- Confirma contagens exatas nas duas bases e a presença das mesmas duas coleções, sem coleções extras.
- Compara todos os documentos BSON, ordenados por `_id`, preservando conteúdo, IDs, tipos BSON, datas, flags e ordem das mensagens. Nenhum documento é impresso.
- Valida dois participantes distintos, referências a usuários existentes, mensagens pertencentes ao par e chaves canônicas corretas onde presentes. Confirma ausência de pares duplicados na fixture.
- Compara as definições completas dos índices e as opções de coleção, inclusive um validador fictício. Confere o índice `chat_pair_key_unique`, único em `{pairKey: 1}`, com filtro parcial `{pairKey: {$type: 'string'}}`, além dos outros índices da fixture.
- Reconfere que a origem não mudou durante o dump e após a restauração. Calcula SHA-256 do arquivo antes e depois da restauração, sem imprimir o hash, para verificar que ele não mudou.
- Exige sucesso dos dois executáveis. Um arquivo de backup não vazio ou código zero, isoladamente, não conta como restauração comprovada.
- Ao terminar, tenta encerrar o processo próprio e remover seu diretório pelo helper, além de remover o diretório do arquivo de backup, inclusive em falhas tratadas. As duas limpezas são tentadas independentemente. Falha de limpeza é reportada e causa saída 1. Sucesso exige saída 0 e `recursos_temporarios_limpos: true`.

## Resultado local registrado

Execução em 1 de novembro de 2026, Windows x64, MongoDB Server **8.0.34**, `mongodump` e `mongorestore` **100.20.0**:

| Verificação | Resultado |
|---|---|
| Backup comprimido | Concluído; 1.070 bytes; 128 ms |
| Restauração em banco novo | Concluída; 346 ms |
| Usuários / conversas / mensagens | 3 / 3 / 7 nas duas bases |
| Mensagens lidas / inativas / sem chave | 3 / 1 / 1, preservadas |
| Índices de chats / usuários, incluindo `_id_` | 5 / 2, idênticos |
| BSON dos documentos e opções das coleções | Idênticos |
| Integridade dos pares e referências | Validada |
| Origem e arquivo de backup | Inalterados |
| Recursos temporários | Removidos; processo próprio encerrado |

Tempos e tamanho são observações desta fixture, não estimativas para produção. O JSON impresso pelo programa registra o resultado de cada nova execução; o backup é removido e não é guardado no repositório.

O ensaio completo foi executado duas vezes com sucesso e limpeza concluída; a tabela registra a segunda execução. A recusa de argumento externo também foi exercitada: saída 1, `BACKUP_ARGUMENTS_FORBIDDEN`, antes da criação da instância. Após a proteção adicional da porta no helper, a suíte normal foi executada novamente: **405 testes aprovados, zero falhas e zero ignorados**, incluindo as integrações locais descartáveis. O ensaio de backup permanece separado dessa contagem.

## Limitações e pré-condições para qualquer etapa futura

Este teste cobre um único servidor local sem autenticação, sem concorrência e com dados muito pequenos, conhecidos e totalmente fictícios. Não testa TLS, permissões de backup/restauração, usuários/papéis administrativos, rede, réplica/failover, limites de armazenamento, custo, retenção, criptografia do arquivo, UUIDs das coleções ou restauração do ambiente completo da aplicação. Restaurar documentos de usuários não prova login funcional. A igualdade de índices verifica metadados; não exercita cada restrição com tentativas de escrita inválida.

Não há garantia de consistência entre coleções se escritores estiverem ativos. Neste ensaio não existem outros clientes e nenhuma escrita ocorre durante o backup. Para dados existentes, seriam necessários autorização específica, inventário e compatibilidade do ambiente, pausa/drenagem dos escritores ou mecanismo consistente aprovado, proteção e retenção do backup e restauração em destino isolado novo. Não se deve restaurar sobre produção para testar um backup.

O resultado não valida um ambiente MongoDB Atlas de produção, nenhum backup real, a disponibilidade de snapshots em um plano gratuito ou uma migração futura. Também não resolve duplicidades históricas. O ensaio não executa a auditoria pesada nem altera seus limites: a falha de memória observada com 1.200 conversas e 131.200 mensagens continua relevante. Uma primeira análise de dados existentes deve ser planejada separadamente em cópia protegida e autorizada.

Encerramento abrupto do sistema ou término forçado do Node pode impedir o bloco de limpeza. Nesse caso, recursos remanescentes devem ser identificados e revisados pelo responsável antes de qualquer remoção; nunca encerrar serviços MongoDB ou apagar diretórios por aproximação. O relatório de falha não deve ser interpretado como dados preservados ou limpeza concluída.
