from fastapi import FastAPI, HTTPException, Depends, Query
from typing import List, Optional
import sqlite3
import os
import threading
import urllib.request
import urllib.parse
import json
from datetime import datetime

# Try to import MetaTrader5 for direct push execution
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    class MockMT5:
        TRADE_ACTION_DEAL = 1
        ORDER_TYPE_BUY = 0
        ORDER_TYPE_SELL = 1
        ORDER_TIME_GTC = 0
        ORDER_FILL_FOK = 0
        TRADE_RETCODE_DONE = 10009
        def terminal_info(self): return None
        def last_error(self): return (0, "Mock MT5 - Package Not Installed")
    mt5 = MockMT5()
    MT5_AVAILABLE = False

from relay.database import get_db_connection, init_db
from relay.models import (
    SignalCreate,
    SubscriberCreate,
    LicenseCreate,
    PerformanceCreate,
    BlockedCreate,
    SubscriberResponse
)

app = FastAPI(title="WhatsApp Gold Signal Relay Server", version="1.0.0")

# In-memory cache for live symbol prices from polling EAs
LATEST_PRICES = {}

def send_telegram_message(chat_id: str, text: str):
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not bot_token or not chat_id:
        return
        
    def _do_send():
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        try:
            req_data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                response.read()
        except Exception as e:
            print(f"[NOTIFY] Error sending Telegram notification: {e}")
            
    threading.Thread(target=_do_send, daemon=True).start()

# Helper: Database connection dependency
def get_db():
    conn = get_db_connection()
    try:
        yield conn
    finally:
        conn.close()

