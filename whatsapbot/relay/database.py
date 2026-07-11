import sqlite3
import os

# Put database file directly in the whatsapbot folder
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("GREATFXBOT_DB_PATH", os.path.join(BASE_DIR, "whatsapbot.db"))

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    # Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Create licenses table first (due to foreign key)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS licenses (
        key TEXT PRIMARY KEY,
        subscriber_id TEXT,
        tier TEXT DEFAULT 'LAUNCH',
        expires_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
    );
    """)

    # 2. Create subscribers table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS subscribers (
        subscriber_id TEXT PRIMARY KEY,
        telegram_chat_id TEXT,
        license_key TEXT,
        lot_mode TEXT DEFAULT 'FIXED',
        fixed_lot REAL DEFAULT 0.01,
        risk_percent REAL DEFAULT 2.0,
        max_daily_drawdown_pct REAL DEFAULT 5.0,
        max_open_trades INTEGER DEFAULT 3,
        min_equity REAL DEFAULT 100.0,
        use_limit_orders INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        last_balance REAL DEFAULT 0.0,
        last_equity REAL DEFAULT 0.0,
        last_seen TEXT,
        FOREIGN KEY(license_key) REFERENCES licenses(key)
    );
    """)
    
    # Upgrade existing database if columns don't exist
    try:
        cursor.execute("ALTER TABLE subscribers ADD COLUMN last_balance REAL DEFAULT 0.0;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE subscribers ADD COLUMN last_equity REAL DEFAULT 0.0;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE subscribers ADD COLUMN last_seen TEXT;")
    except sqlite3.OperationalError:
        pass
    
    # 3. Create signals table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        master_ticket INTEGER NOT NULL,
        event TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        exit_price REAL,
        sl REAL,
        tp REAL,
        lot REAL NOT NULL,
        master_balance REAL NOT NULL,
        timestamp TEXT NOT NULL
    );
    """)
    
    # 4. Create pending_signals queue table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS pending_signals (
        subscriber_id TEXT NOT NULL,
        signal_id INTEGER NOT NULL,
        PRIMARY KEY (subscriber_id, signal_id),
        FOREIGN KEY(subscriber_id) REFERENCES subscribers(subscriber_id) ON DELETE CASCADE,
        FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE CASCADE
    );
    """)
    
    # 5. Create performance table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id TEXT NOT NULL,
        master_ticket INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        lot REAL NOT NULL,
        profit REAL NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(subscriber_id) REFERENCES subscribers(subscriber_id) ON DELETE CASCADE
    );
    """)
    
    # 6. Create blocked trades table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS blocked_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscriber_id TEXT NOT NULL,
        master_ticket INTEGER NOT NULL,
        reason TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(subscriber_id) REFERENCES subscribers(subscriber_id) ON DELETE CASCADE
    );
    """)
    
    # Create indexes for fast querying
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_pending_sub ON pending_signals(subscriber_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_perf_sub ON performance(subscriber_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_signals_ticket ON signals(master_ticket);")
    
    conn.commit()
    conn.close()
    print("[DB] SQLite database tables initialized successfully.")

if __name__ == "__main__":
    init_db()
