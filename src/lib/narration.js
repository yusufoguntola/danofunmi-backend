const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

function generateNarration() {
  return `DFM-${nanoid()}`;
}

module.exports = { generateNarration };
