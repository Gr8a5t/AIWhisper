import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';

async function run() {
  const { state: authState } = await useMultiFileAuthState('./temp-auth');
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: authState,
    browser: Browsers.windows("Desktop"),
    version
  });

  sock.ev.on('connection.update', (update) => {
    console.log('Update:', Object.keys(update), update.connection, !!update.qr);
    if (update.qr) {
        console.log('QR was generated!');
        process.exit(0);
    }
  });

  setTimeout(() => {
    console.log('Timeout - QR was not generated');
    process.exit(1);
  }, 10000);
}

run();
