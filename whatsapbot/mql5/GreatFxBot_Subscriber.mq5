//+------------------------------------------------------------------+
//|                                         GreatFxBot_Subscriber.mq5 |
//|                                  Built by The Great One | Gr8a5t |
//|                                  https://github.com/Gr8a5t       |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, GreatFxBot"
#property link      "https://github.com/Gr8a5t"
#property version   "1.00"
#property description "GreatFxBot Subscriber EA - Polls relay server, manages risk, and copies trades"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Enums
enum ENUM_LOT_MODE
{
   LOT_FIXED = 0,         // Fixed Lot Size
   LOT_PROPORTIONAL = 1,  // Proportional to Master Balance
   LOT_RISK_PERCENT = 2,  // Risk Percentage of Balance
   LOT_COPY_MASTER = 3    // Copy Signal Lot Size (Calculated by Bot)
};

//--- Input Parameters
input string         InpRelayServerURL    = "http://127.0.0.1:8001";      // Relay Server Base URL
input string         InpSubscriberID      = "SUB_001";                     // Subscriber Unique ID
input string         InpLicenseKey        = "GREAT-FX-DEMO-KEY";          // Subscription License Key
input ENUM_LOT_MODE  InpLotMode           = LOT_COPY_MASTER;              // Lot Sizing Mode
input double         InpFixedLot          = 0.01;                         // Fixed Lot Size (for Fixed/Proportional base)
input double         InpRiskPercent       = 2.0;                          // Risk % Per Trade (Risk Mode)
input double         InpMaxDailyDrawdown  = 5.0;                          // Max Daily Drawdown (%)
input int            InpMaxOpenTrades     = 3;                            // Max Open Positions
input double         InpMinEquity         = 5.0;                          // Min Equity to Allow Trading
input double         InpMaxFloatingLoss   = 5.0;                          // Max Allowed Floating Loss (0 = Disabled)
input bool           InpUseLimitOrders    = false;                        // Use Limit Orders (False = Market Orders)
input double         InpMaxSlippagePips   = 10.0;                         // Max Entry Slippage in Pips (Market Mode)
input int            InpPollIntervalMs    = 200;                          // Server Poll Interval (milliseconds)
input ulong          InpMagicNumber       = 987654;                       // Subscriber Magic Number
input int            InpHttpTimeoutMs     = 5000;                         // HTTP Timeout (milliseconds)

//--- Structure to track subscriber's active positions
struct CopiedPosition
{
   ulong    sub_ticket;
   ulong    master_ticket;
   string   symbol;
   int      type;
   double   volume;
   double   profit;
};

//--- Global variables
CopiedPosition g_copied_positions[];
int            g_copied_count = 0;
datetime       g_last_poll_time = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("GreatFxBot Subscriber EA initializing...");
   
   trade.SetExpertMagicNumber(InpMagicNumber);
   
   if(StringLen(InpRelayServerURL) == 0 || StringLen(InpSubscriberID) == 0)
   {
      Print("Error: Relay Server URL and Subscriber ID must be set!");
      return(INIT_FAILED);
   }
   
   // Set timer for polling
   if(!EventSetMillisecondTimer(InpPollIntervalMs))
   {
      Print("Error: Failed to create millisecond timer!");
      return(INIT_FAILED);
   }
   
   // Synchronize existing copied positions from comment metadata
   SyncLocalPositions(true);
   
   Print("GreatFxBot Subscriber EA initialized. Polling server every ", InpPollIntervalMs, " milliseconds.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("GreatFxBot Subscriber EA deinitialized.");
}

