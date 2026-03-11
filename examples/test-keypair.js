const { generateKeypair } = require('../dist/index.js');

const keys = generateKeypair('verus');
console.log('Address:', keys.address);
console.log('WIF:    ', keys.wif);
console.log('Pubkey: ', keys.pubkey);
