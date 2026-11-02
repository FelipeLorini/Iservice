const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const integrity = require('../../utils/chatIntegrity');
const A = '1'.repeat(24), B = 'a'.repeat(24), C = '2'.repeat(24), D = 'b'.repeat(24);
const index = { name: integrity.PAIR_INDEX, key: { pairKey: 1 }, unique: true, partialFilterExpression: { pairKey: { $type: 'string' } } };
const plain = x => JSON.parse(JSON.stringify(x));
function controller(Chat, Usuario) {
  const exports = {}, logs = [];
  const deps = { '../Models/chatModel': Chat, '../Models/usuarioModel': Usuario, '../utils/chatIntegrity': integrity };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../controllers/chatController.js'), 'utf8'), {
    exports, require: name => { if (!(name in deps)) throw Error('Dependencia inesperada'); return deps[name]; },
    console: { error: (...args) => logs.push(args) }
  });
  return { api: exports, logs };
}
async function invoke(handler, request = {}) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = plain(value); return this; } };
  await handler({ usuarioId: A, body: {}, params: {}, ...request }, res);
  return res;
}
function fixture(options = {}) {
  let sequence = 100, creates = 0, saves = 0, lookups = 0, queries = 0;
  const records = [], users = new Set(options.users || [A, B, C, D]);
  function add(participants, extra = {}) {
    const record = { _id: (++sequence).toString(16).padStart(24, '0'), participants: [...participants], messages: [], isActive: true,
      async save() { saves++; },
      async populate() { this.participants = this.participants.map(p => users.has(integrity.referenceId(p)) ? ({ _id: integrity.referenceId(p), nome: 'Ficticio' }) : null); return this; },
      ...extra };
    records.push(record); return record;
  }
  const Chat = {
    collection: { async indexes() { return options.noIndex ? [] : [index]; } },
    find(filter) {
      queries++;
      let result;
      if (filter.$or) {
        const ids = filter.$or[0].participants.$all;
        result = records.filter(r => ids.every(id => r.participants.some(p => integrity.referenceId(p) === id)) || r.pairKey === filter.$or[1].pairKey);
      } else {
        result = records.filter(r => r.isActive && r.participants.some(p => integrity.referenceId(p) === filter.participants));
      }
      return { async limit(n) { return result.slice(0,n); },
        populate() { return { async sort() { await Promise.all(result.map(r=>r.populate())); return result; }, then(resolve,reject) { return Promise.all(result.map(r=>r.populate())).then(()=>result).then(resolve,reject); } }; } };
    },
    async findById(id) { lookups++; return records.find(r => r._id === id) || null; },
    async findOne(filter) { return records.find(r => r.pairKey === filter.pairKey) || null; },
    async findOneAndUpdate(filter, update, opts) {
      if (!opts.upsert || !opts.new || !opts.runValidators || filter.pairKey !== update.$setOnInsert.pairKey) throw Error('Upsert inseguro');
      let record = records.find(r => r.pairKey === filter.pairKey);
      if (!record) { creates++; record = add(update.$setOnInsert.participants, update.$setOnInsert); }
      if (options.duplicateKey) throw Object.assign(Error('Duplicado sintetico'), { code: 11000, keyPattern: { pairKey: 1 } });
      return record;
    }
  };
  const Usuario = { find(filter) { return { async select() { return filter._id.$in.filter(id => users.has(id)).map(_id=>({_id})); } }; }, async exists(filter) { return users.has(filter._id); } };
  return { ...controller(Chat, Usuario), records, add, users, get creates() { return creates; }, get saves() { return saves; }, get lookups() { return lookups; }, get queries() { return queries; },
    start(sender=A,receiver=B) { return invoke(this.api.startChat, { usuarioId: sender, body: { prestador_id: receiver } }); } };
}
module.exports = { A, B, C, D, index, plain, controller, invoke, fixture };
