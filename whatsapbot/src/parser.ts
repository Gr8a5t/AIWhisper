import { ParseResult, TradeSignal } from './types.js';

// Load env variables if not loaded
import dotenv from 'dotenv';
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

/**
 * Normalizes symbols like "GOLD" to "XAUUSD" for consistency.
 */
function normalizePair(pair: string): string {
  const p = pair.toUpperCase().trim();
  if (p === 'GOLD' || p === 'XAUUSD') {
    return 'XAUUSD';
  }
  return p;
}

/**
 * Attempts to parse the message using regular expressions.
 * Returns ParseResult with isSignal: true if all required fields are found.
 */
export function parseWithRegex(text: string): ParseResult {
  const cleanText = text.replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD00-\uDFFF]/g, ' '); // Strip emojis
  const upperText = cleanText.toUpperCase();

  // 1. Check if the message is an update, results, or commentary
  const ignorePatterns = [
    /TP\d*\s*HIT/i,
    /TAKE\s*PROFIT\s*\d*\s*HIT/i,
    /SL\s*HIT/i,
    /STOP\s*LOSS\s*HIT/i,
    /RUNNING\s*\+/i,
    /CLOSED\s*AT/i,
    /SECURE\s*PROFIT/i,
    /MOVE\s*SL/i,
    /MOVE\s*STOP/i,
    /CANCEL/i,
    /CLOSE\s*NOW/i
  ];

  for (const pattern of ignorePatterns) {
    if (pattern.test(upperText)) {
      return { isSignal: false, reason: 'Ignore: Trade update or result message' };
    }
  }

  // 2. Identify pair (Must mention XAUUSD or GOLD)
  const pairMatch = upperText.match(/\b(XAUUSD|GOLD)\b/i);
  if (!pairMatch) {
    return { isSignal: false, reason: 'Ignore: No gold pair mention (XAUUSD or GOLD)' };
  }
  const pair = normalizePair(pairMatch[1]);

  // 3. Identify direction (BUY or SELL)
  // Emoji cues can also be checked, but textual representation is primary
  let direction: 'BUY' | 'SELL' | null = null;
  if (/\bBUY\b/i.test(upperText) || /🟢|📈/i.test(cleanText)) {
    direction = 'BUY';
  } else if (/\bSELL\b/i.test(upperText) || /🔴|📉/i.test(cleanText)) {
    direction = 'SELL';
  }

  if (!direction) {
    return { isSignal: false, reason: 'Ignore: No clear direction (BUY or SELL)' };
  }

  // 4. Match entry prices (usually 4-digit numbers starting with 1, 2, or 3)
  // Can be a single price or a range like 2340-2342 or 2340 / 2342
  // We search for numbers between 1500 and 3500.
  const priceRegexStr = '(?:[1-9][0-9]{3}(?:\\.[0-9]+)?)';
  
  // Search for Entry keyword followed by prices, or just BUY/SELL @ price
  const entryPattern = new RegExp(
    `(?:ENTRY|ENTRIES|ZONE|@|AT|LIMIT)?\\s*(${priceRegexStr})\\s*(?:-\\s*(${priceRegexStr})|/\\s*(${priceRegexStr}))?`,
    'i'
  );
  
  // Clean up search context around BUY/SELL or ENTRY
  let entryMin = 0;
  let entryMax = 0;

  const entryMatch = upperText.match(entryPattern);
  if (entryMatch && entryMatch[1]) {
    entryMin = parseFloat(entryMatch[1]);
    const secondPrice = entryMatch[2] || entryMatch[3];
    entryMax = secondPrice ? parseFloat(secondPrice) : entryMin;
  }

  if (entryMin === 0) {
    // Try to find any price around the BUY/SELL keywords
    const fallbackEntryPattern = new RegExp(`(?:BUY|SELL)\\s+(?:NOW|LIMIT|MARKET)?\\s*(?:@|AT|LIMIT)?\\s*(${priceRegexStr})`, 'i');
    const fallbackMatch = upperText.match(fallbackEntryPattern);
    if (fallbackMatch && fallbackMatch[1]) {
      entryMin = parseFloat(fallbackMatch[1]);
      entryMax = entryMin;
    }
  }

  if (entryMin === 0) {
    return { isSignal: false, reason: 'Failed to extract entry price' };
  }

  // 5. Match SL (Stop Loss)
  const slPattern = new RegExp(`(?:SL|STOP\\s*LOSS|STOP)\\s*[^0-9]*?\\s*(${priceRegexStr})`, 'i');
  const slMatch = upperText.match(slPattern);
  let sl = 0;
  if (slMatch && slMatch[1]) {
    sl = parseFloat(slMatch[1]);
  }

  if (sl === 0) {
    return { isSignal: false, reason: 'Failed to extract stop loss (SL)' };
  }

  // 6. Match Take Profits (TP1, TP2, TP3)
  const tp1Pattern = new RegExp(`(?:TP1|TP\\s*1|TAKE\\s*PROFIT\\s*1|TO|TP)\\s*[^0-9]*?\\s*(${priceRegexStr})`, 'i');
  const tp2Pattern = new RegExp(`(?:TP2|TP\\s*2|TAKE\\s*PROFIT\\s*2)\\s*[^0-9]*?\\s*(${priceRegexStr})`, 'i');
  const tp3Pattern = new RegExp(`(?:TP3|TP\\s*3|TAKE\\s*PROFIT\\s*3)\\s*[^0-9]*?\\s*(${priceRegexStr})`, 'i');

  const tp1Match = upperText.match(tp1Pattern);
  const tp2Match = upperText.match(tp2Pattern);
  const tp3Match = upperText.match(tp3Pattern);

  let tp1 = 0;
  let tp2: number | undefined = undefined;
  let tp3: number | undefined = undefined;

  if (tp1Match && tp1Match[1]) tp1 = parseFloat(tp1Match[1]);
  if (tp2Match && tp2Match[1]) tp2 = parseFloat(tp2Match[1]);
  if (tp3Match && tp3Match[1]) tp3 = parseFloat(tp3Match[1]);

  // Fallback for TPs if they are listed sequentially without TP1/2/3 label
  if (tp1 === 0) {
    const listPattern = new RegExp(`(?:TPS|TP|TAKE\\s*PROFITS)\\s*[^0-9]*?\\s*(${priceRegexStr})\\s*[^0-9]*?\\s*(${priceRegexStr})?(?:\\s*[^0-9]*?\\s*(${priceRegexStr}))?`, 'i');
    const listMatch = upperText.match(listPattern);
    if (listMatch) {
      if (listMatch[1]) tp1 = parseFloat(listMatch[1]);
      if (listMatch[2]) tp2 = parseFloat(listMatch[2]);
      if (listMatch[3]) tp3 = parseFloat(listMatch[3]);
    }
  }

  if (tp1 === 0) {
    return { isSignal: false, reason: 'Failed to extract at least Take Profit 1 (TP1)' };
  }

  const signal: TradeSignal = {
    pair,
    direction,
    entryMin,
    entryMax,
    sl,
    tp1,
    tp2,
    tp3,
    rawText: text
  };

  return { isSignal: true, signal };
}

