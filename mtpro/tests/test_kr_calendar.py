"""T5-1 XKRX 세션 캘린더 래퍼 — champion 로드·2026 휴장(추석·개천절 대체·한글날)·09:00 경계·세션 산술·폴백."""
from __future__ import annotations

from datetime import date, datetime, time, timezone

import pytest

from mtpro.events import kr_calendar as KC

UTC = timezone.utc


@pytest.fixture(scope="module")
def cal() -> KC.KrCalendar:
    return KC.load_xkrx(date(2020, 1, 1))


def test_xkrx_loads_and_reports_source(cal):
    assert cal.source == KC.SOURCE_XKRX == "exchange_calendars:XKRX"
    d = cal.describe()
    assert d["calendar"] == "XKRX" and d["source"] == KC.SOURCE_XKRX and d["boundary"] == KC.BOUNDARY_RULE
    assert d["last"] >= "2026-12-31", "2026 하반기 이벤트를 다루려면 캘린더가 최소 연말까지 있어야 한다"
    assert KC.CALENDAR_NAME == "XKRX"


def test_2026_holidays_chuseok_and_hangul(cal):
    # 추석 9/24(목)·9/25(금) 휴장, 9/23·9/28 세션 (9/26 토 겹침은 대체공휴일 아님)
    assert not cal.is_session(date(2026, 9, 24)) and not cal.is_session(date(2026, 9, 25))
    assert cal.is_session(date(2026, 9, 23)) and cal.is_session(date(2026, 9, 28))
    # 한글날 10/9(금) 휴장
    assert not cal.is_session(date(2026, 10, 9))
    # 주말
    assert not cal.is_session(date(2026, 9, 12)) and not cal.is_session(date(2026, 9, 13))
    # 개천절 10/3(토) → 대체공휴일 10/5(월) 휴장 (계획서 §2.3 표의 "NFP 10/2 → t0 10/5" 는 이 캘린더로 재계산 시 10/6 — 보고 대상)
    assert not cal.is_session(date(2026, 10, 5))
    assert cal.is_session(date(2026, 10, 6))
    # 연말: 12/31 휴장·1/1 휴장, 12/30 세션
    assert not cal.is_session(date(2026, 12, 31)) and not cal.is_session(date(2027, 1, 1))
    assert cal.is_session(date(2026, 12, 30))


def test_next_open_after_boundary_0900_kst(cal):
    # 정확히 09:00:00 KST 발표 → 다음 세션 / 08:59:59 → 당일 (경계 "release < 09:00 KST → same session")
    mon = date(2026, 9, 14)
    assert cal.next_open_after(KC.kst(mon, time(8, 59, 59))) == mon
    assert cal.next_open_after(KC.kst(mon, time(9, 0, 0))) == date(2026, 9, 15)
    assert cal.next_open_after(KC.kst(mon, time(9, 0, 1))) == date(2026, 9, 15)
    assert cal.next_open_after(KC.kst(mon, time(0, 0))) == mon
    # 자정 직전 → 다음 세션
    assert cal.next_open_after(KC.kst(mon, time(23, 59, 59))) == date(2026, 9, 15)
    # UTC 입력도 동일 (09:00 KST = 00:00 UTC)
    assert cal.next_open_after(datetime(2026, 9, 13, 23, 59, 59, tzinfo=UTC)) == mon
    assert cal.next_open_after(datetime(2026, 9, 14, 0, 0, 0, tzinfo=UTC)) == date(2026, 9, 15)


def test_next_open_after_weekend_and_holiday(cal):
    # 금요일 21:30 KST(미 08:30 ET 지표) → 월요일
    assert cal.next_open_after(KC.kst(date(2026, 9, 11), time(21, 30))) == date(2026, 9, 14)
    # 목요일 새벽 03:00 KST(FOMC) → 그날
    assert cal.next_open_after(KC.kst(date(2026, 9, 17), time(3, 0))) == date(2026, 9, 17)
    # 추석 전날 밤 → 9/28(월)
    assert cal.next_open_after(KC.kst(date(2026, 9, 23), time(21, 30))) == date(2026, 9, 28)
    # 10/2(금) 밤 → 10/5 대체공휴일 건너 10/6(화)
    assert cal.next_open_after(KC.kst(date(2026, 10, 2), time(21, 30))) == date(2026, 10, 6)
    # 10/8(목) 08:00 KST(삼전 잠정) → 당일
    assert cal.next_open_after(KC.kst(date(2026, 10, 8), time(8, 0))) == date(2026, 10, 8)
    # 8/26 16:20 ET(NVDA) = 8/27 05:20 KST → 8/27
    assert cal.next_open_after(KC.kst(date(2026, 8, 27), time(5, 20))) == date(2026, 8, 27)


