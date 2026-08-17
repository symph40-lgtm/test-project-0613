"""XKRX 세션 캘린더 래퍼 (T5-1, 계획서 §12.5 사전 등록).

- champion: `exchange_calendars` 'XKRX' (휴장·대체공휴일 반영). 로드 실패 시 폴백 = bronze/ohlcv_adj.parquet 관측 거래일
  + alerts.notify('XKRX_FALLBACK') (정보성 알림 — 폴백은 과거 관측일만 있으므로 미래 이벤트는 KrCalendarError, loud).
- t0_kr 경계는 **"발표 시각 < 09:00 KST 면 당일 세션"** 으로 고정 (계획서 §12.5, config events.independence.boundary).
  정확히 09:00:00 KST 이후(= 이상)는 다음 세션. XKRX 첫 거래일 10:00 개장 특례는 쓰지 않는다(경계 고정 — 보고서 확인 사항).
- 모든 함수는 캘린더 소스명(`source`)을 반환값/로그에 실어 나른다: KrCalendar.source, describe().
- 다른 모듈은 이 래퍼만 쓴다(소화 창·PSA 창·검증 창의 "거래일" 세기도 같은 캘린더 — §12.5).
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from mtpro import alerts, settings

CALENDAR_NAME = "XKRX"                                  # config events.independence.calendar
KST = ZoneInfo("Asia/Seoul")
SESSION_OPEN_KST = time(9, 0)                           # 경계: release < 09:00 KST → same session (고정)
BOUNDARY_RULE = "release < 09:00 KST → same session"    # config events.independence.boundary 와 일치 테스트

SOURCE_XKRX = "exchange_calendars:XKRX"
SOURCE_FALLBACK = "fallback:bronze/ohlcv_adj.parquet"
XKRX_FALLBACK = "XKRX_FALLBACK"                         # notify kind

DEFAULT_START = date(2015, 1, 1)
OHLCV_ADJ_PATH = settings.BRONZE / "ohlcv_adj.parquet"


class KrCalendarError(RuntimeError):
    """캘린더 조달 실패·범위 밖 질의 (loud-failure)."""


@dataclass(frozen=True)
class KrCalendar:
    """정렬된 세션 날짜 목록 + 소스명. 모든 질의는 O(log n)."""

    sessions: tuple[date, ...]
    source: str
    detail: dict[str, Any] = field(default_factory=dict, compare=False)

    def __post_init__(self) -> None:
        if not self.sessions:
            raise KrCalendarError(f"empty session list (source={self.source})")
        if list(self.sessions) != sorted(set(self.sessions)):
            raise KrCalendarError("sessions must be strictly increasing dates")

    # ---- 범위 ----
    @property
    def first(self) -> date:
        return self.sessions[0]

    @property
    def last(self) -> date:
        return self.sessions[-1]

    def _check_range(self, d: date, what: str) -> None:
        if d < self.first or d > self.last:
            raise KrCalendarError(
                f"{what} {d.isoformat()} outside calendar range {self.first}..{self.last} (source={self.source})")

    def describe(self) -> dict[str, Any]:
        return {"calendar": CALENDAR_NAME, "source": self.source, "first": self.first.isoformat(),
                "last": self.last.isoformat(), "n_sessions": len(self.sessions), "boundary": BOUNDARY_RULE, **self.detail}

    # ---- 질의 ----
    def is_session(self, d: date) -> bool:
        d = _as_date(d)
        self._check_range(d, "date")
        i = bisect.bisect_left(self.sessions, d)
        return i < len(self.sessions) and self.sessions[i] == d

    def session_index(self, d: date) -> int:
        d = _as_date(d)
        self._check_range(d, "date")
        i = bisect.bisect_left(self.sessions, d)
        if i >= len(self.sessions) or self.sessions[i] != d:
            raise KrCalendarError(f"{d.isoformat()} is not an XKRX session (source={self.source})")
        return i

    def next_session_on_or_after(self, d: date) -> date:
        d = _as_date(d)
        self._check_range(d, "date")
        i = bisect.bisect_left(self.sessions, d)
        if i >= len(self.sessions):
            raise KrCalendarError(f"no session on/after {d} within range (source={self.source})")
        return self.sessions[i]

    def next_session_after(self, d: date) -> date:
        d = _as_date(d)
        self._check_range(d, "date")
        i = bisect.bisect_right(self.sessions, d)
        if i >= len(self.sessions):
            raise KrCalendarError(f"no session after {d} within range (source={self.source})")
        return self.sessions[i]

    def next_open_after(self, ts_utc: datetime) -> date:
        """발표 시각(UTC, tz-aware) → 그 시각 **이후** 최초 세션 개장(09:00 KST)의 날짜 = t0_kr.
        경계 고정: KST 시각 < 09:00 이고 그날이 세션이면 당일, 아니면(09:00 이상·비세션) 다음 세션."""
        if not isinstance(ts_utc, datetime) or ts_utc.tzinfo is None:
            raise KrCalendarError("next_open_after requires tz-aware datetime")
        local = ts_utc.astimezone(KST)
        d = local.date()
        self._check_range(d, "release date")
        if local.time() < SESSION_OPEN_KST and self.is_session(d):
            return d
        return self.next_session_after(d)

    def add_sessions(self, d: date, n: int) -> date:
        """세션 d 에서 n 세션 뒤(음수면 앞). d 는 세션이어야 한다."""
        i = self.session_index(d)
        j = i + int(n)
        if j < 0 or j >= len(self.sessions):
            raise KrCalendarError(f"add_sessions({d}, {n}) leaves calendar range (source={self.source})")
        return self.sessions[j]

    def sessions_between(self, a: date, b: date) -> list[date]:
        """[a, b] 양끝 포함 세션 목록 (a·b 는 세션이 아니어도 됨). a > b 면 빈 목록."""
        a, b = _as_date(a), _as_date(b)
        self._check_range(a, "start")
        self._check_range(b, "end")
        i = bisect.bisect_left(self.sessions, a)
        j = bisect.bisect_right(self.sessions, b)
        return list(self.sessions[i:j])

    def session_distance(self, a: date, b: date) -> int:
        """세션 a→b 의 세션 수 차이(부호 있음). 둘 다 세션이어야 한다."""
        return self.session_index(b) - self.session_index(a)


def _as_date(d: Any) -> date:
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    if hasattr(d, "date") and callable(d.date):   # pandas.Timestamp
        return d.date()
    if isinstance(d, str):
        return date.fromisoformat(d)
    raise KrCalendarError(f"not a date: {d!r}")


# ---------------------------------------------------------------------------
# 조달: XKRX champion → 폴백(관측 거래일)
# ---------------------------------------------------------------------------
def load_xkrx(start: date = DEFAULT_START, end: date | None = None) -> KrCalendar:
    """exchange_calendars XKRX. end=None 이면 라이브러리가 제공하는 마지막 세션(≈1년 앞)까지."""
    try:
        import exchange_calendars as xc  # noqa: WPS433 (지연 임포트 — 폴백 경로에서 필수 아님)
        import pandas as pd
    except Exception as exc:  # noqa: BLE001
        raise KrCalendarError(f"exchange_calendars unavailable: {type(exc).__name__}: {exc}") from exc
    try:
        cal = xc.get_calendar(CALENDAR_NAME)
        last = cal.last_session.date() if end is None else min(end, cal.last_session.date())
        first = max(start, cal.first_session.date())
        idx = cal.sessions_in_range(pd.Timestamp(first), pd.Timestamp(last))
        sessions = tuple(ts.date() for ts in idx)
        ver = getattr(xc, "__version__", "?")
    except Exception as exc:  # noqa: BLE001
        raise KrCalendarError(f"XKRX calendar build failed: {type(exc).__name__}: {exc}") from exc
    return KrCalendar(sessions=sessions, source=SOURCE_XKRX,
                      detail={"exchange_calendars_version": ver, "requested_start": start.isoformat()})


def load_observed(path: Path | None = None) -> KrCalendar:
    """폴백: bronze/ohlcv_adj.parquet 의 관측 거래일(어느 코드든 행이 있는 날짜)."""
    p = Path(path) if path is not None else OHLCV_ADJ_PATH
    if not p.exists():
        raise KrCalendarError(f"fallback source missing: {p}")
    import pyarrow.parquet as pq
    col = pq.read_table(p, columns=["date"]).column("date").to_pylist()
    sessions = tuple(sorted({_as_date(x) for x in col if x is not None}))
    return KrCalendar(sessions=sessions, source=SOURCE_FALLBACK, detail={"path": str(p)})


def load_kr_calendar(
    start: date = DEFAULT_START,
    end: date | None = None,
    fallback_path: Path | None = None,
    notify: Callable[..., dict[str, Any]] = alerts.notify,
    prefer: str = "xkrx",
) -> KrCalendar:
    """champion XKRX → 실패 시 폴백(관측 거래일) + notify(XKRX_FALLBACK). 둘 다 실패면 KrCalendarError."""
    if prefer == "xkrx":
        try:
            return load_xkrx(start, end)
        except KrCalendarError as exc:
            reason = str(exc)
    else:
        reason = f"prefer={prefer!r}"
    try:
        cal = load_observed(fallback_path)
    except KrCalendarError as exc2:
        raise KrCalendarError(f"XKRX failed ({reason}); fallback failed ({exc2})") from exc2
    notify(XKRX_FALLBACK, {"reason": reason, "source": cal.source, "first": cal.first.isoformat(),
                           "last": cal.last.isoformat(), "n_sessions": len(cal.sessions),
                           "action": "exchange_calendars 설치/버전 확인 — 폴백은 관측일만 있어 미래 이벤트 t0 계산 불가"})
    return cal


_DEFAULT: KrCalendar | None = None


def default_calendar() -> KrCalendar:
    """프로세스 캐시된 기본 캘린더(모듈 함수용)."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = load_kr_calendar()
    return _DEFAULT