/**
 * Fallback parser using Gemini API JSON structured output.
 */
export async function parseWithGemini(text: string): Promise<ParseResult> {
  if (!GEMINI_API_KEY) {
    console.warn('Gemini API key is not configured. Skipping Gemini fallback.');
    return { isSignal: false, reason: 'Gemini API key not configured' };
  }

  const systemPrompt = `You are an AI assistant built to parse raw text messages from WhatsApp trading groups.
Your only job is to extract structured trading parameters for Gold (XAUUSD or GOLD).

Determine if the message is a valid trade setup/signal.
If it is a trade signal, extract:
- pair (must normalize to "XAUUSD")
- direction ("BUY" or "SELL")
- entryMin (the entry price or the lower boundary of entry range)
- entryMax (the entry price or the upper boundary of entry range. If it is a single entry price, set it equal to entryMin)
- sl (Stop Loss)
- tp1 (Take Profit 1)
- tp2 (Take Profit 2, optional)
- tp3 (Take Profit 3, optional)

CRITICAL RULES:
1. Only parse signals for Gold (XAUUSD or GOLD). If the signal is for a different pair (like EURUSD, GBPUSD, BTCUSD), reject it (isSignal: false).
2. If the message is an update (e.g. "TP1 hit!", "Move SL to breakeven", "Close half position", "Secure profits"), reject it (isSignal: false).
3. If the message is just chit-chat, commentary, or news, reject it (isSignal: false).

You MUST respond with a single JSON object. Follow this schema exactly:
{
  "isSignal": boolean,
  "signal": {
    "pair": "XAUUSD",
    "direction": "BUY" | "SELL",
    "entryMin": number,
    "entryMax": number,
    "sl": number,
    "tp1": number,
    "tp2": number (optional),
    "tp3": number (optional)
  }
}

Do not include markdown tags, code blocks (like \`\`\`json), or any commentary in your final output. Return ONLY the raw JSON string.`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: `${systemPrompt}\n\nMessage to parse:\n${text}` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = '';

  for (const model of models) {
    try {
      console.log(`[PARSER] Attempting Gemini fallback with model: ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.warn(`[PARSER] Model ${model} failed with status ${resp.status}: ${errorText.slice(0, 150)}...`);
        lastError = `Model ${model} returned HTTP ${resp.status}`;
        continue; // Try next model
      }

      const data: any = await resp.json();
      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      
      if (!responseText) {
        lastError = `Model ${model} returned empty response`;
        continue;
      }

      const result = JSON.parse(responseText);
      
      if (result.isSignal && result.signal) {
        const sig = result.signal;
        // Perform simple validation on returned types
        if (sig.pair && sig.direction && sig.entryMin && sig.sl && sig.tp1) {
          return {
            isSignal: true,
            signal: {
              pair: normalizePair(sig.pair),
              direction: sig.direction.toUpperCase(),
              entryMin: parseFloat(sig.entryMin),
              entryMax: parseFloat(sig.entryMax || sig.entryMin),
              sl: parseFloat(sig.sl),
              tp1: parseFloat(sig.tp1),
              tp2: sig.tp2 ? parseFloat(sig.tp2) : undefined,
              tp3: sig.tp3 ? parseFloat(sig.tp3) : undefined,
              rawText: text
            }
          };
        }
      }
      
      return { isSignal: false, reason: 'Gemini determined this is not a valid gold signal' };
    } catch (err: any) {
      console.warn(`[PARSER] Error with model ${model}: ${err.message}`);
      lastError = err.message;
    }
  }

  return { isSignal: false, reason: `All Gemini models failed. Last error: ${lastError}` };
}

/**
 * Main parser entry point. Combines regex-first parsing and Gemini fallback.
 */
export async function parseSignal(text: string): Promise<ParseResult> {
  // Try regex first (very fast, free)
  const regexResult = parseWithRegex(text);
  if (regexResult.isSignal) {
    console.log('[PARSER] Successfully parsed signal using regex.');
    return regexResult;
  }

  console.log(`[PARSER] Regex failed or skipped. Reason: ${regexResult.reason || 'N/A'}. Invoking Gemini fallback...`);
  
  // Only call Gemini if the message contains potential gold trade terms (to avoid wasting API limits on pure chit-chat)
  const upperText = text.toUpperCase();
  const mentionsGold = upperText.includes('XAUUSD') || upperText.includes('GOLD');
  const mentionsDirection = upperText.includes('BUY') || upperText.includes('SELL') || text.includes('🟢') || text.includes('🔴');

  if (mentionsGold && mentionsDirection) {
    return await parseWithGemini(text);
  }

  return { isSignal: false, reason: 'Ignore: Lacks basic gold & buy/sell keywords. Skipped Gemini.' };
}
