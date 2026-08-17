"""스케줄러 — 가짜 수집기로 D-3/D-1/실패→등급C/late 경로 (파일 I/O는 tmp registry·tmp alerts 만)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import partial

import pytest

from mtpro.alerts import loud_failure, notify, read_alerts
from mtpro.events.calendar import Calendar, CalendarEvent, EventTypeSpec, scheduled_utc
from mtpro.events.collectors import CollectError
from mtpro.events.registry import ConsensusRegistry, FrozenError
from mtpro.events.scheduler import (
    D7_STATUSES, STAGE_D1, STAGE_D3, STAGE_D7, STAGE_LATE, UNCONFIRMED_SCHEDULE_D7, run_collection, select_targets,
)

UTC = timezone.utc
from datetime import time as _time

SPEC = EventTypeSpec(
    event_type="US_CPI", label="cpi", official_source="x", release_rule="r", tz="America/New_York",
    local_time=_time(8, 30), t0_mode="A1_open", asset_scope=("KOSPI200", "005930", "000660"),
    consensus_source="fake", consensus_field="CPI m/m", consensus_unit="%",
)


def _event(eid="US_CPI_20260911", d=date(2026, 9, 11), status="confirmed", spec=SPEC):   # status → schedule_status (T5-1 필드명)
    return CalendarEvent(
        event_id=eid, event_type=spec.event_type, local_date=d, scheduled_ts_utc=scheduled_utc(d, spec),
        t0_mode=spec.t0_mode, asset_scope=spec.asset_scope, schedule_status=status, evidence="test", spec=spec,
    )


@pytest.fixture
def env(tmp_path):
    reg = ConsensusRegistry(tmp_path / "reg.parquet")
    alerts_path = tmp_path / "alerts.jsonl"
    alert = partial(loud_failure, path=alerts_path, stream=open(tmp_path / "stderr.txt", "w"))
    return reg, alerts_path, alert


@pytest.fixture
def notifier(tmp_path):
    """정보성 알림(notify) 도 같은 tmp alerts.jsonl 로 주입."""
    return partial(notify, path=tmp_path / "alerts.jsonl", stream=open(tmp_path / "stderr_info.txt", "w"))


def _ok_collector(value=0.3, unit="%", source="fake_src"):
    def collect(event, *, now=None, **_):
        return {"value": value, "unit": unit, "source": source, "source_url": "https://x", "fetched_at": now}
    return collect


def _fail_collector(msg="blocked"):
    def collect(event, *, now=None, **_):
        raise CollectError(msg)
    return collect


def test_select_targets_stages():
    ev = _event()  # sched 2026-09-11 12:30Z
    assert select_targets([ev], datetime(2026, 9, 8, 1, tzinfo=UTC)) == [(ev, STAGE_D3)]
    assert select_targets([ev], datetime(2026, 9, 10, 23, tzinfo=UTC)) == [(ev, STAGE_D1)]
    assert select_targets([ev], datetime(2026, 9, 11, 1, tzinfo=UTC)) == [(ev, STAGE_D1)]  # D-0 발표 전: D-1 캐치업
    assert select_targets([ev], datetime(2026, 9, 5, tzinfo=UTC)) == []
    assert select_targets([ev], datetime(2026, 9, 11, 13, tzinfo=UTC)) == [(ev, STAGE_LATE)]  # 발표 경과 미동결
    # D-2: 값 없을 때만 D-3 캐치업
    assert select_targets([ev], datetime(2026, 9, 9, tzinfo=UTC)) == [(ev, STAGE_D3)]


def test_d3_collect_then_d1_freeze_grade_A(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    cols = {"fake": _ok_collector(0.3)}
    r3 = run_collection(datetime(2026, 9, 8, 0, tzinfo=UTC), cal, reg, cols, alert)
    assert [(r.stage, r.status, r.value) for r in r3] == [("D-3", "collected", 0.3)]
    row = reg.get("US_CPI_20260911")
    assert row["frozen"] is False and row["consensus_value"] == 0.3 and row["entered_by"] == "auto:fake_src"
    assert row["vintage_ts"] == datetime(2026, 9, 8, 0, tzinfo=UTC)
    # 재실행(같은 날) 은 다시 수집(덮어쓰기)만 — 동결 안 함
    run_collection(datetime(2026, 9, 8, 6, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.31)}, alert)
    assert reg.get("US_CPI_20260911")["consensus_value"] == 0.31
    # D-1: 수집 + 동결
    r1 = run_collection(datetime(2026, 9, 10, 0, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.2)}, alert)
    assert [(r.stage, r.status, r.value, r.grade) for r in r1] == [("D-1", "frozen", 0.2, "A")]
    row = reg.get("US_CPI_20260911")
    assert row["frozen"] and row["grade"] == "A" and row["consensus_value"] == 0.2
    assert row["frozen_ts"] == datetime(2026, 9, 10, 0, tzinfo=UTC)
    # 동결 후 재실행: 대상에서 제외
    assert run_collection(datetime(2026, 9, 10, 12, tzinfo=UTC), cal, reg, cols, alert) == []
    assert read_alerts(alerts_path) == []
    # 동결 후 수집기가 다른 값을 가져와도 UPDATE 불가
    with pytest.raises(FrozenError):
        reg.upsert_consensus("US_CPI_20260911", 0.9, "%", "x", "auto:x", datetime(2026, 9, 10, 1, tzinfo=UTC))


def test_d3_fail_alert_then_d1_success(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r3 = run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _fail_collector("403")}, alert)
    assert r3[0].status == "failed" and reg.get("US_CPI_20260911")["consensus_value"] is None
    al = read_alerts(alerts_path)
    assert len(al) == 1 and al[0]["kind"] == "COLLECT_FAIL" and "403" in al[0]["detail"]["error"]
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.25)}, alert)
    assert r1[0].status == "frozen" and r1[0].grade == "A"


def test_d1_fail_degrades_to_C_with_alerts(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _fail_collector("blocked")}, alert)
    assert [(r.stage, r.status, r.grade) for r in r1] == [("D-1", "degraded_C", "C")]
    row = reg.get("US_CPI_20260911")
    assert row["frozen"] and row["grade"] == "C" and row["consensus_value"] is None
    kinds = [a["kind"] for a in read_alerts(alerts_path)]
    assert kinds == ["COLLECT_FAIL", "DEGRADE_C"]
    # 격하 후 수동 입력도 거부 (사후 등록 금지)
    with pytest.raises(FrozenError):
        reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", datetime(2026, 9, 10, 1, tzinfo=UTC))


def test_d3_fail_manual_input_then_d1_fail_keeps_manual_grade_A(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _fail_collector()}, alert)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", datetime(2026, 9, 9, tzinfo=UTC))
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _fail_collector()}, alert)
    assert r1[0].status == "frozen" and r1[0].grade == "A" and r1[0].value == 0.3
    assert reg.get("US_CPI_20260911")["entered_by"] == "manual:chungpyo"
    assert [a["kind"] for a in read_alerts(alerts_path)] == ["COLLECT_FAIL", "COLLECT_FAIL"]


def test_collector_returning_post_schedule_vintage_is_rejected(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])

    def bad(event, *, now=None, **_):
        return {"value": 0.3, "unit": "%", "source": "s", "source_url": "u",
                "fetched_at": event.scheduled_ts_utc + timedelta(minutes=1)}

    r = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": bad}, alert)
    assert r[0].status == "degraded_C"
    assert "VintageError" in r[0].detail


def test_late_freeze_without_registration_records_grade_C(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r = run_collection(datetime(2026, 9, 12, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert)
    assert [(x.stage, x.status, x.grade) for x in r] == [("late", "degraded_C", "C")]
    kinds = [a["kind"] for a in read_alerts(alerts_path)]
    assert kinds == ["LATE_FREEZE", "DEGRADE_C"]
    assert run_collection(datetime(2026, 9, 13, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert) == []


def test_unconfirmed_schedule_alert_and_missing_collector(env):
    reg, alerts_path, alert = env
    ev = _event(status="unconfirmed")
    cal = Calendar("t", {"US_CPI": SPEC}, [ev])
    r = run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {}, alert)  # 수집기 없음 → 실패
    assert r[0].status == "failed"
    assert [a["kind"] for a in read_alerts(alerts_path)] == ["UNCONFIRMED_SCHEDULE", "COLLECT_FAIL"]


# ---------- 운영 결정 ① single_fetch (2026-08-17) ----------
def test_d3_impossible_then_d1_only_marks_single_fetch(env):
    """D-3 실패(주간 피드 밖) → D-1 성공 = single_fetch=True."""
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r3 = run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _fail_collector("not in this-week feed")}, alert)
    assert r3[0].status == "failed"
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.25)}, alert)
    assert r1[0].status == "frozen" and r1[0].grade == "A" and "single_fetch" in r1[0].detail
    row = reg.get("US_CPI_20260911")
    assert row["single_fetch"] is True and row["consensus_value"] == 0.25 and row["manual_override"] is False


def test_d3_never_ran_then_d1_only_marks_single_fetch(env):
    """D-3 미실행(크론 결손) → D-1 에서만 수집 = single_fetch=True."""
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.25)}, alert)
    assert r1[0].status == "frozen"
    assert reg.get("US_CPI_20260911")["single_fetch"] is True


def test_d3_success_then_d1_success_not_single_fetch(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    r3 = run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.3)}, alert)
    assert r3[0].status == "collected" and reg.get("US_CPI_20260911")["single_fetch"] is False
    run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.2)}, alert)
    row = reg.get("US_CPI_20260911")
    assert row["frozen"] and row["consensus_value"] == 0.2 and row["single_fetch"] is False


# ---------- AM-4 역방향: 수동 입력이 자동을 이긴다 ----------
def test_manual_then_d1_auto_keeps_manual_and_shadows_auto(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _fail_collector()}, alert)
    # 발주자 수동 입력 (add-manual 경로와 동일한 upsert)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", datetime(2026, 9, 9, tzinfo=UTC))
    assert reg.get("US_CPI_20260911")["manual_override"] is True
    # D-1 자동 수집 성공 → 기록만
    r1 = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.2)}, alert)
    assert r1[0].status == "frozen" and r1[0].grade == "A"
    assert r1[0].value == 0.3 and r1[0].source == "manual:chungpyo" and "manual_override" in r1[0].detail
    row = reg.get("US_CPI_20260911")
    assert row["frozen"] and row["consensus_value"] == 0.3 and row["entered_by"] == "manual:chungpyo"
    assert row["vintage_ts"] == datetime(2026, 9, 9, tzinfo=UTC)
    assert row["auto_shadow_value"] == 0.2 and row["auto_shadow_vintage_ts"] == datetime(2026, 9, 10, tzinfo=UTC)
    assert row["auto_shadow_source"] == "fake_src https://x"
    assert [a["kind"] for a in read_alerts(alerts_path)] == ["COLLECT_FAIL"]  # D-1 자동 성공은 알림 없음


def test_manual_then_d3_auto_is_shadowed_status(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    reg.register_event("US_CPI_20260911", "US_CPI", SPEC.asset_scope, _event().scheduled_ts_utc, "A1_open")
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", datetime(2026, 9, 7, tzinfo=UTC))
    r3 = run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.2)}, alert)
    assert r3[0].status == "shadowed" and r3[0].value == 0.2
    row = reg.get("US_CPI_20260911")
    assert row["consensus_value"] == 0.3 and row["auto_shadow_value"] == 0.2 and row["frozen"] is False


def test_manual_override_false_auto_overwrites_as_before(env):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.3)}, alert)
    run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.2)}, alert)
    row = reg.get("US_CPI_20260911")
    assert row["consensus_value"] == 0.2 and row["manual_override"] is False and row["auto_shadow_value"] is None


# ---------- 운영 결정 ⑤ 미확인 일정 D-7 재확인 ----------
def test_select_targets_d7_only_for_unconfirmed():
    ev_c = _event()  # confirmed, sched 2026-09-11
    ev_u = _event(status="unconfirmed")
    assert select_targets([ev_c], datetime(2026, 9, 4, tzinfo=UTC)) == []
    assert select_targets([ev_u], datetime(2026, 9, 4, tzinfo=UTC)) == [(ev_u, STAGE_D7)]
    assert select_targets([ev_u], datetime(2026, 9, 5, tzinfo=UTC)) == [(ev_u, STAGE_D7)]  # 캐치업 D-6
    assert select_targets([ev_u], datetime(2026, 9, 3, tzinfo=UTC)) == []
    assert select_targets([ev_u], datetime(2026, 9, 8, tzinfo=UTC)) == [(ev_u, STAGE_D3)]  # D-3 는 기존 로직


def test_unconfirmed_d7_recheck_notifies_without_registration(env, notifier):
    reg, alerts_path, alert = env
    ev = _event(status="unconfirmed")
    cal = Calendar("t", {"US_CPI": SPEC}, [ev])
    r = run_collection(datetime(2026, 9, 4, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert, notify=notifier)
    assert [(x.stage, x.status) for x in r] == [(STAGE_D7, "recheck")]
    assert "US_CPI_20260911" not in reg  # D-7 은 등록·수집·동결 없음
    al = read_alerts(alerts_path)
    assert len(al) == 1
    assert al[0]["kind"] == UNCONFIRMED_SCHEDULE_D7 and al[0]["level"] == "info"
    assert al[0]["detail"]["event_id"] == "US_CPI_20260911" and al[0]["detail"]["days_left"] == 7
    # D-3/D-1 에서 여전히 unconfirmed 면 기존 UNCONFIRMED_SCHEDULE(loud) 유지
    run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert, notify=notifier)
    kinds = [a["kind"] for a in read_alerts(alerts_path)]
    assert kinds == [UNCONFIRMED_SCHEDULE_D7, "UNCONFIRMED_SCHEDULE"]


def test_tentative_schedule_also_gets_d7_recheck(env, notifier):
    """발주자 확정 2026-08-17 (계획서 §12.5): D-7 재확인은 unconfirmed 뿐 아니라 tentative 에도 발동. schedule_status 가 그대로 알림에 실린다."""
    assert D7_STATUSES == ("unconfirmed", "tentative")
    reg, alerts_path, alert = env
    ev = _event(status="tentative")
    assert select_targets([ev], datetime(2026, 9, 4, tzinfo=UTC)) == [(ev, STAGE_D7)]
    assert select_targets([ev], datetime(2026, 9, 5, tzinfo=UTC)) == [(ev, STAGE_D7)]   # 캐치업 D-6
    cal = Calendar("t", {"US_CPI": SPEC}, [ev])
    r = run_collection(datetime(2026, 9, 4, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert, notify=notifier)
    assert [(x.stage, x.status) for x in r] == [(STAGE_D7, "recheck")]
    assert "US_CPI_20260911" not in reg
    al = read_alerts(alerts_path)
    assert len(al) == 1 and al[0]["kind"] == UNCONFIRMED_SCHEDULE_D7 and al[0]["level"] == "info"
    assert al[0]["detail"]["schedule_status"] == "tentative" and al[0]["detail"]["days_left"] == 7
    # D-3 에서는 등록되며 레지스트리 행에 schedule_status=tentative 가 실린다 (+ 기존 UNCONFIRMED_SCHEDULE loud)
    run_collection(datetime(2026, 9, 8, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert, notify=notifier)
    assert reg.get("US_CPI_20260911")["schedule_status"] == "tentative"
    assert [a["kind"] for a in read_alerts(alerts_path)] == [UNCONFIRMED_SCHEDULE_D7, "UNCONFIRMED_SCHEDULE"]


def test_confirmed_event_has_no_d7_notice(env, notifier):
    reg, alerts_path, alert = env
    cal = Calendar("t", {"US_CPI": SPEC}, [_event()])
    assert run_collection(datetime(2026, 9, 4, tzinfo=UTC), cal, reg, {"fake": _ok_collector()}, alert, notify=notifier) == []
    assert read_alerts(alerts_path) == []


def test_multiple_events_independent(env):
    reg, alerts_path, alert = env
    e1 = _event("US_CPI_20260911", date(2026, 9, 11))
    e2 = _event("US_CPI_20260913", date(2026, 9, 13))
    cal = Calendar("t", {"US_CPI": SPEC}, [e1, e2])
    r = run_collection(datetime(2026, 9, 10, tzinfo=UTC), cal, reg, {"fake": _ok_collector(0.1)}, alert)
    assert {(x.event_id, x.stage, x.status) for x in r} == {
        ("US_CPI_20260911", "D-1", "frozen"), ("US_CPI_20260913", "D-3", "collected")}
