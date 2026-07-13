import { TradeSignal, ValidationResult } from './types.js';
import dotenv from 'dotenv';
dotenv.config();

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'http://127.0.0.1:8000';
const SUBSCRIBER_ID = process.env.SUBSCRIBER_ID || 'SUB_001';
const MIN_RR = parseFloat(process.env.MIN_RR || '1.5');
const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || '2.0');
const STALENESS_PIPS_LIMIT = parseFloat(process.env.STALENESS_PIPS_LIMIT || '30');
const REFERENCE_PRICE_MODE = process.env.REFERENCE_PRICE_MODE || 'zone_mid';

/**
 * Calculates the reference price based on the signal and configuration mode.
 */
export function getReferencePrice(signal: TradeSignal, receivedAtPrice: number): number {
  switch (REFERENCE_PRICE_MODE.toLowerCase()) {
    case 'receipt':
      return receivedAtPrice;
    case 'zone_low':
      return Math.min(signal.entryMin, signal.entryMax);
    case 'zone_high':
      return Math.max(signal.entryMin, signal.entryMax);
    case 'zone_mid':
    default:
      return (signal.entryMin + signal.entryMax) / 2;
  }
}

/**
 * Checks if the signal has gone stale by comparing current price to the reference price.
 * For Gold, 1 pip = $0.10.
 */
export function checkStaleness(signal: TradeSignal, livePrice: number, receivedAtPrice: number): {
  stale: boolean;
  pips: number;
  refPrice: number;
} {
  const minEntry = Math.min(signal.entryMin, signal.entryMax);
  const maxEntry = Math.max(signal.entryMin, signal.entryMax);

  // If the price is currently inside the entry zone, it is NOT stale
  if (livePrice >= minEntry && livePrice <= maxEntry) {
    return { stale: false, pips: 0, refPrice: livePrice };
  }

  // Otherwise, calculate staleness from the closest edge of the entry zone
  const refPrice = livePrice < minEntry ? minEntry : maxEntry;
  const priceDiff = Math.abs(livePrice - refPrice);
  const pips = priceDiff * 10;
  const stale = pips > STALENESS_PIPS_LIMIT;

  return { stale, pips, refPrice };
}

/**
 * Validates the trade parameters, direction, and R:R based on TP1.
 */
export function validateSignal(signal: TradeSignal): ValidationResult {
  const errors: string[] = [];

  // 1. Sanity check: Pair validation
  if (signal.pair !== 'XAUUSD') {
    errors.push(`Invalid pair: ${signal.pair}. Only gold signals are permitted.`);
  }

  const entryAvg = (signal.entryMin + signal.entryMax) / 2;

  // 2. Directional checks
  if (signal.direction === 'BUY') {
    if (signal.sl >= entryAvg) {
      errors.push(`Stop Loss (${signal.sl}) must be below entry (${entryAvg}) for BUY.`);
    }
    if (signal.tp1 <= entryAvg) {
      errors.push(`Take Profit 1 (${signal.tp1}) must be above entry (${entryAvg}) for BUY.`);
    }
  } else if (signal.direction === 'SELL') {
    if (signal.sl <= entryAvg) {
      errors.push(`Stop Loss (${signal.sl}) must be above entry (${entryAvg}) for SELL.`);
    }
    if (signal.tp1 >= entryAvg) {
      errors.push(`Take Profit 1 (${signal.tp1}) must be below entry (${entryAvg}) for SELL.`);
    }
  } else {
    errors.push(`Invalid direction: ${signal.direction}`);
  }

  // 3. R:R calculation based on TP1 (user's breakeven rule makes TP1 R:R critical)
  const risk = Math.abs(entryAvg - signal.sl);
  const reward = Math.abs(signal.tp1 - entryAvg);
  const rrRatio = risk > 0 ? reward / risk : 0;

  if (rrRatio < MIN_RR) {
    errors.push(`Risk-to-Reward ratio too low (${rrRatio.toFixed(2)} < ${MIN_RR}). Calculated using TP1.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    rrRatio,
    entryPrice: entryAvg
  };
}

/**
 * Queries FastAPI relay server for subscriber balance, falling back to a default value.
 */
async function getAccountBalance(): Promise<number> {
  try {
    const url = `${RELAY_SERVER_URL}/summary/${SUBSCRIBER_ID}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const data: any = await response.json();
      // If we find Net PnL and active state we might get balance, but wait, does summary return balance?
      // Let's check main.py get_summary response or let's query GET /signals/{subscriber_id} to see if it saves balance.
      // Wait, main.py get_summary returns:
      // {"subscriber_id": ..., "total_trades": ..., "win_rate": ..., "profit_factor": ..., "net_pnl": ..., "status": ...}
      // It doesn't return balance directly!
      // But wait! We can add a custom endpoint to our FastAPI relay `/balance/{subscriber_id}` or let `/summary` return balance!
      // Let's make sure `/summary` returns the last updated balance since the database does save it:
      // sub = crud.get_subscriber(db, subscriber_id)
      // Yes! Sub has the balance since the database has a column for it!
      // Let's see: database has balance. We will make our Python FastAPI server return balance in `/summary/{subscriber_id}`.
      // For now, let's fetch it, and if it fails, we fall back to a default.
      if (data && typeof data.balance === 'number') {
        console.log(`[LOTSIZE] Fetched active account balance: $${data.balance}`);
        return data.balance;
      }
    }
  } catch (err) {
    // Ignore, fallback to default below
  }
  
  const defaultBalance = 1000.0;
  console.log(`[LOTSIZE] Could not retrieve balance. Defaulting to: $${defaultBalance}`);
  return defaultBalance;
}

/**
 * Calculates the lot size based on account balance, risk percent, and SL distance.
 * Gold standard contract size = 100.
 */
export async function calculateLotSize(entryPrice: number, slPrice: number): Promise<number> {
  const balance = await getAccountBalance();
  const riskAmount = balance * (RISK_PERCENT / 100);
  const slDistance = Math.abs(entryPrice - slPrice);

  if (slDistance <= 0) {
    return 0.01;
  }

  // Gold lot sizer: riskAmount / (slDistance * ContractSize)
  // ContractSize is 100 for Gold on most major brokers (1 lot = 100 oz)
  const rawLotSize = riskAmount / (slDistance * 100);

  // Round down to 2 decimal places (standard micro lot resolution = 0.01)
  let lotSize = Math.floor(rawLotSize * 100) / 100;

  // Clamp boundaries (min 0.01 lot, max 5.0 lots for safety)
  if (lotSize < 0.01) lotSize = 0.01;
  if (lotSize > 5.00) lotSize = 5.00;

  console.log(`[LOTSIZE] Sizing result: Lot = ${lotSize} (Risk: $${riskAmount.toFixed(2)}, SL Dist: $${slDistance.toFixed(2)})`);
  return lotSize;
}
