import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  type WAMessage,
  isJidGroup,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import qr from "qrcode";
import path from "path";
import fs from "fs/promises";
import * as db from "./db";
import { generateAIResponse } from "./ai";
import type { Message, Agent } from "@/types";

const WHATSAPP_AUTH_DIR = path.join(process.cwd(), "whatsapp-auth");

function getHostBrowserDescriptor(): [string, string, string] {
  // Hardcoded to Ubuntu Chrome as WhatsApp servers frequently reject
  // 'Desktop' or macOS descriptors when using the pairing code API,
  // resulting in a "Couldn't link device" error.
  return ["Ubuntu", "Chrome", "20.0.04"];
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

interface WhatsAppClientState {
  sock: WASocket | null;
  status: ConnectionStatus;
  qr: string | null;
  account: { id: string; name: string } | null;
  lastDisconnect: { reason: string; date: string } | null;
  pairingCode: string | null;
  pairingPhone: string | null;
}

declare global {
  var whatsappState: WhatsAppClientState;
  var whatsappWatchdog: NodeJS.Timer | undefined;
  // FIX 1: Global init lock to prevent multiple concurrent init() calls
  // across Next.js hot reloads and the watchdog/AUTO_INIT racing each other.
  var whatsappInitLock: boolean;
}

if (!global.whatsappState) {
  global.whatsappState = {
    sock: null,
    status: "disconnected",
    qr: null,
    account: null,
    lastDisconnect: null,
    pairingCode: null,
    pairingPhone: null,
  };
}

// FIX 1 (continued): Initialise the lock flag on first module load.
if (global.whatsappInitLock === undefined) {
  global.whatsappInitLock = false;
}

const state = global.whatsappState;

async function handleMessage(msg: WAMessage) {
  try {
    if (!msg.message || !msg.key.remoteJid || isJidGroup(msg.key.remoteJid)) {
      return;
    }

    const chatId = msg.key.remoteJid;
    const messageContent =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    if (!messageContent) return;

    const rawName = (msg.pushName || "").trim();
    const senderName =
      rawName && rawName !== "." ? rawName : chatId.split("@")[0];

    const message: Message = {
      id: msg.key.id!,
      chatId,
      fromMe: !!msg.key.fromMe,
      text: messageContent,
      timestamp:
        (typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : (msg.messageTimestamp as any)?.toNumber?.() || Date.now() / 1000) *
        1000,
      senderName,
    };

    await db.addMessage(message);

    const convo = await db.getConversation(chatId);
    await db.updateConversation(chatId, {
      name: message.senderName,
      lastMessage: { text: message.text, timestamp: message.timestamp },
      unreadCount: (convo?.unreadCount || 0) + (message.fromMe ? 0 : 1),
    });

    if (!message.fromMe) {
      await db.incrementStat("received");

      let agent: Agent | undefined;
      const convoAfterUpdate = await db.getConversation(chatId);
      if (convoAfterUpdate?.assignedAgentId) {
        agent = await db.getAgent(convoAfterUpdate.assignedAgentId);
      }
      if (!agent) {
        const agents = await db.getAgents();
        agent = agents[0];
        if (agent) {
          await db.setConversationAssignedAgent(chatId, agent.id);
        }
      }
      if (agent) {
        console.log("=== AGENT FOUND ===");
        console.log("Agent mode:", agent.mode);
        console.log("Agent has aiSettings:", !!agent.aiSettings);

        if (agent.mode === "ai" && agent.aiSettings) {
          console.log("=== CALLING AI AGENT ===");
          try {
            const aiReply = await generateAIResponse(
              messageContent,
              agent.aiSettings,
            );
            console.log("=== AI REPLY RECEIVED ===");
            console.log("AI reply:", aiReply);
            console.log("AI reply length:", aiReply?.length);
            console.log("AI reply truthy:", !!aiReply);

            if (aiReply) {
              console.log("=== SENDING AI REPLY ===");
              await sendMessage(chatId, aiReply);
              await db.addLog({
                user: agent.name,
                action: "AI Response Sent",
                details: aiReply.slice(0, 120),
                type: "info",
              });
              return;
            } else {
              console.log("=== AI REPLY WAS EMPTY, FALLING BACK ===");
            }
          } catch (err) {
            console.error("AI response failed:", err);
            await db.addLog({
              user: agent.name,
              action: "AI Response Failed",
              details: (err as Error).message,
              type: "error",
            });
          }
        } else {
          console.log("=== NOT AN AI AGENT OR NO AI SETTINGS ===");
        }

        const lowerText = messageContent.toLowerCase();
        let chosenResponse: string | undefined;
        for (const rule of agent.rules) {
          const keywords = rule.trigger.value
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);
          if (
            keywords.length &&
            keywords.some((kw) => lowerText.includes(kw))
          ) {
            chosenResponse =
              rule.responses.length > 0
                ? rule.responses[
                    Math.floor(Math.random() * rule.responses.length)
                  ]
                : undefined;
            break;
          }
        }
        if (!chosenResponse) {
          chosenResponse =
            agent.fallbackResponse || "Sorry, I didn't quite understand that.";
        }
        try {
          await db.addLog({
            user: agent.name,
            action: "Auto-response Attempt",
            details: `Sending to ${chatId}: ${chosenResponse}`,
            type: "info",
          });
          await sendMessage(chatId, chosenResponse);
          await db.addLog({
            user: agent.name,
            action: "Auto-response Sent",
            details: chosenResponse,
            type: "info",
          });
        } catch (err) {
          console.error("Auto-response failed:", err);
          await db.incrementStat("errors");
          await db.addLog({
            user: agent.name,
            action: "Auto-response Failed",
            details: (err as Error).message,
            type: "error",
          });
        }
      } else {
        console.warn("No agent available to respond.");
      }
    }
  } catch (error) {
    console.error("Error handling message:", error);
    await db.addLog({
      user: "System",
      action: "Message Processing Failed",
      details: (error as Error).message,
      type: "error",
    });
  }
}

