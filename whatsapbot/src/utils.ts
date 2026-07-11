import dotenv from 'dotenv';
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const OWNER_PHONE = process.env.OWNER_PHONE || '';

/**
 * Sends a message via Telegram bot if configured.
 */
export async function notifyTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('[NOTIFY] Failed to send Telegram alert:', err);
  }
}

function htmlToWhatsApp(text: string): string {
  return text
    .replace(/<\/?b>/gi, '*')
    .replace(/<\/?i>/gi, '_')
    .replace(/<\/?code>/gi, '```')
    .replace(/<br\s*\/?>/gi, '\n');
}

/**
 * Sends a WhatsApp message to the owner's phone number using the bot's active connection.
 */
export async function notifyWhatsApp(sock: any, message: string): Promise<void> {
  if (!OWNER_PHONE) return;

  // Format owner phone JID if it's not already in the JID format (e.g. 1234567890@s.whatsapp.net)
  let recipientJid = OWNER_PHONE.trim();
  if (!recipientJid.includes('@')) {
    // Strip non-digits and append domain
    recipientJid = recipientJid.replace(/\D/g, '') + '@s.whatsapp.net';
  }

  try {
    const formatted = htmlToWhatsApp(message);
    await sock.sendMessage(recipientJid, { text: formatted });
    console.log(`[NOTIFY] WhatsApp alert successfully sent to ${recipientJid}`);
  } catch (err) {
    console.error('[NOTIFY] Failed to send WhatsApp alert:', err);
  }
}

/**
 * Logs a message to console and broadcasts to all configured notification channels.
 */
export async function broadcastNotification(sock: any, message: string): Promise<void> {
  console.log(`[ALERT] ${message}`);
  await notifyTelegram(message);
  await notifyWhatsApp(sock, message);
}
