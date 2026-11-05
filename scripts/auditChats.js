'use strict';

const { auditChats, AuditError } = require('./lib/chatAudit');
const HELP = 'Uso local: node scripts/auditChats.js --local-disposable --uri mongodb://127.0.0.1:PORTA --database iservice_chat_audit_NOME [--max-time-ms 30000]\n' +
  'Saida JSON somente com contagens. Codigos: 0 sem achados, 1 com achados, 2 falha/uso invalido.\n' +
  'Nao le .env, MONGO_URI ou credenciais. Conexoes remotas e SRV estao bloqueadas nesta versao.\n';

function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--local-disposable', '--uri', '--database', '--max-time-ms'].includes(key) || Object.hasOwn(values, key)) throw new AuditError('AUDIT_INVALID_OPTIONS');
    if (key === '--local-disposable') values[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new AuditError('AUDIT_INVALID_OPTIONS');
      values[key] = value;
    }
  }
  const match = /^mongodb:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(values['--uri'] || '');
  const database = /^iservice_chat_audit_[a-z0-9_]{1,40}$/.exec(values['--database'] || '');
  const maxTimeMS = values['--max-time-ms'] === undefined ? 30000 : Number(values['--max-time-ms']);
  if (!values['--local-disposable'] || !match || match[0] !== values['--uri'] || Number(match[1]) > 65535 ||
      !database || database[0] !== values['--database'] ||
      !Number.isSafeInteger(maxTimeMS) || maxTimeMS < 1000 || maxTimeMS > 300000) throw new AuditError('AUDIT_LOCAL_TARGET_REQUIRED');
  return { uri: values['--uri'], database: values['--database'], maxTimeMS };
}

async function main(argv, { stdout = process.stdout, stderr = process.stderr, createClient } = {}) {
  let client;
  try {
    const options = parseOptions(argv);
    if (options.help) { stdout.write(HELP); return 0; }
    const factory = createClient || ((uri, config) => new (require('mongoose').mongo.MongoClient)(uri, config));
    client = factory(options.uri, { appName: 'iservice-chat-audit-readonly', retryWrites: false, maxPoolSize: 2,
      serverSelectionTimeoutMS: 5000, readPreference: 'primary' });
    await client.connect();
    const report = await auditChats(client.db(options.database), { maxTimeMS: options.maxTimeMS });
    await client.close(); client = null;
    stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.conversas.com_achados ? 1 : 0;
  } catch (error) {
    const code = error instanceof AuditError ? error.code : 'AUDIT_EXECUTION_FAILED';
    stderr.write(JSON.stringify({ erro: code, relatorio_completo: false }) + '\n');
    return 2;
  } finally {
    if (client) { try { await client.close(); } catch (_) { /* Nao expor detalhes do driver. */ } }
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { main, parseOptions };
