"""A-5 검출 테스트 — attribution_quality 겹침 감지 로직이 사양에 서술만 있고 코드 미구현이던 결함.

수정 방향: 동일 t0 윈도 내 복수 이벤트 → 감점 공식을 코드 상수로 사전 등록 (quality = 1/n_overlap).
  - t0_mode="A1_open": Amendment A-1, 개장 전 재료는 당일 09:00 시가로 정렬 → 같은 t0 (점 창)
  - t0_mode="release_time": 발표 시각 t0 ± 30분 창
검출 조건: 동시각 2개 이벤트 → quality < 1.0, 단독 → 1.0.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from mtpro.core.errata import ATTRIBUTION_QUALITY_FORMULA, RELEASE_TIME_WINDOW_MIN, attribution_quality

OPEN = datetime(2026, 8, 17, 9, 0)


def _ev(eid: str, t0: datetime, mode: str = "A1_open", scope: str = "KOSPI200") -> dict:
    return {"event_id": eid, "t0": t0, "t0_mode": mode, "asset_scope": scope}


def test_formula_is_registered_as_constant():
    assert ATTRIBUTION_QUALITY_FORMULA == "1/n_overlap"
    assert RELEASE_TIME_WINDOW_MIN == 30


def test_single_event_is_full_quality():
    q = attribution_quality([_ev("a", OPEN)])
    assert q == {"a": 1.0}


def test_two_events_same_t0_are_penalized():
    # FOMC(새벽 발표) + 삼성전자 잠정실적(개장 전) → 둘 다 A-1 정렬로 09:00 t0
    q = attribution_quality([_ev("fomc", OPEN), _ev("samsung_prelim", OPEN)])
    assert q["fomc"] < 1.0 and q["samsung_prelim"] < 1.0
    assert q["fomc"] == pytest.approx(0.5)  # 1/n_overlap, n=2


def test_three_events_same_t0():
    q = attribution_quality([_ev("a", OPEN), _ev("b", OPEN), _ev("c", OPEN)])
    assert all(v == pytest.approx(1 / 3) for v in q.values())


def test_a1_open_different_days_do_not_overlap():
    q = attribution_quality([_ev("a", OPEN), _ev("b", OPEN + timedelta(days=1))])
    assert q == {"a": 1.0, "b": 1.0}


def test_release_time_within_30min_overlaps():
    t = datetime(2026, 8, 17, 21, 30)
    q = attribution_quality([
        _ev("cpi", t, "release_time", "SOXX"),
        _ev("claims", t + timedelta(minutes=20), "release_time", "SOXX"),
    ])
    assert q["cpi"] == pytest.approx(0.5) and q["claims"] == pytest.approx(0.5)


def test_release_time_beyond_30min_does_not_overlap():
    t = datetime(2026, 8, 17, 21, 30)
    q = attribution_quality([
        _ev("cpi", t, "release_time", "SOXX"),
        _ev("later", t + timedelta(minutes=45), "release_time", "SOXX"),
    ])
    assert q == {"cpi": 1.0, "later": 1.0}


def test_release_time_boundary_inclusive():
    t = datetime(2026, 8, 17, 21, 30)
    q = attribution_quality([
        _ev("x", t, "release_time", "SOXX"),
        _ev("y", t + timedelta(minutes=RELEASE_TIME_WINDOW_MIN), "release_time", "SOXX"),
    ])
    assert q["x"] == pytest.approx(0.5)


def test_mixed_modes_overlap_when_windows_intersect():
    # 09:00 개장 정렬 이벤트와 09:20 장중 발표(release_time, ±30분) 는 겹친다
    q = attribution_quality([_ev("open_ev", OPEN, "A1_open"), _ev("intraday", OPEN + timedelta(minutes=20), "release_time")])
    assert q["open_ev"] == pytest.approx(0.5) and q["intraday"] == pytest.approx(0.5)


def test_different_asset_scope_does_not_overlap():
    q = attribution_quality([_ev("a", OPEN, scope="005930"), _ev("b", OPEN, scope="000660")])
    assert q == {"a": 1.0, "b": 1.0}


def test_overlap_counts_are_pairwise_not_transitive():
    # a-b 겹침, b-c 겹침, a-c 는 60분 차이로 안 겹침 → a=1/2, b=1/3, c=1/2
    t = datetime(2026, 8, 17, 21, 0)
    q = attribution_quality([
        _ev("a", t, "release_time", "SOXX"),
        _ev("b", t + timedelta(minutes=30), "release_time", "SOXX"),
        _ev("c", t + timedelta(minutes=60), "release_time", "SOXX"),
    ])
    assert q["a"] == pytest.approx(0.5)
    assert q["b"] == pytest.approx(1 / 3)
    assert q["c"] == pytest.approx(0.5)


def test_unknown_t0_mode_rejected():
    with pytest.raises(ValueError):
        attribution_quality([_ev("a", OPEN, mode="gap_close")])


def test_missing_t0_rejected_no_silent_default():
    with pytest.raises(ValueError):
        attribution_quality([{"event_id": "a", "t0": None, "t0_mode": "A1_open"}])


def test_quality_in_unit_interval():
    events = [_ev(f"e{i}", OPEN) for i in range(7)]
    q = attribution_quality(events)
    assert all(0.0 < v <= 1.0 for v in q.values())
    assert len(q) == 7
