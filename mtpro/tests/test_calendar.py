"""이벤트 캘린더 — yaml 적재·검증·UTC 변환 (DST)·7종 정합."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from mtpro.events.calendar import CalendarError, load_calendar
from mtpro.events.registry import EVENT_TYPES

UTC = timezone.utc


def test_default_calendar_loads_and_matches_event_types():
    cal = load_calendar()
    assert set(cal.types) == set(EVENT_TYPES)
    assert "BOK_RATE" not in cal.types  # 금통위 제외 (D3)
    assert all(t.t0_mode == "A1_open" for t in cal.types.values())  # 7종 전부 개장 전 재료
    assert cal.events, "2026 하반기 일정이 비어있으면 안 됨"
    ids = [e.event_id for e in cal.events]
    assert len(ids) == len(set(ids))
    for e in cal.events:
        assert e.event_id == f"{e.event_type}_{e.local_date:%Y%m%d}"
        assert e.scheduled_ts_utc.tzinfo is not None
        assert e.status in ("confirmed", "unconfirmed", "tentative")   # T5-1: tentative 추가
        assert e.spec is not None and e.spec.consensus_source in ("us_macro", "kr_earnings", "nvda")


def test_utc_conversion_handles_dst():
    cal = load_calendar()
    # 9/16 FOMC 14:00 EDT = 18:00 UTC ; 12/9 FOMC 14:00 EST = 19:00 UTC
    assert cal.get("FOMC_20260916").scheduled_ts_utc == datetime(2026, 9, 16, 18, 0, tzinfo=UTC)
    assert cal.get("FOMC_20261209").scheduled_ts_utc == datetime(2026, 12, 9, 19, 0, tzinfo=UTC)
    # CPI 08:30 EDT = 12:30 UTC
    assert cal.get("US_CPI_20260911").scheduled_ts_utc == datetime(2026, 9, 11, 12, 30, tzinfo=UTC)
    # 삼전 잠정 08:00 KST = 23:00 UTC 전일
    assert cal.get("SEC_PRELIM_20261008").scheduled_ts_utc == datetime(2026, 10, 7, 23, 0, tzinfo=UTC)


def test_known_confirmed_and_unconfirmed():
    cal = load_calendar()
    assert cal.get("FOMC_20260916").confirmed
    assert cal.get("US_PCE_20260826").confirmed
    assert cal.get("NVDA_EARN_20260826").confirmed
    assert not cal.get("SEC_PRELIM_20261008").confirmed
    assert not cal.get("HYNIX_EARN_20261022").confirmed
    # T5-1 (계획서 §12.5): 공식 일정 미게시 3건은 tentative (unconfirmed 와 구분) — 확인 전 verify_eligible=False 근거
    assert cal.get("SEC_PRELIM_20261008").tentative and cal.get("SEC_PRELIM_20261008").status == "tentative"
    assert cal.get("HYNIX_EARN_20261022").tentative and cal.get("NVDA_EARN_20261118").tentative
    assert cal.get("SEC_PRELIM_20261008").as_dict()["status"] == "tentative"


def test_consensus_fields_match_preregistered_mtpro_yaml():
    """운영 결정 ② 컨센서스 필드 사전 등록: config/mtpro.yaml consensus.fields == event_calendar.yaml consensus_field."""
    import yaml
    from mtpro import settings

    conf = yaml.safe_load((settings.CONFIG_DIR / "mtpro.yaml").read_text(encoding="utf-8"))
    fields = conf["consensus"]["fields"]
    assert fields == {"US_CPI": "headline_mom", "US_PCE": "core_mom", "FOMC": "rate_upper_bound", "US_NFP": "headline_change"}
    cal = load_calendar()
    for et, code in fields.items():
        assert et in cal.types, et
        assert cal.types[et].consensus_field == code, f"{et}: calendar {cal.types[et].consensus_field!r} != mtpro.yaml {code!r}"
    # 사전 등록된 운영 결정 상수도 고정
    assert conf["consensus"]["single_fetch_allowed"] is True
    assert conf["consensus"]["manual_override_wins"] is True
    assert conf["consensus"]["unconfirmed_recheck_days_before"] == 7


def test_between_and_upcoming_sorted():
    cal = load_calendar()
    evs = cal.between(datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 30, 23, 59, tzinfo=UTC))
    ids = [e.event_id for e in evs]
    assert ids == sorted(ids, key=lambda i: cal.get(i).scheduled_ts_utc)
    assert {"US_NFP_20260904", "US_CPI_20260911", "FOMC_20260916", "US_PCE_20260930"} <= set(ids)
    up = cal.upcoming(datetime(2026, 8, 20, tzinfo=UTC), 10)
    assert {e.event_id for e in up} == {"US_PCE_20260826", "NVDA_EARN_20260826"}


def _write(tmp_path, body: str):
    p = tmp_path / "cal.yaml"
    p.write_text(body, encoding="utf-8")
    return p


_TYPE = """
version: "t"
event_types:
  US_CPI:
    label: cpi
    official_source: x
    release_rule: r
    tz: America/New_York
    local_time: "08:30"
    t0_mode: A1_open
    asset_scope: [KOSPI200]
    consensus_source: us_macro
    consensus_field: "CPI m/m"
    consensus_unit: "%"
"""


def test_rejects_bad_event_id_rule(tmp_path):
    p = _write(tmp_path, _TYPE + """
events:
  - {event_id: CPI_20260911, event_type: US_CPI, local_date: "2026-09-11", status: confirmed}
""")
    with pytest.raises(CalendarError):
        load_calendar(p)


def test_rejects_unknown_type_and_status(tmp_path):
    p = _write(tmp_path, _TYPE + """
events:
  - {event_id: US_CPI_20260911, event_type: US_CPI, local_date: "2026-09-11", status: maybe}
""")
    with pytest.raises(CalendarError):
        load_calendar(p)
    p2 = _write(tmp_path, _TYPE.replace("US_CPI:", "BOK_RATE:"))
    with pytest.raises(CalendarError):
        load_calendar(p2)


def test_row_level_override_of_time_and_t0_mode(tmp_path):
    p = _write(tmp_path, _TYPE + """
events:
  - {event_id: US_CPI_20260911, event_type: US_CPI, local_date: "2026-09-11", status: confirmed,
     local_time: "20:00", tz: Asia/Seoul, t0_mode: release_time, asset_scope: ["005930"]}
""")
    cal = load_calendar(p)
    e = cal.get("US_CPI_20260911")
    assert e.scheduled_ts_utc == datetime(2026, 9, 11, 11, 0, tzinfo=UTC)
    assert e.t0_mode == "release_time" and e.asset_scope == ("005930",)
