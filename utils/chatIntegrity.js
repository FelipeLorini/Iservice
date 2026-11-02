const STRICT_ID = /^[a-f\d]{24}$/i;

function normalizeId(value) {
  return typeof value === 'string' && value.length === 24 && STRICT_ID.test(value) ? value.toLowerCase() : null;
}

// Referencias internas podem ser ObjectIds/documentos; entradas HTTP nao podem.
function referenceId(value) {
  if (typeof value === 'string') return normalizeId(value);
  if (!value) return null;
  if (typeof value.toHexString === 'function') return normalizeId(value.toHexString());
  return value._id && value._id !== value ? referenceId(value._id) : null;
}

function participantIds(participants) {
  if (!Array.isArray(participants) || participants.length !== 2) return null;
  const ids = participants.map(referenceId);
  return ids[0] && ids[1] && ids[0] !== ids[1] ? ids : null;
}

function pairKey(participants) {
  const ids = participantIds(participants);
  return ids ? ids.slice().sort().join(':') : null;
}

function validMessages(messages, ids) {
  return Array.isArray(messages) && messages.every(message => {
    if (!message || typeof message !== 'object') return false;
    const sender = referenceId(message.sender);
    const receiver = referenceId(message.receiver);
    return sender && receiver && sender !== receiver && ids.includes(sender) && ids.includes(receiver) &&
      typeof message.content === 'string' && message.content.trim().length > 0;
  });
}

function validChat(chat) {
  const ids = participantIds(chat?.participants);
  return !!ids && (chat.pairKey === undefined || chat.pairKey === pairKey(ids)) && validMessages(chat.messages, ids);
}

const PAIR_INDEX = 'chat_pair_key_unique';
function hasPairIndex(indexes) {
  return indexes.some(index => index.name === PAIR_INDEX && index.unique === true &&
    index.key?.pairKey === 1 && Object.keys(index.key).length === 1 &&
    index.partialFilterExpression?.pairKey?.$type === 'string' &&
    Object.keys(index.partialFilterExpression).length === 1 &&
    Object.keys(index.partialFilterExpression.pairKey).length === 1 && !index.sparse &&
    (!index.collation || index.collation.locale === 'simple'));
}

module.exports = { normalizeId, referenceId, participantIds, pairKey, validMessages, validChat, PAIR_INDEX, hasPairIndex };
