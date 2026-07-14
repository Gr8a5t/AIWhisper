import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  isJidGroup
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import dotenv from 'dotenv';
import { parseSignal } from './parser.js';
import { getLiveGoldPrice } from './price.js';
import { checkStaleness, validateSignal, calculateLotSize, adjustEntryZoneForMaxRisk } from './validator.js';
import { broadcastNotification } from './utils.js';

dotenv.config();

const SIGNAL_GROUP_JID = process.env.SIGNAL_GROUP_JID || 'all';
const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'http://127.0.0.1:8000';
const LICENSE_KEY = process.env.LICENSE_KEY || 'GREAT-FX-DEMO-KEY';
const SUBSCRIBER_ID = process.env.SUBSCRIBER_ID || 'SUB_001';

async function startBot() {
  const { state: authState, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version: waVersion } = await fetchLatestBaileysVersion();

  console.log('[BOT] Starting WhatsApp client session...');
  
  const sock = makeWASocket({
    logger: pino({ level: 'info' }) as any, // Cast to any to resolve minor typings mismatch in Baileys
    printQRInTerminal: false, // We will print it manually using qrcode-terminal
    auth: authState,
    browser: ['Ubuntu', 'Chrome', '20.0.04'], // Hardcoded to match working AIWhisper setup for pairing code
    version: waVersion,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000
  });

  // Request pairing code if credentials are not registered and OWNER_PHONE is provided
  if (!sock.authState.creds.registered) {
    const OWNER_PHONE = process.env.OWNER_PHONE;
    if (OWNER_PHONE) {
      const cleanPhone = OWNER_PHONE.replace(/\D/g, '');
      console.log(`[BOT] Requesting pairing code for phone: ${cleanPhone}...`);
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          console.log('\n==================================================');
          console.log(`[BOT] WhatsApp Pairing Code:`);
          console.log(`\n      👉   ${formatted}   👈\n`);
          console.log(`Enter this code on your phone: WhatsApp -> Linked Devices -> Link with phone number instead.`);
          console.log('==================================================\n');
        } catch (err: any) {
          console.error('[BOT] Failed to request pairing code:', err);
        }
      }, 3000);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !process.env.OWNER_PHONE) {
      console.log('[BOT] Scan the QR code below using WhatsApp to login:');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log(`[BOT] Connection opened successfully! Logged in as: ${sock.user?.name || sock.user?.id}`);
      await broadcastNotification(sock, `🤖 <b>Gold Signal Bot Connected</b>\nSession started successfully.`);
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      
      console.log(`[BOT] Connection closed. Code: ${code}. Reconnecting: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      } else {
        console.log('[BOT] Logged out. Clean up session and restart to generate new QR code.');
      }
    }
  });

    sock.ev.on('messages.upsert', async (update) => {
      const msg = update.messages[0];
      if (!msg.message) return;

      const chatId = msg.key.remoteJid;
      if (!chatId) return;

      const messageContent =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!messageContent) return;

      // 1. Check for command "acct" / "/acct" / ".acct"
      const cleanMsg = messageContent.trim().toLowerCase();
      if (cleanMsg === 'acct' || cleanMsg === '/acct' || cleanMsg === '.acct') {
        console.log(`[BOT] Received 'acct' command in chat: ${chatId}`);
        try {
          const summaryUrl = `${RELAY_SERVER_URL}/summary/${SUBSCRIBER_ID}`;
          const response = await fetch(summaryUrl);
          if (response.ok) {
            const data: any = await response.json();
            
            // Check if MT5 has polled recently (within 2 minutes)
            let mt5Status = '🔴 Disconnected';
            if (data.last_seen) {
              const lastSeenDate = new Date(data.last_seen);
              const diffMs = Date.now() - lastSeenDate.getTime();
              if (diffMs < 120000) { // 2 minutes
                mt5Status = '🟢 Connected';
              } else {
                const minsAgo = Math.round(diffMs / 60000);
                mt5Status = `🟡 Idle (Last seen ${minsAgo}m ago)`;
              }
            }
            
            const replyText = `📊 *MT5 Account Status*\n` +
              `› *Status:* ${mt5Status}\n` +
              `› *Balance:* $${(data.balance || 0.00).toFixed(2)}\n` +
              `› *Equity:* $${(data.equity || 0.00).toFixed(2)}\n` +
              `› *Total Trades:* ${data.total_trades || 0}\n` +
              `› *Win Rate:* ${data.win_rate || '0.0%'}\n` +
              `› *Net PnL:* $${(data.net_pnl || 0.00).toFixed(2)}\n` +
              `› *Subscriber:* ${SUBSCRIBER_ID}\n` +
              `› *License:* ${LICENSE_KEY}`;
              
            await sock.sendMessage(chatId, { text: replyText });
            console.log(`[BOT] Replied with status in ${chatId}`);
          } else {
            await sock.sendMessage(chatId, { text: `❌ Failed to fetch account status. Server returned HTTP ${response.status}.` });
          }
        } catch (err: any) {
          console.error('[BOT] Error processing acct command:', err);
          await sock.sendMessage(chatId, { text: `❌ Error checking MT5 status: ${err.message}` });
        }
        return; // Don't proceed to trade signal parsing for commands
      }

      // 1b. Check for command "groups" / "/groups" / ".groups"
      if (cleanMsg === 'groups' || cleanMsg === '/groups' || cleanMsg === '.groups') {
        console.log(`[BOT] Received 'groups' command in chat: ${chatId}`);
        try {
          const groups = await sock.groupFetchAllParticipating();
          const groupList = Object.values(groups);
          
          if (groupList.length === 0) {
            await sock.sendMessage(chatId, { text: `👥 No active groups found for this WhatsApp account.` });
            return;
          }
          
          let replyText = `👥 *Active WhatsApp Groups:*\n\n`;
          groupList.forEach((g: any, index) => {
            replyText += `${index + 1}. *${g.subject}*\n   › JID: \`${g.id}\`\n\n`;
          });
          
          await sock.sendMessage(chatId, { text: replyText });
          console.log(`[BOT] Replied with groups list in ${chatId}`);
        } catch (err: any) {
          console.error('[BOT] Error fetching groups:', err);
          await sock.sendMessage(chatId, { text: `❌ Error fetching groups: ${err.message}` });
        }
        return; // Don't proceed to trade signal parsing for commands
      }

      // 2. Ignore messages sent by the bot itself to prevent loop
      if (msg.key.fromMe) return;

      // Filter by group JID if configured
      const isGroup = isJidGroup(chatId);
      if (SIGNAL_GROUP_JID !== 'all' && chatId !== SIGNAL_GROUP_JID) {
        return;
      }

      // Fast textual screening to avoid redundant parsing/Gemini calls
      const upperText = messageContent.toUpperCase();
    const hasGoldPattern = upperText.includes('XAUUSD') || upperText.includes('GOLD');
    const hasDirectionPattern = upperText.includes('BUY') || upperText.includes('SELL') || messageContent.includes('🟢') || messageContent.includes('🔴');

    if (!hasGoldPattern || !hasDirectionPattern) {
      return; // Ignore general chatter
    }

    console.log(`[BOT] Potential signal captured from ${msg.pushName || chatId}: "${messageContent.replace(/\n/g, ' ')}"`);

    try {
      // 1. Run through the Parser (regex first, Gemini fallback)
      const parseResult = await parseSignal(messageContent);
      if (!parseResult.isSignal || !parseResult.signal) {
        console.log(`[BOT] Message skipped. Reason: ${parseResult.reason}`);
        return;
      }

      let signal = parseResult.signal;
      console.log(`[BOT] Parsed Signal Details:`, JSON.stringify(signal, null, 2));

      // Enforce maximum risk of 50 pips (5.0 points) to protect the account
      const maxRiskPips = parseFloat(process.env.MAX_RISK_PIPS || '50');
      signal = adjustEntryZoneForMaxRisk(signal, maxRiskPips);
      console.log(`[BOT] Adjusted Signal for Max Risk (${maxRiskPips} pips):`, JSON.stringify(signal, null, 2));

      // 2. Fetch Live Price from MT5 Relay (fallback Yahoo Finance)
      const livePrice = await getLiveGoldPrice();

      // 3. Staleness Gate Check
      const staleness = checkStaleness(signal, livePrice, livePrice);
      if (staleness.stale) {
        const staleMsg = `⚠️ <b>Gold Signal Stale — Rejected</b>\n` +
          `› Live Price: ${livePrice.toFixed(2)}\n` +
          `› Reference: ${staleness.refPrice.toFixed(2)} (${process.env.REFERENCE_PRICE_MODE} mode)\n` +
          `› Distance: ${staleness.pips.toFixed(1)} pips (Limit: ${process.env.STALENESS_PIPS_LIMIT} pips)`;
        await broadcastNotification(sock, staleMsg);
        return;
      }

      // 4. Validation Layer Check (TP/SL rules, R:R calculation based on TP1)
      const validation = validateSignal(signal);
      if (!validation.valid) {
        const invalidMsg = `❌ <b>Gold Signal Invalid — Rejected</b>\n` +
          `› Errors: ${validation.errors.join(', ')}\n` +
          `› R:R (TP1): ${validation.rrRatio?.toFixed(2)}`;
        await broadcastNotification(sock, invalidMsg);
        return;
      }

      // 5. Calculate Lot Sizing
      const targetEntry = validation.entryPrice || (signal.entryMin + signal.entryMax) / 2;
      const lotSize = await calculateLotSize(targetEntry, signal.sl);

      // 6. Relay Execution
      // If signal has multiple take profit targets (TP1, TP2, TP3), we split the lot size into multiple trades
      // to capture all target levels on MT5.
      const tps: number[] = [signal.tp1];
      if (signal.tp2) tps.push(signal.tp2);
      if (signal.tp3) tps.push(signal.tp3);

      const splitCount = tps.length;
      const individualLot = Math.floor((lotSize / splitCount) * 100) / 100;
      
      // If the split lot is less than 0.01 (MT5 minimum), we place a single trade using TP1.
      const executionQueue: { tp: number; lot: number }[] = [];
      if (individualLot >= 0.01) {
        tps.forEach(tp => {
          executionQueue.push({ tp, lot: individualLot });
        });
      } else {
        // Fallback: single position targeting TP1
        executionQueue.push({ tp: signal.tp1, lot: lotSize });
      }

      console.log(`[BOT] Queueing ${executionQueue.length} trade order(s) for relay transmission...`);

      const baseTicket = Date.now();
      for (let i = 0; i < executionQueue.length; i++) {
        const order = executionQueue[i];
        const ticket = baseTicket + i;

        const payload = {
          event: 'OPEN',
          ticket: ticket,
          symbol: 'XAUUSD',
          direction: signal.direction,
          entry: targetEntry,
          sl: signal.sl,
          tp: order.tp,
          lot: order.lot,
          timestamp: new Date().toISOString(),
          master_id: 'whatsapp_bot'
        };

        const relayUrl = `${RELAY_SERVER_URL}/signal`;
        const response = await fetch(relayUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const resData: any = await response.json();
          const orderMsg = `🟢 <b>TRADE EXECUTED — ${signal.direction} XAUUSD</b>\n` +
            `› Entry: ${targetEntry.toFixed(2)}\n` +
            `› Stop Loss: ${signal.sl.toFixed(2)}\n` +
            `› Take Profit: ${order.tp.toFixed(2)} (Leg ${i + 1}/${executionQueue.length})\n` +
            `› Lot Size: ${order.lot.toFixed(2)}\n` +
            `› Ticket: #${ticket}\n` +
            `› Relay Status: ${resData?.status || 'Success'}`;
          await broadcastNotification(sock, orderMsg);
        } else {
          const errText = await response.text();
          const errorMsg = `🔴 <b>Relay execution failed for Ticket #${ticket}</b>\n` +
            `› HTTP Status: ${response.status}\n` +
            `› Error: ${errText}`;
          await broadcastNotification(sock, errorMsg);
        }
      }
    } catch (err: any) {
      console.error('[BOT] Error processing potential signal message:', err);
      await broadcastNotification(sock, `🚨 <b>System Error processing message:</b> ${err.message}`);
    }
  });
}

startBot().catch(err => {
  console.error('[BOT] Critical crash on startBot():', err);
});
