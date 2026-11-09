'use strict';
const readline = require('node:readline');
const { criarContratacaoLocalApp } = require('../tests/helpers/contratacaoLocalApp');

// Entradas substituiveis somente para testes do terminal. Nao aceita URI ou banco externo.
async function iniciarDemo({ entrada = process.stdin, saida = process.stdout, sinais = process } = {}) {
  const print = message => saida.write(message + '\n');
  let local, terminal, closing, stopping = false, transitioning = false, resolveDone;
  const concluido = new Promise(resolve => { resolveDone = resolve; });
  const onSignal = () => { void encerrar().catch(error => print('Falha no encerramento: ' + error.message)); };
  sinais.on('SIGINT', onSignal); sinais.on('SIGTERM', onSignal);

  const starting = (async () => {
    print('Iniciando demonstracao: somente dados ficticios e MongoDB descartavel proprio.');
    local = await criarContratacaoLocalApp({ servirFrontend: true });
    if (stopping) return;
    await local.iniciarHttp();
    if (stopping) return;
    const { pid, port, directory, databaseName, setName } = local.replica;
    print('Isolamento e indices I1-I5 verificados. Recursos exclusivos: ' + JSON.stringify({ pid, port, directory, databaseName, setName }));
    print('URL: ' + local.url);
    print('Fase: PREPARACAO');
    print('Abra dois navegadores/perfis separados e autentique cliente e prestador ANTES de digitar aceitar.');
    print('Comandos: aceitar | estado | ajuda | sair. Ctrl+C tambem encerra e descarta os dados.');
    terminal = readline.createInterface({ input: entrada, output: saida, terminal: Boolean(entrada.isTTY && saida.isTTY) });
    terminal.on('SIGINT', onSignal);
    terminal.on('close', onSignal);
    terminal.on('line', line => {
      const command = line.trim().toLowerCase();
      if (stopping) return;
      if (command === 'sair') return onSignal();
      if (command === 'estado') return print('Fase: ' + local.fase + '; preparacoes em andamento: ' + local.preparacoesAtivas);
      if (command === 'ajuda') return print('aceitar: fecha preparacao e drena escritas; estado: consulta fase; sair: encerra. Nao ha retorno a preparacao.');
      if (command !== 'aceitar') return print('Comando desconhecido. Use aceitar, estado, ajuda ou sair.');
      if (transitioning || local.fase !== 'PREPARACAO') return print('Fase: ' + local.fase + '. Nao e possivel reiniciar a preparacao.');
      transitioning = true;
      print('Fase: DRENANDO. Fechando admissoes e aguardando preparacoes em andamento...');
      // A chamada fecha admissao sincronamente. sair/SIGINT continuam disponiveis durante o await.
      (async () => { await local.iniciarAceitacao(); })().then(() => {
        if (!stopping) print('Fase: ACEITACAO. Prontidao reconferida; aceitacao/replay e leituras liberados. Cadastro e login encerrados.');
      }).catch(error => {
        if (!stopping) print('Transicao falhou; aceitacao NAO liberada. Use sair e reinicie um ensaio novo. Motivo: ' + error.message);
      }).finally(() => { transitioning = false; });
    });
  })();

  function encerrar() {
    if (closing) return closing;
    stopping = true;
    // Adia o corpo para que closing exista antes de readline emitir close.
    closing = Promise.resolve().then(async () => {
      print('Encerrando: aguardando operacoes e removendo somente recursos descartaveis proprios...');
      terminal?.close();
      let failure;
      try {
        await starting.catch(() => {});
        if (local) await local.encerrar();
        print('Encerrado. HTTP, conexoes e MongoDB proprio fechados; diretorio temporario removido.');
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        sinais.removeListener('SIGINT', onSignal); sinais.removeListener('SIGTERM', onSignal);
        resolveDone(failure);
      }
    });
    return closing;
  }
  try { await starting; } catch (error) { await encerrar(); throw error; }
  return { encerrar, concluido };
}

if (require.main === module) {
  iniciarDemo().then(async demo => {
    const failure = await demo.concluido;
    if (failure) throw failure;
  }).catch(error => {
    console.error('Falha na demonstracao: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = { iniciarDemo };
