import dotenv from 'dotenv';
dotenv.config();

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'http://127.0.0.1:8000';
const TARGET_SYMBOL_SUFFIX = process.env.TARGET_SYMBOL_SUFFIX || 'XAUUSDm';

/**
 * Fetches the live price from the MT5 FastAPI relay server.
 */
async function fetchMT5Price(symbol: string): Promise<number | null> {
  try {
    const url = `${RELAY_SERVER_URL}/price?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); // 3s timeout
    if (!response.ok) {
      return null;
    }
    const data: any = await response.json();
    if (data && typeof data.price === 'number') {
      return data.price;
    }
    return null;
  } catch (err) {
    // Fail silently, fallback will handle it
    return null;
  }
}

/**
 * Fetches the live price from Yahoo Finance as a resilient fallback.
 */
async function fetchYahooPrice(): Promise<number | null> {
  try {
    // GC=F is Gold Futures. XAUUSD=X is Gold Spot.
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d';
    const response = await fetch(url, { 
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof price === 'number') {
      return price;
    }
    return null;
  } catch (err) {
    console.error('[PRICE] Yahoo Finance fallback failed:', err);
    return null;
  }
}

/**
 * Gets the current live price of Gold.
 * Queries MT5 relay server first, falls back to Yahoo Finance if offline.
 */
export async function getLiveGoldPrice(): Promise<number> {
  // Query the actual MT5 broker price first
  const mt5Price = await fetchMT5Price(TARGET_SYMBOL_SUFFIX);
  if (mt5Price !== null) {
    console.log(`[PRICE] Retrieved live price from MT5: ${mt5Price}`);
    return mt5Price;
  }

  console.log('[PRICE] MT5 relay price feed unavailable. Querying Yahoo Finance fallback...');
  const yahooPrice = await fetchYahooPrice();
  if (yahooPrice !== null) {
    console.log(`[PRICE] Retrieved live price from Yahoo Finance: ${yahooPrice}`);
    return yahooPrice;
  }

  throw new Error('Failed to retrieve live gold price from all sources.');
}
