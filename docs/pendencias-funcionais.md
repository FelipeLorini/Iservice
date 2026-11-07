# Pendências funcionais do iService

Registro da auditoria pós-modularização, baseado no commit `155f99b` da branch
`refactor/arquitetura-mvc`, em 7 de novembro de 2026. A Fase 6A apenas documenta
pendências e extrai a aceitação de propostas para um service; não corrige os itens.

## Classificação e limites da evidência

- **P1:** prioridade para segurança, consistência ou funcionamento da jornada do TCC.
- **P2:** tratar após os bloqueadores da jornada principal.
- **Constatado:** comportamento visível no código ou reproduzido com dependências
  simuladas; não significa incidente comprovado em produção.
- **Risco potencial:** mecanismo que pode causar falha, ainda sem ensaio de
  persistência/concorrência real que comprove sua manifestação.
- **Hipótese:** manifestação que exige inspeção ou teste adicional.

Os testes HTTP usam aplicação, Routers, middlewares e controllers reais, com
dependências explicitamente simuladas. A integração real já existente do chat não
comprova atomicidade, hashing ou índices dos demais domínios. Nenhum item deste
documento autoriza acesso ao Atlas, alteração de dados existentes ou mudanças em índices.

## FUNC-001 — Aceitação em estados inadequados

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado.
- **Arquivos:** `controllers/propostaController.js`, `services/propostaService.js`,
  `tests/propostas-rotas.test.js`.
- **Evidência e impacto:** a aceitação verifica propriedade, mas não o estado anterior
  do pedido/proposta. Uma proposta recusada ligada a pedido cancelado pode ser aceita,
  recolocando o pedido em andamento.
- **Testes existentes:** `aceitacao nao valida status anterior e repeticao pode criar dois agendamentos`.
- **Testes necessários:** matriz de estados elegíveis e não elegíveis, com persistência real.
- **Estratégia proposta:** aprovar a política de estados e aplicá-la na operação de domínio,
  incluindo condição de estado na escrita para evitar decisão baseada em leitura antiga.
- **Critério de aceite:** todos os estados proibidos pela política são rejeitados sem
  alterar pedido, propostas, agendamentos ou notificações; estados permitidos funcionam.

## FUNC-002 — Aceitação repetida e duplicação de efeitos

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado na repetição simulada;
  concorrência real é risco potencial.
- **Arquivos:** `services/propostaService.js`, `controllers/propostaController.js`,
  `Models/agendamentoModel.js`, `tests/propostas-rotas.test.js`.
- **Evidência e impacto:** a repetição da aceitação executa novamente criação de
  agendamento e notificação; não existe vínculo de idempotência nessa operação.
- **Testes existentes:** teste de repetição de aceitação com dois agendamentos/notificações simulados.
- **Testes necessários:** repetição sequencial e aceitação concorrente, inclusive propostas
  diferentes do mesmo pedido, em MongoDB descartável.
- **Estratégia proposta:** definir a identidade da contratação e a política de repetição;
  projetar uma garantia persistente e respostas coerentes antes de alterar schema/índice.
- **Critério de aceite:** repetição e concorrência não produzem múltiplas contratações
  efetivas nem notificações duplicadas para a mesma aceitação, conforme política aprovada.

## FUNC-003 — Escritas parciais em falhas intermediárias

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado na sequência do código
  e nas falhas simuladas; manifestação real ainda precisa de ensaio.
- **Arquivos:** `services/propostaService.js`, `controllers/propostaController.js`,
  `tests/propostas-rotas.test.js`.
- **Evidência e impacto:** a ordem atual é leitura/populate e autorização, `proposta.save`,
  `pedido.save`, `Proposta.updateMany`, `Servico.findOne`, `Agendamento.create` condicional
  e notificação. Não há rollback: uma falha posterior pode deixar a proposta aceita,
  o pedido em andamento ou as demais propostas recusadas, mesmo retornando `500`.
- **Testes existentes:** sequência completa de aceitação e sete falhas intermediárias
  com verificação dos efeitos anteriores (`aceitacao falha em ...`).
- **Testes necessários:** falhas reais e interrupções entre operações, recuperação e
  concorrência em topologia descartável compatível com a solução escolhida.
- **Estratégia proposta:** decidir a unidade de consistência e projetar atomicidade ou
  recuperação explícita; separar a garantia de notificação da consistência da contratação.
- **Critério de aceite:** cada falha deixa estado consistente ou recuperável segundo
  protocolo testado, sem aceitação incompleta invisível ao usuário.

## FUNC-004 — Possíveis conflitos de horário

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** risco potencial de concorrência;
  ausência de consulta na aceitação/reabertura constatada no código.
- **Arquivos:** `controllers/agendamentoController.js`, `services/propostaService.js`,
  `Models/agendamentoModel.js`, `tests/agendamentos-rotas.test.js`.
