const { requestPairingCode } = require('./src/lib/whatsapp-client');
requestPairingCode('+1234567890').then(console.log).catch(console.error);
