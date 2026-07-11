# WhatsApp Gold-Signal Auto-Trader 🤖📈

A personal gold-signal listener, parser, and execution bot for MetaTrader 5 (MT5). The bot scans incoming WhatsApp messages in real-time, extracts trading signals for Gold (XAUUSD), runs a staleness and Risk-to-Reward (R:R) validator, calculates custom lot sizes based on account balance, and executes orders immediately.

## Features
* **WhatsApp Group Listener:** Real-time event monitoring using Baileys and lightweight local-session credentials.
* **Hybrid Parser:** Fast regex-first search with a Gemini API JSON fallback for conversational/narrative signals.
* **Staleness Protection Gate:** Rejects signals if the live Gold price has moved more than 30 pips away from the entry zone.
* **Validation Layer:** Enforces proper BUY/SELL stop loss and target profit layouts, and requires a minimum R:R of 1.5 computed against TP1.
* **Smart Lot-Sizer:** Dynamically queries account balance and risks a fixed percentage (e.g., 2%) off Stop Loss distance (Contract size = 100).
* **Multi-TP Splitting:** Automatically splits positions into multiple orders to set distinct TP1, TP2, and TP3 targets in MT5.
* **Dual Execution Pathways:**
  1. **Direct Push Mode (Fastest):** Immediate order placement in MetaTrader 5 via the Python API (<10ms latency).
  2. **EA Polling Mode:** Queues trades in a local SQLite database for the Expert Advisor (`GreatFxBot_Subscriber.mq5`) to pull.
* **Owner Pings:** Sends execution alerts directly back to your phone on WhatsApp and Telegram.

## Project Structure
```
├── src/
│   ├── bot.ts           # Orchestrator & WhatsApp listener
│   ├── parser.ts        # Regex & Gemini fallback parser
│   ├── price.ts         # Live gold tick feed
│   ├── validator.ts     # Staleness, R:R & lot-sizing
│   ├── types.ts         # TypeScript models
│   └── utils.ts         # Telegram/WhatsApp alerts
├── relay/
│   ├── main.py          # FastAPI server (MT5 execution & polling)
│   ├── database.py      # SQLite manager
│   └── models.py        # Pydantic schemas
├── mql5/
│   └── GreatFxBot_Subscriber.mq5  # MT5 Subscriber EA (Polling)
└── tests/
    └── test_parser.ts   # Parser test runner
```

## Getting Started

### 1. Setup Environment
Copy `.env.example` to `.env` and fill in your keys:
```ini
GEMINI_API_KEY=your_gemini_api_key
SIGNAL_GROUP_JID=all
RELAY_SERVER_URL=http://127.0.0.1:8000
RISK_PERCENT=2.0
OWNER_PHONE=your_whatsapp_phone_number
```

### 2. Start the FastAPI Relay Server
Activate your Python environment and start the uvicorn server:
```bash
uvicorn relay.main:app --reload --host 127.0.0.1 --port 8000
```

### 3. Start the WhatsApp Bot
Install dependencies and run the listener:
```bash
npm install
npm start
```
Scan the terminal QR code using your WhatsApp to login.