- **Evidência e impacto:** o agendamento direto consulta pendentes/confirmados do mesmo
  prestador, data e hora antes de criar. Consulta e criação são separadas. A aceitação
  usa hora fixa `09:00` sem essa consulta, e atualizar status não revalida disponibilidade.
- **Testes existentes:** bloqueio sequencial por horário, exceções do filtro e concorrência
  simulada; não constituem prova de reserva atômica em MongoDB real.
- **Testes necessários:** dois clientes concorrentes e conflito entre contratação direta,
  aceitação e reabertura; casting de datas e convenção de fuso/horário.
- **Estratégia proposta:** definir o que constitui conflito e centralizar a regra de
  disponibilidade com garantia concorrente compartilhada pelos caminhos de contratação.
- **Critério de aceite:** nenhuma combinação concorrente cria reservas incompatíveis
  com a política aprovada; horários distintos e liberações válidas continuam funcionando.

## FUNC-005 — Transições e cancelamentos inadequados

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado.
- **Arquivos:** `controllers/agendamentoController.js`, `controllers/pedidoController.js`,
  `tests/agendamentos-rotas.test.js`, `tests/pedidos-rotas.test.js`.
- **Evidência e impacto:** o prestador atribui o status recebido sem validar transição.
  Cancelamento do próprio pedido/agendamento não restringe o estado anterior, inclusive
  finalizado ou em andamento. O enum do schema não valida a transição entre estados.
- **Testes existentes:** reabertura de finalizado e cancelamento em todos os estados atuais.
- **Testes necessários:** tabela de transições por papel, concorrência e efeitos sobre avaliações/histórico.
- **Estratégia proposta:** aprovar tabela de estados/transições e validar a atualização
  no backend, preservando propriedade e histórico legítimo.
- **Critério de aceite:** transições proibidas não alteram dados; transições permitidas
  funcionam somente para o papel e proprietário autorizados.

## FUNC-006 — Sucesso com agendamento ausente

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado.
- **Arquivos:** `services/propostaService.js`, `controllers/propostaController.js`,
  `site-iservice-main/dashboard-cliente.html`, `tests/propostas-rotas.test.js`.
- **Evidência e impacto:** sem serviço da categoria/prestador, aceitação retorna `200`
  com `agendamento: null`, mas a interface anuncia que o agendamento foi criado.
- **Testes existentes:** `aceitacao sem servico correspondente retorna agendamento null e ainda altera e notifica`.
- **Testes necessários:** interface recebendo `null` e cenários reais com serviço removido/ausente.
- **Estratégia proposta:** decidir se agendamento é obrigatório e alinhar precondições,
  contrato HTTP e mensagem da interface, em mudança funcional própria.
- **Critério de aceite:** a interface só anuncia agendamento criado quando ele existe;
  ausência de serviço segue regra explícita e não deixa contratação ambígua.

## FUNC-007 — Contratação anuncia sucesso apenas local

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado no código.
- **Arquivos:** `site-iservice-main/contratar.html`, `site-iservice-main/script.js`,
  `site-iservice-main/index.html`, páginas estáticas de categorias.
- **Evidência e impacto:** `contratar.html` grava `contratacoes` e o formulário da
  landing page grava `agendamentos` no localStorage, sem POST de contratação.
  Várias categorias exibem profissionais/preços estáticos e levam a esse caminho.
- **Testes existentes:** navegação e preservação dos handlers da landing page; não
  comprovam contratação persistida. `profissionais.html` e `faxina.html` já usam a API.
- **Testes necessários:** submissão pelo caminho inicial, consulta em sessão de prestador
  e nova sessão do cliente, além de falha HTTP/rede sem mensagem de sucesso.
- **Estratégia proposta:** unificar o caminho com a contratação real e identificar
  explicitamente qualquer conteúdo que permaneça demonstrativo.
- **Critério de aceite:** toda ação anunciada como contratação efetiva produz registro
  autorizado consultável na API; dados apenas locais não são apresentados como envio real.

## FUNC-008 — Edição de perfil baseada no navegador

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado no código.
- **Arquivos:** `site-iservice-main/perfil_cliente.html`,
  `site-iservice-main/perfil_prestador.html`, `controllers/usuarioController.js`, `Models/usuarioModel.js`.
- **Evidência e impacto:** edição principal de cliente altera `usuario` local; edição
  principal de prestador altera `perfilPrestador`. Isso não atualiza a conta no banco.
  O portfólio é uma funcionalidade distinta já conectada ao PUT da API.
- **Testes existentes:** navegação/autorização de páginas e testes HTTP do portfólio;
  não há jornada real da edição principal.
