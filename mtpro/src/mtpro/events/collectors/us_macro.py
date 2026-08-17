"""미 매크로 4종(FOMC·CPI·NFP·PCE) 컨센서스 수집.

실측 (2026-08-17, docs 보고 참조):
- ForexFactory 주간 JSON 피드 https://nfs.faireconomy.media/ff_calendar_thisweek.json → HTTP 200, forecast 파싱 성공.
  제약: "이번 주"(일~토, ET) 1주치만 제공. nextweek 피드는 404. → 월/화 이벤트의 D-3(전주 토/일)은 피드 밖 → CollectError
  (D-1은 항상 같은 주). 이 경우 스케줄러는 alert 후 D-1 재시도로 넘어간다.
  제약 2: 짧은 간격 연속 요청 수 회 → HTTP 429 (실측). 모듈 캐시(10분)로 한 실행에 1회만 받는다.
- investing.com 경제 캘린더(및 sslecal2 위젯) → HTTP 403 (봇 차단). 폴백으로만 남겨두며 실패 시 사유를 합쳐 CollectError.

값 규약: FF forecast 문자열 "3.75%" → (3.75, "%"), "125K" → (125.0, "K"), "1.37M" → (1.37, "M"). 빈 forecast → CollectError.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

import requests

from mtpro.events.calendar import CalendarEvent
from mtpro.events.collectors import CollectError

FF_THISWEEK_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
INVESTING_URL = "https://www.investing.com/economic-calendar/"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
ET = ZoneInfo("America/New_York")

# event_type → ForexFactory 제목 (정확 일치, 대소문자 무시)
FF_TITLES: dict[str, str] = {
    "FOMC": "Federal Funds Rate",
    "US_CPI": "CPI m/m",
    "US_NFP": "Non-Farm Employment Change",
    "US_PCE": "Core PCE Price Index m/m",
}

_NUM_RE = re.compile(r"^\s*(<|>)?\s*(-?\d+(?:\.\d+)?)\s*(%|K|M|B|T)?\s*$", re.I)


def parse_ff_value(s: str) -> tuple[float, str]:
    """'3.75%' → (3.75,'%'); '125K' → (125.0,'K'); '0.3' → (0.3,''). 파싱 불가 → CollectError."""
    m = _NUM_RE.match(s or "")
    if not m:
        raise CollectError(f"unparseable forecast {s!r}")
    return float(m.group(2)), (m.group(3) or "").upper()


_FF_CACHE: dict[str, Any] = {"at": 0.0, "data": None}
FF_CACHE_TTL_SEC = 600  # 실측: 연속 호출 수 회 만에 HTTP 429 → 한 실행 안에서는 1회만 받는다


def fetch_ff_thisweek(session: requests.Session | None = None, timeout: int = 20, use_cache: bool = True) -> list[dict[str, Any]]:
    import time

    if use_cache and _FF_CACHE["data"] is not None and time.time() - _FF_CACHE["at"] < FF_CACHE_TTL_SEC:
        return _FF_CACHE["data"]
    s = session or requests.Session()
    r = s.get(FF_THISWEEK_URL, headers=UA, timeout=timeout)
    if r.status_code != 200:
        raise CollectError(f"ForexFactory feed HTTP {r.status_code}" + (" (rate limit — 재시도는 10분 후)" if r.status_code == 429 else ""))
    try:
        data = r.json()
    except ValueError as exc:
        raise CollectError(f"ForexFactory feed not JSON: {exc}") from exc
    if not isinstance(data, list):
        raise CollectError("ForexFactory feed: unexpected shape")
    _FF_CACHE.update(at=time.time(), data=data)
    return data


def pick_ff_row(rows: list[dict[str, Any]], event: CalendarEvent) -> dict[str, Any]:
    """USD + 제목 일치 + ET 날짜 == event.local_date 인 행 1개."""
    title = FF_TITLES.get(event.event_type)
    if title is None:
        raise CollectError(f"{event.event_id}: no ForexFactory title mapping for {event.event_type}")
    cands = []
    for r in rows:
        if (r.get("country") or "").upper() != "USD":
            continue
        if (r.get("title") or "").strip().lower() != title.lower():
            continue
        try:
            d = datetime.fromisoformat(r["date"]).astimezone(ET).date()
        except Exception:  # noqa: BLE001
            continue
        if d == event.local_date:
            cands.append(r)
    if not cands:
        dates = sorted({str(r.get("date"))[:10] for r in rows if (r.get("country") or "").upper() == "USD"})
        rng = f"{dates[0]}..{dates[-1]}" if dates else "empty"
        raise CollectError(
            f"{event.event_id}: '{title}' on {event.local_date} not in ForexFactory this-week feed (feed USD dates {rng})"
        )
    return cands[0]


def collect_forexfactory(event: CalendarEvent, *, now: datetime | None = None, session=None) -> dict[str, Any]:
    rows = fetch_ff_thisweek(session)
    row = pick_ff_row(rows, event)
    fc = (row.get("forecast") or "").strip()
    if not fc:
        raise CollectError(f"{event.event_id}: ForexFactory forecast empty for '{row.get('title')}' {row.get('date')}")
    value, unit = parse_ff_value(fc)
    unit = unit or (event.spec.consensus_unit if event.spec else "")
    return {
        "value": value, "unit": unit, "source": "forexfactory", "source_url": FF_THISWEEK_URL,
        "fetched_at": now or datetime.now(timezone.utc),
        "raw": {"title": row.get("title"), "date": row.get("date"), "forecast": fc, "previous": row.get("previous")},
    }


def collect_investing(event: CalendarEvent, *, now: datetime | None = None, session=None) -> dict[str, Any]:
    """investing.com 폴백. 실측 403 — 구조 파싱은 구현하지 않고 상태코드만 정직하게 보고한다.
    (200이 오더라도 파싱기는 없으므로 CollectError: 향후 구조 확인 후 구현.)"""
    s = session or requests.Session()
    try:
        r = s.get(INVESTING_URL, headers=UA, timeout=20)
    except requests.RequestException as exc:
        raise CollectError(f"investing.com request error: {exc}") from exc
    if r.status_code != 200:
        raise CollectError(f"investing.com HTTP {r.status_code} (bot block)")
    raise CollectError("investing.com HTTP 200 but no parser implemented (structure unverified)")


def collect(
    event: CalendarEvent,
    *,
    now: datetime | None = None,
    session=None,
    sources: tuple[Callable[..., dict[str, Any]], ...] = (collect_forexfactory, collect_investing),
) -> dict[str, Any]:
    """소스 순서대로 시도, 전부 실패하면 사유를 합쳐 CollectError."""
    if event.event_type not in FF_TITLES:
        raise CollectError(f"{event.event_id}: us_macro collector does not handle {event.event_type}")
    errors: list[str] = []
    for fn in sources:
        try:
            return fn(event, now=now, session=session)
        except CollectError as exc:
            errors.append(f"{fn.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001 — 네트워크 예외 등도 loud 로 승격
            errors.append(f"{fn.__name__}: {type(exc).__name__}: {exc}")
    raise CollectError(f"{event.event_id}: all us_macro sources failed — " + " | ".join(errors))
