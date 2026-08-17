"""수집기 파싱 단위 테스트 (네트워크 없음 — 실측 응답 형태를 고정 표본으로)."""
from __future__ import annotations

from datetime import date, datetime, time, timezone

import pandas as pd
import pytest

from mtpro.events.calendar import CalendarEvent, EventTypeSpec, scheduled_utc
from mtpro.events.collectors import CollectError, kr_earnings, nvda, us_macro

UTC = timezone.utc


def _spec(et, src, ticker=None):
    return EventTypeSpec(event_type=et, label=et, official_source="x", release_rule="r", tz="America/New_York",
                         local_time=time(8, 30), t0_mode="A1_open", asset_scope=("KOSPI200",),
                         consensus_source=src, consensus_field="f", consensus_unit="%", ticker=ticker)


def _ev(et, d, src, ticker=None):
    s = _spec(et, src, ticker)
    return CalendarEvent(event_id=f"{et}_{d:%Y%m%d}", event_type=et, local_date=d, scheduled_ts_utc=scheduled_utc(d, s),
                         t0_mode="A1_open", asset_scope=s.asset_scope, status="confirmed", spec=s)


# ---------------- us_macro (ForexFactory JSON) ----------------
FF_ROWS = [
    {"title": "CPI m/m", "country": "USD", "date": "2026-09-11T08:30:00-04:00", "impact": "High", "forecast": "0.3%", "previous": "0.2%"},
    {"title": "CPI m/m", "country": "CAD", "date": "2026-09-11T08:30:00-04:00", "impact": "High", "forecast": "0.9%", "previous": ""},
    {"title": "Non-Farm Employment Change", "country": "USD", "date": "2026-09-04T08:30:00-04:00", "impact": "High", "forecast": "125K", "previous": "73K"},
    {"title": "Federal Funds Rate", "country": "USD", "date": "2026-09-16T14:00:00-04:00", "impact": "High", "forecast": "3.75%", "previous": "4.00%"},
    {"title": "Core PCE Price Index m/m", "country": "USD", "date": "2026-08-26T08:30:00-04:00", "impact": "High", "forecast": "", "previous": "0.3%"},
]


def test_parse_ff_value():
    assert us_macro.parse_ff_value("0.3%") == (0.3, "%")
    assert us_macro.parse_ff_value("125K") == (125.0, "K")
    assert us_macro.parse_ff_value("-0.1%") == (-0.1, "%")
    assert us_macro.parse_ff_value("1.37M") == (1.37, "M")
    with pytest.raises(CollectError):
        us_macro.parse_ff_value("")


def test_ff_pick_and_collect(monkeypatch):
    monkeypatch.setattr(us_macro, "fetch_ff_thisweek", lambda session=None, **_: FF_ROWS)
    r = us_macro.collect_forexfactory(_ev("US_CPI", date(2026, 9, 11), "us_macro"), now=datetime(2026, 9, 10, tzinfo=UTC))
    assert (r["value"], r["unit"], r["source"]) == (0.3, "%", "forexfactory")  # CAD 행 아닌 USD 행
    r = us_macro.collect_forexfactory(_ev("US_NFP", date(2026, 9, 4), "us_macro"))
    assert (r["value"], r["unit"]) == (125.0, "K")
    r = us_macro.collect_forexfactory(_ev("FOMC", date(2026, 9, 16), "us_macro"))
    assert (r["value"], r["unit"]) == (3.75, "%")
    with pytest.raises(CollectError, match="forecast empty"):
        us_macro.collect_forexfactory(_ev("US_PCE", date(2026, 8, 26), "us_macro"))
    with pytest.raises(CollectError, match="not in ForexFactory"):
        us_macro.collect_forexfactory(_ev("US_CPI", date(2026, 10, 14), "us_macro"))


def test_us_macro_all_sources_fail_is_loud(monkeypatch):
    def boom(event, *, now=None, session=None):
        raise CollectError("HTTP 403")
    with pytest.raises(CollectError, match="all us_macro sources failed"):
        us_macro.collect(_ev("US_CPI", date(2026, 9, 11), "us_macro"), sources=(boom, boom))