def set_default_calendar(cal: KrCalendar | None) -> None:
    """테스트·잡 주입용."""
    global _DEFAULT
    _DEFAULT = cal


# ---- 모듈 함수 (기본 캘린더) ----
def is_session(d: date, cal: KrCalendar | None = None) -> bool:
    return (cal or default_calendar()).is_session(d)


def next_open_after(ts_utc: datetime, cal: KrCalendar | None = None) -> date:
    return (cal or default_calendar()).next_open_after(ts_utc)


def add_sessions(d: date, n: int, cal: KrCalendar | None = None) -> date:
    return (cal or default_calendar()).add_sessions(d, n)


def sessions_between(a: date, b: date, cal: KrCalendar | None = None) -> list[date]:
    return (cal or default_calendar()).sessions_between(a, b)


def kst(d: date, t: time = SESSION_OPEN_KST) -> datetime:
    """편의: KST 날짜+시각 → tz-aware datetime (테스트·잡)."""
    return datetime.combine(d, t, tzinfo=KST)


def utc(d: date, t: time = SESSION_OPEN_KST) -> datetime:
    return kst(d, t).astimezone(timezone.utc)


__all__ = [
    "CALENDAR_NAME", "KST", "SESSION_OPEN_KST", "BOUNDARY_RULE", "SOURCE_XKRX", "SOURCE_FALLBACK", "XKRX_FALLBACK",
    "KrCalendar", "KrCalendarError", "load_xkrx", "load_observed", "load_kr_calendar", "default_calendar",
    "set_default_calendar", "is_session", "next_open_after", "add_sessions", "sessions_between", "kst", "utc",
]