def seed_defaults(conn: sqlite3.Connection):
    cursor = conn.cursor()
    created_at = datetime.utcnow().isoformat() + "Z"
    try:
        # Pre-seed a default license
        cursor.execute(
            "INSERT OR IGNORE INTO licenses (key, tier, expires_at, created_at) VALUES (?, ?, ?, ?)",
            ("GREAT-FX-DEMO-KEY", "LAUNCH", "2030-12-31T00:00:00Z", created_at)
        )
        # Pre-seed a default subscriber
        cursor.execute(
            """
            INSERT OR IGNORE INTO subscribers (
                subscriber_id, license_key, lot_mode, fixed_lot, risk_percent, created_at, last_balance, last_equity, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("SUB_001", "GREAT-FX-DEMO-KEY", "RISK_PERCENT", 0.01, 2.0, created_at, 1000.0, 1000.0, 1)
        )
        conn.commit()
    except sqlite3.Error as e:
        print(f"[DB] Error seeding default configs: {e}")

@app.on_event("startup")
def startup_event():
    # Setup database
    init_db()
    
    # Seed default subscriber & license
    conn = get_db_connection()
    seed_defaults(conn)
    conn.close()

    # Try connecting directly to MT5 terminal
    if MT5_AVAILABLE:
        login_str = os.environ.get("MT5_LOGIN", "")
        password = os.environ.get("MT5_PASSWORD", "")
        server = os.environ.get("MT5_SERVER", "")
        terminal_path = os.environ.get("MT5_TERMINAL_PATH", None)

        if login_str and password and server:
            try:
                login = int(login_str)
                print(f"[MT5] Initializing MetaTrader5 connector for Account {login}...")
                
                init_result = False
                if terminal_path:
                    init_result = mt5.initialize(path=terminal_path, login=login, password=password, server=server)
                else:
                    init_result = mt5.initialize(login=login, password=password, server=server)
                
                if init_result:
                    print(f"[MT5] Successfully connected to terminal. Server: {server}")
                else:
                    print(f"[MT5] Connection failed: {mt5.last_error()}")
            except Exception as e:
                print(f"[MT5] Error initializing connector: {e}")
        else:
            print("[MT5] Terminal credentials not configured. Running without direct push execution.")

@app.on_event("shutdown")
def shutdown_event():
    if MT5_AVAILABLE:
        try:
            mt5.shutdown()
            print("[MT5] Connection shutdown.")
        except Exception:
            pass

# Direct MT5 Trade Execution Helper
def execute_direct_mt5_trade(sig: SignalCreate) -> bool:
    if not MT5_AVAILABLE or mt5.terminal_info() is None:
        return False
        
    symbol = sig.symbol
    suffix = os.environ.get("TARGET_SYMBOL_SUFFIX", "XAUUSDm")
    if "XAUUSD" in symbol.upper() or "GOLD" in symbol.upper():
        symbol = suffix

    mt5.symbol_select(symbol, True)
    
    order_type = mt5.ORDER_TYPE_BUY if sig.direction.upper() == "BUY" else mt5.ORDER_TYPE_SELL
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        print(f"[MT5] Error: Cannot fetch tick for {symbol}")
        return False
        
    price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": sig.lot,
        "type": order_type,
        "price": price,
        "sl": sig.sl,
        "tp": sig.tp,
        "deviation": 20,
        "magic": 987654,
        "comment": f"wa_bot:{sig.ticket}",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILL_FOK,
    }
    
    print(f"[MT5] Sending direct order: {sig.direction} {symbol} {sig.lot} Lots @ {price} (SL: {sig.sl}, TP: {sig.tp})")
    result = mt5.order_send(request)
    
    if result is None:
        print(f"[MT5] Order failed. Error code: {mt5.last_error()}")
        return False
        
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"[MT5] Order rejected. Code: {result.retcode}, Comment: {result.comment}")
        return False
        
    print(f"[MT5] DIRECT PUSH TRADE SUCCESSFUL! Ticket: {result.order}")
    return True

# ----------------- FastAPI Routes -----------------

@app.get("/price")
def get_live_price(symbol: str = "XAUUSDm"):
    """
    Returns the live price of a symbol directly from the MT5 server.
    """
    if MT5_AVAILABLE and mt5.terminal_info() is not None:
        tick = mt5.symbol_info_tick(symbol)
        if tick:
            # Reference price is mid-point of bid and ask
            avg_price = (tick.bid + tick.ask) / 2
            return {
                "symbol": symbol,
                "price": round(avg_price, 2),
                "bid": tick.bid,
                "ask": tick.ask
            }
            
    # Fallback to cached prices from polling EAs
    if symbol in LATEST_PRICES:
        price_data = LATEST_PRICES[symbol]
        # Ensure price is fresh (under 15s)
        if (datetime.utcnow() - price_data["time"]).total_seconds() < 15:
            avg_price = (price_data["bid"] + price_data["ask"]) / 2
            return {
                "symbol": symbol,
                "price": round(avg_price, 2),
                "bid": price_data["bid"],
                "ask": price_data["ask"]
            }
    
    raise HTTPException(status_code=503, detail="MT5 terminal connection unavailable.")

@app.post("/signal", status_code=201)
def receive_signal(sig: SignalCreate, db: sqlite3.Connection = Depends(get_db)):
    """
    Receives signal from WhatsApp bot. Executes directly on MT5 if connected, 
    otherwise queues it for polling EAs.
    """
    cursor = db.cursor()
    try:
        # 1. Save signal to database
        cursor.execute(
            """
            INSERT INTO signals (
                master_ticket, event, symbol, direction, entry, exit_price, sl, tp, lot, master_balance, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sig.ticket,
                sig.event,
                sig.symbol,
                sig.direction,
                sig.entry,
                sig.exit_price,
                sig.sl,
                sig.tp,
                sig.lot,
                0.0,  # master_balance
                sig.timestamp
            )
        )
        signal_id = cursor.lastrowid
        
        # 2. Try direct MT5 execution (Push Mode)
        executed_direct = False
        if sig.event == "OPEN":
            executed_direct = execute_direct_mt5_trade(sig)
            
        # 3. If direct execution didn't run, queue it for polling subscribers
        if not executed_direct:
            cursor.execute("SELECT subscriber_id FROM subscribers WHERE is_active = 1")
            subscribers = cursor.fetchall()
            for sub in subscribers:
                cursor.execute(
                    "INSERT INTO pending_signals (subscriber_id, signal_id) VALUES (?, ?)",
                    (sub["subscriber_id"], signal_id)
                )
        
        db.commit()
        
        # 4. Notify via Telegram
        tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        if tg_chat_id:
            status_tag = "DIRECT PUSH" if executed_direct else "QUEUED FOR EA"
            if sig.event == "OPEN":
                msg = (
                    f"🟢 <b>NEW Gold Trade Alert ({status_tag})</b>\n"
                    f"› Symbol: {sig.symbol}\n"
                    f"› Direction: {sig.direction}\n"
                    f"› Entry: {sig.entry:.2f}\n"
                    f"› Stop Loss: {sig.sl:.2f}\n"
                    f"› Take Profit: {sig.tp:.2f}\n"
                    f"› Lot Size: {sig.lot:.2f}\n"
                    f"› Ticket: #{sig.ticket}"
                )
                send_telegram_message(tg_chat_id, msg)
                
        return {
            "status": "success", 
            "signal_id": signal_id, 
            "direct_push": executed_direct,
            "ticket": sig.ticket
        }
    except sqlite3.Error as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")