//+------------------------------------------------------------------+
//| Check and Enforce Max Floating Loss Protection                   |
//+------------------------------------------------------------------+
void CheckMaxLossProtection()
{
   if(InpMaxFloatingLoss <= 0.0) return;
   
   double open_pnl = 0.0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
      {
         open_pnl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      }
   }
   
   if(open_pnl <= -InpMaxFloatingLoss)
   {
      Print("CRITICAL: Max Floating Loss reached (", DoubleToString(open_pnl, 2), " <= -", DoubleToString(InpMaxFloatingLoss, 2), "). Closing all positions.");
      
      // Loop backwards to safely close all positions
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
         {
            trade.PositionClose(ticket);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Timer event handler                                              |
//+------------------------------------------------------------------+
void OnTimer()
{
   // Check local positions to detect closures and report performance
   SyncLocalPositions(false);
   
   // Check Max Floating Loss Protection
   CheckMaxLossProtection();
   
   // Poll server for new signals
   PollServer();
}

//+------------------------------------------------------------------+
//| Polls the relay server for pending trade signals                 |
//+------------------------------------------------------------------+
void PollServer()
{
   char data[];
   char result[];
   string result_headers;
   
   // Construct URL with Subscriber ID and License Key
   string url = StringFormat("%s/signals/%s?license=%s&balance=%.2f&equity=%.2f", InpRelayServerURL, InpSubscriberID, InpLicenseKey, AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY));
   
   ResetLastError();
   // GET request
   int res = WebRequest("GET", url, "", InpHttpTimeoutMs, data, result, result_headers);
   
   if(res == -1)
   {
      int err = GetLastError();
      Print("Poll WebRequest failed. Error: ", err);
      return;
   }
   
   if(res == 403)
   {
      Print("CRITICAL: License key validation failed on server. Trading disabled.");
      return;
   }
   
   if(res >= 200 && res < 300)
   {
      string response_text = CharArrayToString(result);
      if(StringLen(response_text) > 2 && response_text != "[]" && response_text != "null")
      {
         // Parse and execute signals
         int start_pos = 0;
         while(true)
         {
            int obj_start = StringFind(response_text, "{", start_pos);
            if(obj_start == -1) break;
            int obj_end = StringFind(response_text, "}", obj_start);
            if(obj_end == -1) break;
            
            string signal_json = StringSubstr(response_text, obj_start, obj_end - obj_start + 1);
            ProcessSignal(signal_json);
            
            start_pos = obj_end + 1;
         }
      }
   }
   else
   {
      Print("Poll Server returned error status: ", res, ". Response: ", CharArrayToString(result));
   }
}

//+------------------------------------------------------------------+
//| Process an individual JSON signal                                |
//+------------------------------------------------------------------+
void ProcessSignal(string json)
{
   string event_type = "";
   string ticket_str = "";
   string symbol = "";
   string direction = "";
   string entry_str = "";
   string sl_str = "";
   string tp_str = "";
   string lot_str = "";
   string balance_str = "";
   
   GetJsonStringValue(json, "event", event_type);
   GetJsonStringValue(json, "ticket", ticket_str);
   GetJsonStringValue(json, "symbol", symbol);
   symbol = GetLocalSymbol(symbol);
   GetJsonStringValue(json, "direction", direction);
   GetJsonStringValue(json, "entry", entry_str);
   GetJsonStringValue(json, "sl", sl_str);
   GetJsonStringValue(json, "tp", tp_str);
   GetJsonStringValue(json, "lot", lot_str);
   GetJsonStringValue(json, "master_balance", balance_str);
   
   ulong  master_ticket  = StringToInteger(ticket_str);
   double master_entry   = StringToDouble(entry_str);
   double master_sl      = StringToDouble(sl_str);
   double master_tp      = StringToDouble(tp_str);
   double master_lot     = StringToDouble(lot_str);
   double master_balance = StringToDouble(balance_str);
   
   if(master_ticket <= 0) return;
   
   // Check if we already have this signal processed
   ulong local_position_ticket = GetLocalPositionByMasterTicket(master_ticket);
   
   if(event_type == "OPEN")
   {
      if(local_position_ticket > 0)
      {
         // Trade already copied, skip
         return;
      }
      
      // Execute Risk Validation
      if(!ValidateRiskSettings())
      {
         Print("Trade block: Risk checks failed.");
         SendBlockedNotification(master_ticket, "Risk validation failed");
         return;
      }
      
      // Calculate Lot Size
      double lot = CalculateLotSize(symbol, direction, master_entry, master_sl, master_lot, master_balance);
      if(lot <= 0)
      {
         Print("Trade block: Calculated lot size is 0 or invalid.");
         return;
      }
      
      // Execute the order
      ExecuteOpen(master_ticket, symbol, direction, master_entry, master_sl, master_tp, lot);
   }
   else if(event_type == "CLOSE")
   {
      if(local_position_ticket > 0)
      {
         ExecuteClose(local_position_ticket, master_ticket);
      }
   }
   else if(event_type == "UPDATE")
   {
      if(local_position_ticket > 0)
      {
         ExecuteModify(local_position_ticket, master_sl, master_tp);
      }
   }
}

//+------------------------------------------------------------------+
//| Execute Open Order                                               |
//+------------------------------------------------------------------+
void ExecuteOpen(ulong master_ticket, string symbol, string direction, double entry, double sl, double tp, double lot)
{
   string comment = StringFormat("master_ticket:%I64u", master_ticket);
   bool success = false;
   
    if(InpUseLimitOrders)
    {
       if(direction == "BUY")
       {
          success = trade.BuyLimit(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
       }
       else
       {
          success = trade.SellLimit(lot, entry, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
       }
       Print("Placed Limit Order for master ticket ", master_ticket, ", success=", success);
    }
   else
   {
      // Market order execution
      double current_price = (direction == "BUY") ? SymbolInfoDouble(symbol, SYMBOL_ASK) : SymbolInfoDouble(symbol, SYMBOL_BID);
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0)
      {
         Print("Error: Point size is 0 for ", symbol, ". Cannot calculate slippage. Blocking entry.");
         SendBlockedNotification(master_ticket, "Zero point size on symbol");
         return;
      }
      double diff_pips = MathAbs(current_price - entry) / (point * 10);
      
      if(diff_pips > InpMaxSlippagePips)
      {
         Print("Trade Blocked: Slippage exceeds limit. Market: ", current_price, " Entry: ", entry, " Diff: ", diff_pips, " pips");
         SendBlockedNotification(master_ticket, StringFormat("Slippage limit exceeded: %.1f pips", diff_pips));
         return;
      }
      
      if(direction == "BUY")
      {
         success = trade.Buy(lot, symbol, current_price, sl, tp, comment);
      }
      else
      {
         success = trade.Sell(lot, symbol, current_price, sl, tp, comment);
      }
      Print("Executed Market Order for master ticket ", master_ticket, ", success=", success);
   }
   
   if(success)
   {
      // Sync immediately to update cache
      SyncLocalPositions(false);
   }
}

//+------------------------------------------------------------------+
//| Execute Close Order                                              |
//+------------------------------------------------------------------+
void ExecuteClose(ulong local_ticket, ulong master_ticket)
{
   Print("Closing copied position: Local Ticket ", local_ticket, " Master Ticket ", master_ticket);
   bool success = trade.PositionClose(local_ticket);
   if(success)
   {
      SyncLocalPositions(false);
   }
}

//+------------------------------------------------------------------+
//| Execute Modification (SL/TP updates)                             |
//+------------------------------------------------------------------+
void ExecuteModify(ulong local_ticket, double sl, double tp)
{
   Print("Modifying copied position: Local Ticket ", local_ticket, " New SL=", sl, " New TP=", tp);
   bool success = trade.PositionModify(local_ticket, sl, tp);
}

//+------------------------------------------------------------------+
//| Risk Validation                                                  |
//+------------------------------------------------------------------+
bool ValidateRiskSettings()
{
   // 1. Min Equity Check
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(equity < InpMinEquity)
   {
      Print("Risk Check Fail: Equity (", equity, ") is below minimum allowed (", InpMinEquity, ")");
      return false;
   }
   
   // 2. Max Open Trades Check
   int current_open = 0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
      {
         current_open++;
      }
   }
   if(current_open >= InpMaxOpenTrades)
   {
      Print("Risk Check Fail: Maximum open trades limit reached (", InpMaxOpenTrades, ")");
      return false;
   }
   
   // 3. Daily Drawdown Check
   datetime today_start = TimeCurrent() - (TimeCurrent() % 86400); // 00:00 server time
   HistorySelect(today_start, TimeCurrent() + 60);
   int total_deals = HistoryDealsTotal();
   
   double realized_pnl = 0.0;
   for(int i = 0; i < total_deals; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(deal > 0)
      {
         long magic = HistoryDealGetInteger(deal, DEAL_MAGIC);
         if(magic == InpMagicNumber)
         {
            realized_pnl += HistoryDealGetDouble(deal, DEAL_PROFIT) +
                            HistoryDealGetDouble(deal, DEAL_COMMISSION) +
                            HistoryDealGetDouble(deal, DEAL_SWAP);
         }
      }
   }
   
   double open_pnl = 0.0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
      {
         open_pnl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      }
   }
   
   double today_pnl = realized_pnl + open_pnl;
   double initial_equity = equity - today_pnl;
   
   if(today_pnl < 0 && initial_equity > 0)
   {
      double drawdown_pct = (MathAbs(today_pnl) / initial_equity) * 100.0;
      if(drawdown_pct >= InpMaxDailyDrawdown)
      {
         Print("Risk Check Fail: Daily drawdown (", DoubleToString(drawdown_pct, 2), "%) exceeds limit (", InpMaxDailyDrawdown, "%)");
         return false;
      }
   }
   
   return true;
}