def test_add_sessions_and_sessions_between(cal):
    assert cal.add_sessions(date(2026, 9, 17), 4) == date(2026, 9, 23)
    assert cal.sessions_between(date(2026, 9, 17), date(2026, 9, 23)) == [
        date(2026, 9, 17), date(2026, 9, 18), date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23)]
    # 추석 건너뛰기: 9/23 + 1 = 9/28
    assert cal.add_sessions(date(2026, 9, 23), 1) == date(2026, 9, 28)
    assert cal.add_sessions(date(2026, 9, 28), -1) == date(2026, 9, 23)
    # 한글날·대체공휴일 건너뛰기: 10/6 + 4 = 10/13 (10/6·7·8·12·13)
    assert cal.add_sessions(date(2026, 10, 6), 4) == date(2026, 10, 13)
    assert cal.sessions_between(date(2026, 10, 1), date(2026, 10, 12)) == [
        date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 6), date(2026, 10, 7), date(2026, 10, 8), date(2026, 10, 12)]
    # 비세션 양끝도 허용, 역순은 빈 목록
    assert cal.sessions_between(date(2026, 9, 24), date(2026, 9, 27)) == []
    assert cal.sessions_between(date(2026, 9, 20), date(2026, 9, 19)) == []
    assert cal.session_distance(date(2026, 10, 8), date(2026, 10, 13)) == 2   # 10/8 → 10/12 → 10/13 (10/9 휴장)
    assert cal.session_distance(date(2026, 10, 8), date(2026, 10, 14)) == 3
    assert cal.session_distance(date(2026, 10, 14), date(2026, 10, 8)) == -3
    with pytest.raises(KC.KrCalendarError):
        cal.add_sessions(date(2026, 9, 24), 1)   # 비세션 기준점
    with pytest.raises(KC.KrCalendarError):
        cal.next_open_after(datetime(2030, 1, 1, tzinfo=UTC))   # 범위 밖 → loud
    with pytest.raises(KC.KrCalendarError):
        cal.next_open_after(datetime(2026, 9, 14))   # naive


def test_module_functions_use_injected_or_default(cal):
    KC.set_default_calendar(cal)
    try:
        assert KC.is_session(date(2026, 9, 24)) is False
        assert KC.next_open_after(KC.kst(date(2026, 9, 11), time(21, 30))) == date(2026, 9, 14)
        assert KC.add_sessions(date(2026, 9, 17), 4) == date(2026, 9, 23)
        assert len(KC.sessions_between(date(2026, 9, 14), date(2026, 9, 18))) == 5
    finally:
        KC.set_default_calendar(None)


def test_fallback_observed_sessions_and_notify(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq

    days = [date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 16), date(2026, 9, 17), date(2026, 9, 18), date(2026, 9, 21)]
    tbl = pa.table({"date": pa.array(days * 2, pa.date32()), "code": ["005930"] * 6 + ["000660"] * 6})
    p = tmp_path / "ohlcv_adj.parquet"
    pq.write_table(tbl, p)
    notes = []
    fb = KC.load_kr_calendar(fallback_path=p, notify=lambda k, d, **kw: notes.append((k, d)) or {"kind": k}, prefer="fallback")
    assert fb.source == KC.SOURCE_FALLBACK and fb.sessions == tuple(days)
    assert notes and notes[0][0] == KC.XKRX_FALLBACK == "XKRX_FALLBACK" and notes[0][1]["source"] == KC.SOURCE_FALLBACK
    assert fb.next_open_after(KC.kst(date(2026, 9, 16), time(9, 0))) == date(2026, 9, 17)
    with pytest.raises(KC.KrCalendarError):
        fb.next_open_after(KC.kst(date(2026, 10, 1), time(8, 0)))   # 관측일 밖 → loud (미래 이벤트 계산 불가)
    # 폴백 소스마저 없으면 실패 (조용한 None 없음)
    with pytest.raises(KC.KrCalendarError):
        KC.load_kr_calendar(fallback_path=tmp_path / "missing.parquet", notify=lambda *a, **k: {}, prefer="fallback")


def test_kr_calendar_rejects_unsorted_or_empty():
    with pytest.raises(KC.KrCalendarError):
        KC.KrCalendar(sessions=(), source="x")
    with pytest.raises(KC.KrCalendarError):
        KC.KrCalendar(sessions=(date(2026, 1, 5), date(2026, 1, 2)), source="x")