export async function logout() {
  console.log("LOGOUT: Starting full cleanup...");
  if (state.sock) {
    console.log("LOGOUT: Logging out of existing socket.");
    try {
      await state.sock.logout();
    } catch (e) {
      console.error(
        "LOGOUT: Error on logout, probably already disconnected.",
        e,
      );
    } finally {
      (state.sock?.ev as any)?.removeAllListeners();
      state.sock = null;
    }
  }

  try {
    await fs.rm(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
    console.log("LOGOUT: Session directory deleted.");
  } catch (e) {
    console.error("LOGOUT: Error deleting session directory.", e);
  }

  state.status = "disconnected";
  state.qr = null;
  state.account = null;
  state.pairingCode = null;
  state.pairingPhone = null;
  // FIX 1 (continued): Always release the lock on logout so a subsequent
  // init() call is never permanently blocked.
  global.whatsappInitLock = false;
  console.log("LOGOUT: In-memory state has been reset.");
}

export async function init() {
  // FIX 1: Guard against concurrent calls — both the existing sock check AND
  // the new global lock must be clear before we proceed.
  if (state.sock || global.whatsappInitLock) {
    console.log(`INIT: Skipped, current status is "${state.status}"`);
    return;
  }

  global.whatsappInitLock = true; // acquire lock
  console.log("INIT: Starting connection process...");
  state.status = "connecting";

  try {
    const { state: authState, saveCreds } =
      await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

    const { version: waVersion } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      logger: pino({ level: "info" }),
      printQRInTerminal: false,
      auth: authState,
      browser: getHostBrowserDescriptor(),
      markOnlineOnConnect: true,
      connectTimeoutMs: 30_000,
      syncFullHistory: false,
      version: waVersion,
    });

    state.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", (update) => {
      for (const msg of update.messages) {
        handleMessage(msg);
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr: newQr } = update;
      console.log(`CONN_UPDATE: status=${connection}, qr=${!!newQr}`);

      if (newQr) {
        state.qr = await qr.toDataURL(newQr);
        if (state.status !== "connected") {
          state.status = "connecting";
        }
      }

      if (connection === "open") {
        state.status = "connected";
        state.qr = null;
        state.pairingCode = null;
        state.pairingPhone = null;
        state.account = { id: sock.user!.id, name: sock.user!.name || "N/A" };
        console.log("CONN_UPDATE: Connection opened successfully.");
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output
          ?.statusCode;
        try {
          (sock.ev as any).removeAllListeners();
        } catch (_) {
          /* ignore */
        }

        const reasonString =
          lastDisconnect?.error?.message || "Unknown Disconnect";
        state.lastDisconnect = {
          reason: `Error: ${reasonString}`,
          date: new Date().toISOString(),
        };

        const shouldReconnect =
          code !== DisconnectReason.loggedOut &&
          code !== DisconnectReason.connectionReplaced;

        if (shouldReconnect) {
          console.log(
            `CONN_UPDATE: Connection closed (code=${code}). Attempting automatic reconnect...`,
          );
          state.status = "connecting";
          state.sock = null;
          state.account = null;
          // FIX 1 (continued): Release the lock BEFORE scheduling reconnect,
          // otherwise the re-init call would be blocked by the lock itself.
          global.whatsappInitLock = false;
          setTimeout(() => {
            init().catch((err) => console.error("Re-init failed:", err));
          }, 1000);
        } else {
          console.log(
            `CONN_UPDATE: Logged out by user/device (code=${code}). Waiting for QR rescan.`,
          );
          state.status = "disconnected";
          state.sock = null;
          state.account = null;
          global.whatsappInitLock = false; // release lock on clean logout too
        }
      }
    });
  } catch (err) {
    // FIX 1 (continued): If init itself throws (e.g. auth read failure),
    // release the lock so the watchdog can retry.
    global.whatsappInitLock = false;
    state.status = "disconnected";
    throw err;
  }
}

