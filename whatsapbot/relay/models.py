from pydantic import BaseModel, Field
from typing import Optional, List

class SignalCreate(BaseModel):
    event: str  # OPEN, CLOSE, UPDATE
    ticket: int
    symbol: str
    direction: str  # BUY, SELL
    entry: float
    exit_price: Optional[float] = None
    sl: float
    tp: float
    lot: float
    profit: Optional[float] = 0.0
    timestamp: str
    master_id: str

class SubscriberCreate(BaseModel):
    subscriber_id: str
    telegram_chat_id: Optional[str] = None
    license_key: str
    lot_mode: Optional[str] = "FIXED"  # FIXED, PROPORTIONAL, RISK_PERCENT
    fixed_lot: Optional[float] = 0.01
    risk_percent: Optional[float] = 2.0
    max_daily_drawdown_pct: Optional[float] = 5.0
    max_open_trades: Optional[int] = 3
    min_equity: Optional[float] = 100.0
    use_limit_orders: Optional[bool] = False

class LicenseCreate(BaseModel):
    key: str
    subscriber_id: Optional[str] = None
    tier: Optional[str] = "LAUNCH"  # LAUNCH, STANDARD, PREMIUM
    expires_at: str  # YYYY-MM-DD format or ISO

class PerformanceCreate(BaseModel):
    subscriber_id: str
    master_ticket: int
    symbol: str
    direction: str
    lot: float
    profit: float
    timestamp: str

class BlockedCreate(BaseModel):
    subscriber_id: str
    master_ticket: int
    reason: str
    timestamp: str

class SubscriberResponse(BaseModel):
    subscriber_id: str
    telegram_chat_id: Optional[str]
    license_key: str
    lot_mode: str
    fixed_lot: float
    risk_percent: float
    max_daily_drawdown_pct: float
    max_open_trades: int
    min_equity: float
    use_limit_orders: bool
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True