//+------------------------------------------------------------------+
//| Calculate Lot Size                                               |
//+------------------------------------------------------------------+
double CalculateLotSize(string symbol, string direction, double entry, double sl, double master_lot, double master_balance)
{
   double lot_step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double min_lot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double max_lot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   
   if(lot_step <= 0 || min_lot <= 0)
   {
      Print("Error: Invalid volume settings for ", symbol, " (lot_step=", lot_step, ", min_lot=", min_lot, "). Defaulting to fixed lot.");
      return InpFixedLot > 0 ? InpFixedLot : 0.01;
   }
   
   double lot = InpFixedLot;
   
   if(InpLotMode == LOT_COPY_MASTER)
   {
      lot = master_lot;
   }
   else if(InpLotMode == LOT_PROPORTIONAL)
   {
      if(master_balance > 0)
      {
         lot = master_lot * (balance / master_balance);
      }
      else
      {
         lot = InpFixedLot;
      }
   }
   else if(InpLotMode == LOT_RISK_PERCENT)
   {
      double sl_distance = MathAbs(entry - sl);
      if(sl_distance > 0 && sl > 0)
      {
         double tick_size  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
         double tick_value = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
         
         if(tick_size <= 0 || tick_value <= 0)
         {
            Print("Warning: Invalid tick size or tick value. Fallback to min lot.");
            lot = min_lot;
         }
         else
         {
            double risk_amount = balance * (InpRiskPercent / 100.0);
            double sl_ticks    = sl_distance / tick_size;
            double risk_per_lot = sl_ticks * tick_value;
            
            if(risk_per_lot > 0)
            {
               lot = risk_amount / risk_per_lot;
            }
            else
            {
               lot = min_lot;
            }
         }
      }
      else
      {
         Print("Warning: SL distance is 0 or invalid. Defaulting to min lot.");
         lot = min_lot;
      }
   }
   
   // Perform rounding to closest lot step and clamp limits
   lot = MathFloor(lot / lot_step) * lot_step;
   if(lot < min_lot) lot = min_lot;
   if(lot > max_lot) lot = max_lot;
   
   return lot;
}

