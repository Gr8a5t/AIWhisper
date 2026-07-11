export interface TradeSignal {
  pair: string;          // e.g., "XAUUSD" or "GOLD"
  direction: 'BUY' | 'SELL';
  entryMin: number;      // e.g., 2320.0
  entryMax: number;      // e.g., 2322.0 (same as entryMin if single entry)
  sl: number;            // Stop loss price
  tp1: number;           // Take profit 1 price
  tp2?: number;          // Optional Take profit 2 price
  tp3?: number;          // Optional Take profit 3 price
  rawText?: string;      // The raw message body
}

export interface ParseResult {
  isSignal: boolean;
  signal?: TradeSignal;
  reason?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  rrRatio?: number;
  entryPrice?: number;
}