# ---------------- kr_earnings (WiseReport 분기표) ----------------
KR_HTML = """
<table><tr><th>주요재무정보</th><th>분기</th></tr>
<tr><th>2025/09 (IFRS연결)</th><th>2025/12 (IFRS연결)</th><th>2026/03 (IFRS연결)</th><th>2026/06(E) (IFRS연결)</th><th>2026/09(E) (IFRS연결)</th></tr>
<tr><th>매출액</th><td>860,617</td><td>938,374</td><td>1,338,734</td><td>1,738,644</td><td>2,067,908</td></tr>
<tr><th>영업이익</th><td>121,661</td><td>200,737</td><td>572,328</td><td></td><td></td></tr>
<tr><th>영업이익(발표기준)</th><td>121,661</td><td>200,737</td><td>572,328</td><td>850,494</td><td>1,139,748</td></tr>
</table>"""


def test_target_quarter():
    assert kr_earnings.target_quarter(date(2026, 10, 8)) == "2026/09"
    assert kr_earnings.target_quarter(date(2026, 1, 8)) == "2025/12"
    assert kr_earnings.target_quarter(date(2026, 7, 7)) == "2026/06"
    assert kr_earnings.target_quarter(date(2026, 4, 24)) == "2026/03"


def test_kr_parse_and_extract():
    header, body = kr_earnings.parse_quarter_table(KR_HTML)
    assert header[-1] == "2026/09(E)"
    v, row, label = kr_earnings.extract_consensus(header, body, "2026/09")
    assert (v, row, label) == (1139748.0, "영업이익(발표기준)", "2026/09(E)")
    with pytest.raises(CollectError, match="not an estimate"):
        kr_earnings.extract_consensus(header, body, "2026/03")  # 실적(A) 컬럼 → 컨센서스 아님
    with pytest.raises(CollectError, match="not in columns"):
        kr_earnings.extract_consensus(header, body, "2026/12")


def test_kr_collect_with_injected_fetch(monkeypatch):
    monkeypatch.setattr(kr_earnings, "fetch_quarter_table", lambda code, session=None, **_: ("https://p", KR_HTML))
    ev = _ev("SEC_PRELIM", date(2026, 10, 8), "kr_earnings", ticker="005930")
    r = kr_earnings.collect(ev, now=datetime(2026, 10, 5, tzinfo=UTC))
    assert (r["value"], r["unit"]) == (1139748.0, "억원") and r["raw"]["quarter"] == "2026/09"


# ---------------- nvda (yfinance) ----------------
class _FakeTicker:
    def __init__(self, symbol, ed=None, cal=None):
        self._ed, self._cal = ed, cal

    @property
    def earnings_dates(self):
        return self._ed

    @property
    def calendar(self):
        return self._cal


def test_nvda_from_earnings_dates_then_calendar():
    idx = pd.DatetimeIndex([pd.Timestamp("2026-08-26 16:00:00-04:00"), pd.Timestamp("2026-05-20 16:00:00-04:00")])
    ed = pd.DataFrame({"EPS Estimate": [2.08, 1.77], "Reported EPS": [float("nan"), 1.87]}, index=idx)
    ev = _ev("NVDA_EARN", date(2026, 8, 26), "nvda", ticker="NVDA")
    r = nvda.collect(ev, ticker_factory=lambda s: _FakeTicker(s, ed=ed))
    assert (r["value"], r["unit"], r["source"]) == (2.08, "USD", "yfinance.earnings_dates")
    # earnings_dates 없음 → calendar 폴백 (Yahoo 날짜 1일 어긋남 허용)
    cal = {"Earnings Date": [date(2026, 8, 27)], "Earnings Average": 2.0838}
    r = nvda.collect(ev, ticker_factory=lambda s: _FakeTicker(s, ed=None, cal=cal))
    assert (r["value"], r["source"]) == (2.0838, "yfinance.calendar")
    # 둘 다 없음 → loud
    with pytest.raises(CollectError, match="unavailable"):
        nvda.collect(_ev("NVDA_EARN", date(2026, 11, 18), "nvda", ticker="NVDA"),
                     ticker_factory=lambda s: _FakeTicker(s, ed=ed, cal=cal))