//+------------------------------------------------------------------+
//| Helper: Get Local Position Ticket by Master Ticket               |
//+------------------------------------------------------------------+
ulong GetLocalPositionByMasterTicket(ulong master_ticket)
{
   for(int i = 0; i < g_copied_count; i++)
   {
      if(g_copied_positions[i].master_ticket == master_ticket)
      {
         return g_copied_positions[i].sub_ticket;
      }
   }
   return 0;
}

//+------------------------------------------------------------------+
//| Get ISO 8601 UTC timestamp                                       |
//+------------------------------------------------------------------+
string GetISOTimestamp()
{
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ", dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
}

//+------------------------------------------------------------------+
//| Send performance report to relay server                           |
//+------------------------------------------------------------------+
void SendPerformanceReport(ulong master_ticket, string symbol, string direction, double lot, double profit)
{
   char data[];
   char result[];
   string result_headers;
   
   string json = StringFormat("{\n"
                              "  \"subscriber_id\": \"%s\",\n"
                              "  \"master_ticket\": %I64u,\n"
                              "  \"symbol\": \"%s\",\n"
                              "  \"direction\": \"%s\",\n"
                              "  \"lot\": %.3f,\n"
                              "  \"profit\": %.2f,\n"
                              "  \"timestamp\": \"%s\"\n"
                              "}",
                              InpSubscriberID, master_ticket, symbol, direction, lot, profit, GetISOTimestamp());
                              
   StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   int data_size = ArraySize(data);
   if(data_size > 0 && data[data_size - 1] == 0) ArrayResize(data, data_size - 1);
   
   string url = StringFormat("%s/performance/%s", InpRelayServerURL, InpSubscriberID);
   string headers = "Content-Type: application/json\r\n";
   
   WebRequest("POST", url, headers, InpHttpTimeoutMs, data, result, result_headers);
}