- **Testes necessários:** salvar, relogar, consultar em outro navegador e tentar editar outra conta.
- **Estratégia proposta:** definir campos suportados e atualização autenticada da própria
  conta, sem alterar credenciais ou campos de papel por edição comum de perfil.
- **Critério de aceite:** campos anunciados como salvos persistem após novo login e
  permanecem isolados por conta; campos não suportados são identificados claramente.

## FUNC-009 — Possível mistura de perfis locais entre contas

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** hipótese de manifestação entre contas;
  chave global e sua leitura sem associação à identidade constatadas no código.
- **Arquivos:** `site-iservice-main/perfil_prestador.html`, `site-iservice-main/app.js`.
- **Evidência e impacto:** `perfilPrestador` é uma chave única do navegador. O logout
  remove token/usuário, mas não esse perfil. Uma segunda conta pode receber apresentação
  baseada nos dados locais anteriores. Não há comprovação de acesso cruzado ao banco.
- **Testes existentes:** troca de sessão em navegação, favoritos e conversas; não esse perfil local.
- **Testes necessários:** editar com prestador A, sair e entrar como B no mesmo navegador,
  incluindo recarga, duas abas e histórico.
- **Estratégia proposta:** preferir dados persistidos por usuário e definir tratamento
  explícito dos dados locais legados, sem migrá-los automaticamente para outra conta.
- **Critério de aceite:** a sessão B não exibe nem grava dados de perfil de A em nenhuma
  das trocas de conta testadas.

## FUNC-010 — Falta de integração real de hashing/autenticação

- **Prioridade:** P1. **Estado:** pendente. **Evidência:** constatado como lacuna de teste,
  não como falha comprovada de armazenamento de senhas.
- **Arquivos:** `Models/usuarioModel.js`, `controllers/CadastroController.js`,
  `controllers/LoginController.js`, `tests/auth-rotas.test.js`, `tests/api-seguranca.test.js`.
- **Evidência e impacto:** o hook bcrypt existe, mas os testes HTTP simulam create,
  save e compararSenha. A integração do chat insere usuários pelo driver, sem testar login.
- **Testes existentes:** contratos de cadastro/login, assinatura JWT real com chave fictícia
  e comparação de senha simulada.
- **Testes necessários:** cadastro real, hash diferente do texto, senha correta/incorreta,
  save sem troca de senha, troca de senha e login após recarga do documento.
- **Estratégia proposta:** usar contas fictícias em instância MongoDB local descartável
  com Models reais; não reprocessar hashes nem recriar usuários existentes.
- **Critério de aceite:** hashing/comparação e preservação do hash sem mudança de senha
  são comprovados por testes reais, sem exposição de credenciais.

## FUNC-011 — Validações e conflitos conhecidos retornam 500

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** constatado nos caminhos de erro
  e testes simulados; cenários reais de validação/concorrência ainda precisam de ensaio.
- **Arquivos:** `controllers/CadastroController.js`, `controllers/ServicoController.js`,
  `controllers/pedidoController.js`, `controllers/propostaController.js`, `controllers/agendamentoController.js`.
- **Evidência e impacto:** erros de validação delegados ao Model chegam ao catch genérico;
  conflito `11000` de proposta também retorna `500`. Isso confunde entrada/conflito com falha interna.
- **Testes existentes:** falhas de criação e `erro de indice unico na criacao de proposta conserva 500 atual`.
- **Testes necessários:** ValidationError, CastError e conflitos de unicidade reais,
  inclusive cadastro/proposta concorrentes, em ambiente descartável.
- **Estratégia proposta:** aprovar contratos e mapear erros conhecidos sem alterar
  incidentalmente mensagens ou status durante refatoração estrutural.
- **Critério de aceite:** entradas inválidas e conflitos conhecidos recebem respostas
  aprovadas e distintas de erro interno, sem gravação indevida ou detalhes privados.

## FUNC-012 — Exposição de mensagens internas de erro

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** constatado no código.
- **Arquivos:** controllers de propostas, pedidos, agendamentos, serviços protegidos,
  notificações, FAQ, média de avaliações e atualização de portfólio.
- **Evidência e impacto:** diversos catches devolvem `erro: error.message`, que pode
  revelar detalhes do Model/driver. Não há alegação de incidente com dados reais.
- **Testes existentes:** contratos de erro HTTP; cadastro/login e algumas consultas
  já possuem testes de sanitização e não devem regredir.
- **Testes necessários:** erros sintéticos com marcadores internos em cada domínio afetado.
- **Estratégia proposta:** separar resposta pública de diagnóstico interno, com logs
  controlados e sem segredos, em alteração explícita dos contratos afetados.
- **Critério de aceite:** respostas e logs públicos não incluem os marcadores internos,
  URI, credenciais ou stack; diagnóstico operacional continua disponível de forma segura.