// ----------------- Watchdog -----------------
if (!global.whatsappWatchdog) {
  global.whatsappWatchdog = setInterval(() => {
    if (!state.sock || state.status !== "connected") {
      console.warn("WATCHDOG: Socket not connected, attempting re-init...");
      init().catch((err) => console.error("WATCHDOG: Re-init failed", err));
    }
  }, 30_000);
}

if (state.status === "disconnected" && !state.sock) {
  console.log(
    "AUTO_INIT: No active socket, starting initial WhatsApp connect...",
  );
  init().catch((err) => console.error("AUTO_INIT failed:", err));
}

export function getClientState() {
  return {
    status: state.status,
    qr: state.qr,
    account: state.account,
    lastDisconnect: state.lastDisconnect,
    pairingCode: state.pairingCode,
  };
}

export async function requestPairingCode(phone: string): Promise<string> {
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) throw new Error("Invalid phone number.");

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      await logout();
      await init();

      return await new Promise<string>((resolve, reject) => {
        // FIX 2: Guard flag ensures the Promise settles exactly once even if
        // the interval fires multiple times before clearInterval takes effect.
        let resolved = false;
        const startTime = Date.now();

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearInterval(interval);
            reject(new Error("Socket did not become ready in 40s."));
          }
        }, 40000);

        // FIX 3: The correct readiness signal for the pairing-code flow is
        // when the socket has successfully generated a QR code or sufficient
        // time has passed, rather than waiting for "connected" (which only
        // happens AFTER successful authentication).
        const interval = setInterval(() => {
          const isReady = state.qr !== null || (Date.now() - startTime > 3000);
          if (state.status === "connecting" && state.sock && isReady && !resolved) {
            resolved = true;
            clearInterval(interval);
            clearTimeout(timeout);
            performPairing(cleanPhone).then(resolve).catch(reject);
          }
        }, 500);

        // Check immediately in case the socket is already ready
        if (state.status === "connecting" && state.sock && state.qr !== null && !resolved) {
          resolved = true;
          clearInterval(interval);
          clearTimeout(timeout);
          performPairing(cleanPhone).then(resolve).catch(reject);
        }
      });
    } catch (err) {
      attempts++;
      console.error(`PAIRING: Attempt ${attempts} failed:`, err);
      if (attempts >= maxAttempts) throw err;
    }
  }
  throw new Error("Failed to request pairing code after multiple attempts.");
}

async function performPairing(cleanPhone: string): Promise<string> {
  console.log(`PAIRING: Requesting pairing code for ${cleanPhone}`);
  const rawCode = await state.sock!.requestPairingCode(cleanPhone);
  const formatted =
    rawCode.length === 8
      ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
      : rawCode;
  state.pairingCode = formatted;
  state.pairingPhone = cleanPhone;
  console.log("PAIRING: Received code", formatted);
  return formatted;
}

export async function sendMessage(to: string, text: string) {
  if (!state.sock || state.status !== "connected") {
    throw new Error("WhatsApp client not connected.");
  }
  const sendResult = await state.sock.sendMessage(to, { text });
  const result = (
    Array.isArray(sendResult) ? sendResult[0] : sendResult
  ) as any;

  const message: Message = {
    id: result.key.id!,
    chatId: to,
    fromMe: true,
    text: text,
    timestamp: Date.now(),
    senderName: "Me",
  };

  await db.addMessage(message);
  await db.updateConversation(to, {
    lastMessage: { text: message.text, timestamp: message.timestamp },
    unreadCount: 0,
  });
  await db.incrementStat("sent");

  return result;
}