//+------------------------------------------------------------------+
//| Send blocked notification to relay server                        |
//+------------------------------------------------------------------+
void SendBlockedNotification(ulong master_ticket, string reason)
{
   char data[];
   char result[];
   string result_headers;
   
   string json = StringFormat("{\n"
                              "  \"subscriber_id\": \"%s\",\n"
                              "  \"master_ticket\": %I64u,\n"
                              "  \"reason\": \"%s\",\n"
                              "  \"timestamp\": \"%s\"\n"
                              "}",
                              InpSubscriberID, master_ticket, reason, GetISOTimestamp());
                              
   StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   int data_size = ArraySize(data);
   if(data_size > 0 && data[data_size - 1] == 0) ArrayResize(data, data_size - 1);
   
   string url = StringFormat("%s/blocked/%s", InpRelayServerURL, InpSubscriberID);
   string headers = "Content-Type: application/json\r\n";
   
   WebRequest("POST", url, headers, InpHttpTimeoutMs, data, result, result_headers);
}

//+------------------------------------------------------------------+
//| Synchronize current copied positions and report closed positions |
//+------------------------------------------------------------------+
void SyncLocalPositions(bool is_initial_load)
{
   int total_positions = PositionsTotal();
   CopiedPosition current_pos[];
   int current_count = 0;
   
   for(int i = 0; i < total_positions; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         long magic = PositionGetInteger(POSITION_MAGIC);
         if(magic == InpMagicNumber)
         {
            string comment = PositionGetString(POSITION_COMMENT);
            int idx = StringFind(comment, "master_ticket:");
            if(idx != -1)
            {
               ulong master_ticket = (ulong)StringToInteger(StringSubstr(comment, idx + 14));
               if(master_ticket > 0)
               {
                  ArrayResize(current_pos, current_count + 1);
                  current_pos[current_count].sub_ticket    = ticket;
                  current_pos[current_count].master_ticket = master_ticket;
                  current_pos[current_count].symbol        = PositionGetString(POSITION_SYMBOL);
                  current_pos[current_count].type          = (int)PositionGetInteger(POSITION_TYPE);
                  current_pos[current_count].volume        = PositionGetDouble(POSITION_VOLUME);
                  current_pos[current_count].profit        = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
                  current_count++;
               }
            }
         }
      }
   }
   
   if(is_initial_load)
   {
      ArrayResize(g_copied_positions, current_count);
      for(int i = 0; i < current_count; i++)
      {
         g_copied_positions[i] = current_pos[i];
      }
      g_copied_count = current_count;
      Print("Initial load: Tracking ", g_copied_count, " subscriber positions.");
      return;
   }
   
   // Find closed positions (present in g_copied_positions, absent in current_pos)
   for(int i = 0; i < g_copied_count; i++)
   {
      bool found = false;
      for(int j = 0; j < current_count; j++)
      {
         if(g_copied_positions[i].sub_ticket == current_pos[j].sub_ticket)
         {
            found = true;
            break;
         }
      }
      if(!found)
      {
         Print("Copied position closed: Local Ticket ", g_copied_positions[i].sub_ticket, " Master Ticket ", g_copied_positions[i].master_ticket);
         
         double closed_profit = g_copied_positions[i].profit;
         if(HistorySelectByPosition(g_copied_positions[i].sub_ticket))
         {
            int total_deals = HistoryDealsTotal();
            for(int k = 0; k < total_deals; k++)
            {
               ulong deal_ticket = HistoryDealGetTicket(k);
               if(deal_ticket > 0)
               {
                  long entry_type = HistoryDealGetInteger(deal_ticket, DEAL_ENTRY);
                  if(entry_type == DEAL_ENTRY_OUT || entry_type == DEAL_ENTRY_OUT_BY)
                  {
                     closed_profit = HistoryDealGetDouble(deal_ticket, DEAL_PROFIT) + 
                                     HistoryDealGetDouble(deal_ticket, DEAL_COMMISSION) + 
                                     HistoryDealGetDouble(deal_ticket, DEAL_SWAP);
                     break;
                  }
               }
            }
         }
         
         string dir = (g_copied_positions[i].type == POSITION_TYPE_BUY) ? "BUY" : "SELL";
         SendPerformanceReport(g_copied_positions[i].master_ticket, g_copied_positions[i].symbol, dir, g_copied_positions[i].volume, closed_profit);
      }
   }
   
   // Update the global cache
   ArrayResize(g_copied_positions, current_count);
   for(int i = 0; i < current_count; i++)
   {
      g_copied_positions[i] = current_pos[i];
   }
   g_copied_count = current_count;
}