## FUNC-013 — Tratamento inconsistente de IDs inválidos

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** constatado.
- **Arquivos:** `controllers/avaliacaoController.js`, demais controllers com consultas
  diretas por ID e testes HTTP dos respectivos domínios.
- **Evidência e impacto:** listagem pública de avaliações rejeita ID inválido com `400`;
  a média tenta construir ObjectId e retorna `500` com detalhe. Outras rotas delegam o ID ao Model.
- **Testes existentes:** `consultas publicas vazias preservam array e media zero; ID invalido tem contratos distintos`
  e encaminhamento de IDs inválidos nos testes de pedidos/propostas/agendamentos.
- **Testes necessários:** matriz de IDs válidos, maiúsculos, ausentes e malformados,
  preservando distinção entre recurso inexistente e entrada inválida.
- **Estratégia proposta:** definir política consistente por contrato público e validá-la
  antes das consultas quando apropriado, sem restringir IDs válidos já aceitos.
- **Critério de aceite:** IDs inválidos seguem a política aprovada e não viram erro
  interno; propriedade e respostas para recursos inexistentes permanecem corretas.

## FUNC-014 — Falhas de notificação suprimidas

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** constatado no código;
  perda de notificação em ambiente real é risco potencial.
- **Arquivos:** `utils/notificacaoHelper.js`, `services/propostaService.js`,
  `controllers/propostaController.js`, `controllers/avaliacaoController.js`.
- **Evidência e impacto:** o helper captura erro de Notificacao.create e apenas registra
  mensagem. O await não garante entrega. Uma rejeição artificial do helper não representa
  seu tratamento normal de falha de persistência.
- **Testes existentes:** argumentos e ordem das chamadas de notificação simuladas.
- **Testes necessários:** helper real com Model simulado que rejeita, efeito no caso de
  uso e persistência real, conforme garantia de entrega que vier a ser escolhida.
- **Estratégia proposta:** definir se entrega é obrigatória ou melhor esforço e como
  observar/repetir falhas sem duplicar notificações nem desfazer contratação legítima.
- **Critério de aceite:** falha de entrega tem comportamento documentado e testado,
  observabilidade segura e recuperação compatível com FUNC-002/FUNC-003.

## FUNC-015 — HTTP inicia antes da conexão com o banco

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** risco potencial;
  chamada não aguardada constatada no código.
- **Arquivos:** `server.js`, `config/database.js`, `src/app.js`.
- **Evidência e impacto:** connectDB é chamado sem await antes de app.listen. Uma
  conexão lenta pode deixar o servidor HTTP aceitando requisições antes da prontidão.
- **Testes existentes:** montagem Express e rotas; não há teste do ciclo de inicialização.
- **Testes necessários:** conexão lenta, rejeitada e concluída com dependências de
  inicialização controladas, sem .env nem banco persistente.
- **Estratégia proposta:** definir política de prontidão e encerramento em mudança
  operacional própria, preservando server.js e npm start como pontos de entrada.
- **Critério de aceite:** o servidor segue a política aprovada antes de atender operações
  dependentes do banco e encerra ou informa indisponibilidade conforme contrato testado.

## FUNC-016 — Interface do portfólio ignora falha HTTP

- **Prioridade:** P2. **Estado:** pendente. **Evidência:** constatado no código.
- **Arquivos:** `site-iservice-main/perfil_prestador.html`, `controllers/usuarioController.js`.
- **Evidência e impacto:** salvarPortifolio aguarda fetch, mas não verifica resposta.ok;
  inclusão/remoção já altera a interface e pode anunciar sucesso sem persistência.
- **Testes existentes:** contratos HTTP de atualização; não há cobertura desse erro da interface.
- **Testes necessários:** PUT com 400/401/500, falha de rede, recarga e nova tentativa.
- **Estratégia proposta:** verificar a resposta e reconciliar interface/persistência,
  mantendo autenticação e evitando sobrescrita silenciosa em operações simultâneas.
- **Critério de aceite:** falhas não são anunciadas como sucesso; após recarga, o usuário
  vê o estado persistido e consegue repetir a operação conforme política definida.

## Acompanhamento e proteção dos dados existentes

Os identificadores FUNC são estáveis para referência futura em cartões do Kanban/Trello.
Não houve atualização de quadro externo nesta etapa. Cada correção precisa registrar
escopo, testes, evidência e decisão de contrato; mudar uma expectativa de caracterização
de comportamento imperfeito só cabe à respectiva correção explicitamente autorizada.

Antes de futura operação sobre dados existentes, preservar contas, IDs, hashes e históricos;
revisar destino, autorização e backup/restauração em ambiente isolado. Não limpar bancos,
recriar usuários, reprocessar senhas ou alterar índices para fazer uma demonstração passar.
O chat e seus índices permanecem fora do escopo da Fase 6A.