@app.get("/signals/{subscriber_id}", response_model=List[dict])
def get_signals(
    subscriber_id: str,
    license: str = Query(..., description="Subscriber license key"),
    balance: Optional[float] = Query(None, description="Subscriber current balance"),
    equity: Optional[float] = Query(None, description="Subscriber current equity"),
    symbol: Optional[str] = Query(None, description="Subscriber current chart symbol"),
    bid: Optional[float] = Query(None, description="Subscriber current bid price"),
    ask: Optional[float] = Query(None, description="Subscriber current ask price"),
    db: sqlite3.Connection = Depends(get_db)
):
    """
    Polling endpoint for subscriber EA to pull pending trade actions.
    """
    cursor = db.cursor()
    
    # Validate subscriber
    cursor.execute("SELECT * FROM subscribers WHERE subscriber_id = ?", (subscriber_id,))
    sub = cursor.fetchone()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscriber not registered")
        
    if sub["license_key"] != license:
        raise HTTPException(status_code=403, detail="Invalid license key")
        
    # Update balance and equity
    if balance is not None and equity is not None:
        last_seen = datetime.utcnow().isoformat() + "Z"
        cursor.execute(
            "UPDATE subscribers SET last_balance = ?, last_equity = ?, last_seen = ? WHERE subscriber_id = ?",
            (balance, equity, last_seen, subscriber_id)
        )
        
    # Cache the latest price if sent by the EA
    if symbol and bid is not None and ask is not None:
        LATEST_PRICES[symbol] = {
            "bid": bid,
            "ask": ask,
            "time": datetime.utcnow()
        }
        
    # Retrieve and clear pending signals
    cursor.execute(
        """
        SELECT s.* FROM pending_signals ps
        JOIN signals s ON ps.signal_id = s.id
        WHERE ps.subscriber_id = ?
        ORDER BY s.id ASC
        """,
        (subscriber_id,)
    )
    rows = cursor.fetchall()
    
    signals = []
    for r in rows:
        signals.append({
            "id": r["id"],
            "event": r["event"],
            "ticket": r["master_ticket"],
            "symbol": r["symbol"],
            "direction": r["direction"],
            "entry": r["entry"],
            "sl": r["sl"],
            "tp": r["tp"],
            "lot": r["lot"],
            "master_balance": r["master_balance"],
            "timestamp": r["timestamp"]
        })
        
    if signals:
        cursor.execute("DELETE FROM pending_signals WHERE subscriber_id = ?", (subscriber_id,))
        
    db.commit()
    return signals

@app.get("/summary/{subscriber_id}")
def get_summary(subscriber_id: str, db: sqlite3.Connection = Depends(get_db)):
    """
    Returns subscriber profile including latest reported balance.
    """
    cursor = db.cursor()
    cursor.execute("SELECT * FROM subscribers WHERE subscriber_id = ?", (subscriber_id,))
    sub = cursor.fetchone()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscriber not found")
        
    cursor.execute("SELECT * FROM performance WHERE subscriber_id = ?", (subscriber_id,))
    perf_rows = cursor.fetchall()
    
    total_trades = len(perf_rows)
    wins = sum(1 for r in perf_rows if r["profit"] > 0)
    net_pnl = sum(r["profit"] for r in perf_rows)
    win_rate = (wins / total_trades * 100.0) if total_trades > 0 else 0.0
    
    return {
        "subscriber_id": subscriber_id,
        "is_active": bool(sub["is_active"]),
        "balance": sub["last_balance"],
        "equity": sub["last_equity"],
        "last_seen": sub["last_seen"],
        "total_trades": total_trades,
        "win_rate": f"{win_rate:.1f}%",
        "net_pnl": round(net_pnl, 2),
        "status": "Active" if sub["is_active"] else "Paused"
    }

@app.post("/performance/{subscriber_id}", status_code=201)
def log_performance(subscriber_id: str, perf: PerformanceCreate, db: sqlite3.Connection = Depends(get_db)):
    cursor = db.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO performance (subscriber_id, master_ticket, symbol, direction, lot, profit, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (perf.subscriber_id, perf.master_ticket, perf.symbol, perf.direction, perf.lot, perf.profit, perf.timestamp)
        )
        db.commit()
        
        # Notify
        tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        if tg_chat_id:
            outcome = "🏆 WIN" if perf.profit >= 0 else "🔴 LOSS"
            msg = (
                f"📊 <b>Trade Closed — Performance Logged</b>\n"
                f"› Symbol: {perf.symbol}\n"
                f"› Lot: {perf.lot:.2f}\n"
                f"› Outcome: {outcome} ({perf.profit:+.2f})\n"
                f"› Account ID: {perf.subscriber_id}"
            )
            send_telegram_message(tg_chat_id, msg)
            
        return {"status": "logged"}
    except sqlite3.Error as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")

@app.post("/blocked/{subscriber_id}", status_code=201)
def log_blocked(subscriber_id: str, block: BlockedCreate, db: sqlite3.Connection = Depends(get_db)):
    cursor = db.cursor()
    try:
        cursor.execute(
            "INSERT INTO blocked_trades (subscriber_id, master_ticket, reason, timestamp) VALUES (?, ?, ?, ?)",
            (block.subscriber_id, block.master_ticket, block.reason, block.timestamp)
        )
        db.commit()
        
        # Notify
        tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        if tg_chat_id:
            msg = (
                f"⚠️ <b>Trade execution BLOCKED on MT5</b>\n"
                f"› Master Ticket: #{block.master_ticket}\n"
                f"› Reason: {block.reason}\n"
                f"› Subscriber: {block.subscriber_id}"
            )
            send_telegram_message(tg_chat_id, msg)
            
        return {"status": "logged"}
    except sqlite3.Error as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