//+------------------------------------------------------------------+
//| Simple JSON string parsing helper                                |
//+------------------------------------------------------------------+
bool GetJsonStringValue(const string json, const string key, string &value)
{
   string search_key = "\"" + key + "\"";
   int key_pos = StringFind(json, search_key);
   if(key_pos == -1) return false;
   
   int val_start = StringFind(json, ":", key_pos + StringLen(search_key));
   if(val_start == -1) return false;
   
   val_start++; // Move past ":"
   while(val_start < StringLen(json) && (StringGetCharacter(json, val_start) == ' ' || StringGetCharacter(json, val_start) == '\t'))
      val_start++;
      
   if(val_start >= StringLen(json)) return false;
   
   ushort first_char = StringGetCharacter(json, val_start);
   if(first_char == '"')
   {
      val_start++; // skip opening quote
      int val_end = StringFind(json, "\"", val_start);
      if(val_end == -1) return false;
      value = StringSubstr(json, val_start, val_end - val_start);
      return true;
   }
   else
   {
      int val_end = val_start;
      while(val_end < StringLen(json))
      {
         ushort c = StringGetCharacter(json, val_end);
         if(c == ',' || c == '}' || c == ']' || c == '\n' || c == '\r' || c == ' ')
            break;
         val_end++;
      }
      value = StringSubstr(json, val_start, val_end - val_start);
      // Trim spaces
      StringTrimLeft(value);
      StringTrimRight(value);
      return true;
   }
}

//+------------------------------------------------------------------+
//| Map master symbol dynamically to the local broker's symbol       |
//+------------------------------------------------------------------+
string GetLocalSymbol(string master_symbol)
{
   bool is_custom = false;
   if(SymbolExist(master_symbol, is_custom))
      return master_symbol;
      
   string clean_symbol = master_symbol;
   StringToUpper(clean_symbol);
   
   // Strip common prefixes
   if(StringFind(clean_symbol, "ECN-") == 0) clean_symbol = StringSubstr(clean_symbol, 4);
   if(StringFind(clean_symbol, "PRO-") == 0) clean_symbol = StringSubstr(clean_symbol, 4);
   
   // Determine base symbol
   string base_symbol = clean_symbol;
   if(StringFind(clean_symbol, "XAUUSD") != -1 || StringFind(clean_symbol, "GOLD") != -1)
      base_symbol = "XAUUSD";
   else if(StringFind(clean_symbol, "EURUSD") != -1)
      base_symbol = "EURUSD";
      
   // Try base matching first with common suffixes
   if(base_symbol == "XAUUSD")
   {
      string gold_names[] = {"XAUUSDm", "XAUUSD.m", "XAUUSD", "GOLD", "GOLDm", "GOLD.m", "XAUUSD.ecn", "XAUUSD.pro", "XAUUSD.raw", "XAUUSD+i"};
      for(int i = 0; i < ArraySize(gold_names); i++)
      {
         if(SymbolExist(gold_names[i], is_custom))
            return gold_names[i];
      }
   }
   else if(base_symbol == "EURUSD")
   {
      string eurusd_names[] = {"EURUSDm", "EURUSD.m", "EURUSD", "EURUSD.ecn", "EURUSD.pro", "EURUSD.raw", "EURUSD+i"};
      for(int i = 0; i < ArraySize(eurusd_names); i++)
      {
         if(SymbolExist(eurusd_names[i], is_custom))
            return eurusd_names[i];
      }
   }
   
   // Scan selected symbols (Market Watch) using base symbol
   int total_selected = SymbolsTotal(true);
   for(int i = 0; i < total_selected; i++)
   {
      string sym = SymbolName(i, true);
      string sym_upper = sym;
      StringToUpper(sym_upper);
      if(StringFind(sym_upper, base_symbol) != -1 || StringFind(base_symbol, sym_upper) != -1)
      {
         return sym;
      }
   }
   
   // Scan all broker symbols using base symbol
   int total_all = SymbolsTotal(false);
   for(int i = 0; i < total_all; i++)
   {
      string sym = SymbolName(i, false);
      string sym_upper = sym;
      StringToUpper(sym_upper);
      if(StringFind(sym_upper, base_symbol) != -1 || StringFind(base_symbol, sym_upper) != -1)
      {
         SymbolSelect(sym, true);
         return sym;
      }
   }
   
   return master_symbol;
}
