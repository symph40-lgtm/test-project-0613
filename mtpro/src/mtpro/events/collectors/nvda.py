"""엔비디아 실적 EPS 컨센서스 — yfinance.

실측 (2026-08-17): yf.Ticker("NVDA").earnings_dates → 'EPS Estimate' 2.08 @ 2026-08-26 16:00 ET (파싱 성공).
  Ticker.calendar → {'Earnings Date': [2026-08-27], 'Earnings Average': 2.0838, ...} (Yahoo 날짜는 공식 8/26과 1일 어긋남 → ±2일 허용).
우선순위: earnings_dates(EPS Estimate, 이벤트 현지일 ±2일 행) → calendar('Earnings Average', Earnings Date ±2일). 둘 다 없으면 CollectError.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Any

from mtpro.events.calendar import CalendarEvent
from mtpro.events.collectors import CollectError

DATE_TOLERANCE_DAYS = 2
UNIT = "USD"


def _near(d: date, target: date, tol: int = DATE_TOLERANCE_DAYS) -> bool:
    return abs((d - target).days) <= tol


def from_earnings_dates(df, target: date) -> tuple[float, str] | None:
    """earnings_dates DataFrame → (EPS Estimate, 행 날짜 문자열) 또는 None."""
    if df is None or len(df) == 0 or "EPS Estimate" not in df.columns:
        return None
    for idx, row in df.iterrows():
        try:
            d = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
        except Exception:  # noqa: BLE001
            continue
        if _near(d, target):
            v = row.get("EPS Estimate")
            if v is None or (isinstance(v, float) and math.isnan(v)):
                return None
            return float(v), str(idx)
    return None


def from_calendar(cal: dict | None, target: date) -> tuple[float, str] | None:
    if not cal:
        return None
    dates = cal.get("Earnings Date") or []
    if isinstance(dates, (date, datetime)):
        dates = [dates]
    ok = any(_near(d.date() if isinstance(d, datetime) else d, target) for d in dates if d is not None)
    v = cal.get("Earnings Average")
    if ok and v is not None and not (isinstance(v, float) and math.isnan(v)):
        return float(v), str(dates)
    return None


def collect(event: CalendarEvent, *, now: datetime | None = None, ticker_factory=None) -> dict[str, Any]:
    if event.event_type != "NVDA_EARN":
        raise CollectError(f"{event.event_id}: nvda collector does not handle {event.event_type}")
    symbol = (event.spec.ticker if event.spec and event.spec.ticker else None) or "NVDA"
    if ticker_factory is None:
        import yfinance as yf

        ticker_factory = yf.Ticker
    t = ticker_factory(symbol)
    errors: list[str] = []
    try:
        got = from_earnings_dates(t.earnings_dates, event.local_date)
        if got:
            v, ref = got
            return _result(v, "yfinance.earnings_dates", symbol, ref, now)
        errors.append("earnings_dates: no row within ±2d or EPS Estimate NaN")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"earnings_dates: {type(exc).__name__}: {exc}")
    try:
        got = from_calendar(t.calendar, event.local_date)
        if got:
            v, ref = got
            return _result(v, "yfinance.calendar", symbol, ref, now)
        errors.append("calendar: Earnings Date not within ±2d or Earnings Average missing")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"calendar: {type(exc).__name__}: {exc}")
    raise CollectError(f"{event.event_id}: yfinance EPS estimate unavailable — " + " | ".join(errors))


def _result(v: float, source: str, symbol: str, ref: str, now: datetime | None) -> dict[str, Any]:
    return {
        "value": v, "unit": UNIT, "source": source,
        "source_url": f"https://finance.yahoo.com/quote/{symbol}/analysis",
        "fetched_at": now or datetime.now(timezone.utc),
        "raw": {"symbol": symbol, "matched": ref},
    }
