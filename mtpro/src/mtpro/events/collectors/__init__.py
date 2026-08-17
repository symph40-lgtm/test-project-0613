"""컨센서스 자동 수집기 (발주자 개정 D3 2026-08-17).

계약: collect(event: CalendarEvent, *, now: datetime|None = None) -> dict
  {"value": float, "unit": str, "source": str, "source_url": str, "fetched_at": datetime(UTC), "raw": Any}
실패는 CollectError (loud-failure). 조용한 None 반환 금지.

소스 배정 (config/event_calendar.yaml event_types.*.consensus_source):
  us_macro    → collectors/us_macro.py   (ForexFactory 주간 JSON 우선, investing.com 폴백)
  kr_earnings → collectors/kr_earnings.py (네이버금융 종목분석(coinfo) iframe = WiseReport/FnGuide 분기 컨센서스)
  nvda        → collectors/nvda.py        (yfinance earnings_dates / calendar EPS 추정)
"""
from __future__ import annotations

from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from mtpro.events.calendar import CalendarEvent

Collector = Callable[..., dict[str, Any]]


class CollectError(RuntimeError):
    """수집 실패 (차단·구조 변경·값 없음). 스케줄러가 alert 로 기록한다."""


def default_collectors() -> dict[str, Collector]:
    from mtpro.events.collectors import kr_earnings, nvda, us_macro

    return {
        "us_macro": us_macro.collect,
        "kr_earnings": kr_earnings.collect,
        "nvda": nvda.collect,
    }


def collector_for(event: "CalendarEvent", collectors: dict[str, Collector] | None = None) -> Collector:
    cols = collectors if collectors is not None else default_collectors()
    src = event.spec.consensus_source if event.spec is not None else None
    if src is None or src not in cols:
        raise CollectError(f"{event.event_id}: no collector for consensus_source={src!r}")
    return cols[src]
