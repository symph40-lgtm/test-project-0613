"""컨센서스 레지스트리 — 사전 동결·vintage·사후 수정 거부 (WORKORDER §5-1·2·4, D3 개정)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from mtpro.events.registry import (
    ConsensusRegistry, FrozenError, RegistryError, UnknownEventError, VintageError, EVENT_TYPES,
)

UTC = timezone.utc
SCHED = datetime(2026, 9, 11, 12, 30, tzinfo=UTC)  # US_CPI 08:30 ET


@pytest.fixture
def reg(tmp_path):
    return ConsensusRegistry(tmp_path / "consensus_registry.parquet")


def _register(reg, eid="US_CPI_20260911", et="US_CPI", sched=SCHED):
    return reg.register_event(eid, et, ["KOSPI200", "005930", "000660"], sched, "A1_open")


def test_register_and_persist_roundtrip(reg, tmp_path):
    row = _register(reg)
    assert row["frozen"] is False and row["grade"] is None and row["consensus_value"] is None
    reg2 = ConsensusRegistry(tmp_path / "consensus_registry.parquet")
    got = reg2.get("US_CPI_20260911")
    assert got is not None
    assert got["asset_scope"] == ["KOSPI200", "005930", "000660"]
    assert got["scheduled_ts_utc"] == SCHED
    assert got["t0_mode"] == "A1_open"
    assert got["consensus_value"] is None  # NaN 아닌 None


def test_register_rejects_bad_enum(reg):
    with pytest.raises(RegistryError):
        reg.register_event("BOK_20260828", "BOK_RATE", ["KOSPI200"], SCHED, "release_time")  # 금통위 제외
    with pytest.raises(RegistryError):
        reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200"], SCHED, "open")
    with pytest.raises(RegistryError):
        reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200"], SCHED.replace(tzinfo=None), "A1_open")
    assert len(EVENT_TYPES) == 7


def test_register_duplicate(reg):
    _register(reg)
    with pytest.raises(RegistryError):
        _register(reg)
    # exist_ok + 동일 필드는 허용
    reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200", "005930", "000660"], SCHED, "A1_open", exist_ok=True)
    with pytest.raises(RegistryError):
        reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200"], SCHED, "A1_open", exist_ok=True)


def test_upsert_then_freeze_grade_A(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "forexfactory", "auto:forexfactory", v)
    row = reg.upsert_consensus("US_CPI_20260911", 0.2, "%", "forexfactory", "auto:forexfactory", v + timedelta(hours=1))
    assert row["consensus_value"] == 0.2  # 동결 전 upsert 는 덮어씀
    frozen = reg.freeze("US_CPI_20260911", v + timedelta(hours=2))
    assert frozen["frozen"] is True and frozen["grade"] == "A"
    assert frozen["frozen_ts"] == v + timedelta(hours=2)


def test_frozen_update_rejected_hard(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v)
    reg.freeze("US_CPI_20260911", v)
    with pytest.raises(FrozenError):
        reg.upsert_consensus("US_CPI_20260911", 0.4, "%", "ff", "manual:chungpyo", v + timedelta(minutes=1))
    with pytest.raises(FrozenError):
        reg.freeze("US_CPI_20260911", v + timedelta(minutes=1))
    assert reg.get("US_CPI_20260911")["consensus_value"] == 0.3


def test_vintage_after_schedule_rejected(reg):
    _register(reg)
    with pytest.raises(VintageError):
        reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", SCHED)  # ==
    with pytest.raises(VintageError):
        reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", SCHED + timedelta(seconds=1))
    assert reg.get("US_CPI_20260911")["consensus_value"] is None


def test_upsert_requires_number_and_entered_by_format(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    with pytest.raises(RegistryError):
        reg.upsert_consensus("US_CPI_20260911", None, "%", "ff", "auto:ff", v)  # 조용한 None 금지
    with pytest.raises(RegistryError):
        reg.upsert_consensus("US_CPI_20260911", float("nan"), "%", "ff", "auto:ff", v)
    with pytest.raises(RegistryError):
        reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "chungpyo", v)  # auto:/manual: 접두 필수
    with pytest.raises(UnknownEventError):
        reg.upsert_consensus("US_CPI_20991231", 0.3, "%", "ff", "auto:ff", v)


def test_freeze_without_value_is_grade_C(reg):
    _register(reg)
    row = reg.freeze("US_CPI_20260911", SCHED - timedelta(days=1))
    assert row["grade"] == "C" and row["frozen"] is True and row["consensus_value"] is None
    with pytest.raises(FrozenError):  # 격하 후 값 밀어넣기 불가
        reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "manual:x", SCHED - timedelta(hours=1))


def test_supersede_keeps_history(reg, tmp_path):
    _register(reg)
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v)
    reg.freeze("US_CPI_20260911", v)
    new = reg.supersede("US_CPI_20260911", 0.25, "%", "manual", "manual:chungpyo", v + timedelta(hours=3),
                        note="정정", freeze_at=v + timedelta(hours=3))
    assert new["event_id"] == "US_CPI_20260911~r2"
    assert new["supersedes"] == "US_CPI_20260911" and new["frozen"] is True and new["grade"] == "A"
    old = reg.get("US_CPI_20260911")
    assert old["consensus_value"] == 0.3 and old["frozen"] is True  # 원 행 보존
    assert reg.effective("US_CPI_20260911")["consensus_value"] == 0.25
    # 정정도 vintage 규칙 적용
    with pytest.raises(VintageError):
        reg.supersede("US_CPI_20260911~r2", 0.1, "%", "manual", "manual:chungpyo", SCHED + timedelta(hours=1))
    # 재적재 후 supersedes 유지
    reg2 = ConsensusRegistry(tmp_path / "consensus_registry.parquet")
    assert reg2.get("US_CPI_20260911~r2")["supersedes"] == "US_CPI_20260911"
    assert len(reg2) == 2


def test_set_actual_rules(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    with pytest.raises(RegistryError):  # 동결 전 실제값 금지
        reg.set_actual("US_CPI_20260911", 0.2, SCHED, SCHED)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v)
    reg.freeze("US_CPI_20260911", v)
    with pytest.raises(RegistryError):  # available_at < actual_ts
        reg.set_actual("US_CPI_20260911", 0.2, SCHED, SCHED - timedelta(minutes=1))
    row = reg.set_actual("US_CPI_20260911", 0.2, SCHED, SCHED + timedelta(minutes=5))
    assert row["actual_value"] == 0.2 and row["available_at"] == SCHED + timedelta(minutes=5)
    with pytest.raises(FrozenError):
        reg.set_actual("US_CPI_20260911", 0.1, SCHED, SCHED + timedelta(minutes=5))


# ---------- 운영 결정 ① single_fetch / AM-4 manual_override (2026-08-17) ----------
def test_new_fields_default_and_roundtrip(reg, tmp_path):
    row = _register(reg)
    assert row["single_fetch"] is False and row["manual_override"] is False
    assert row["auto_shadow_value"] is None and row["auto_shadow_vintage_ts"] is None and row["auto_shadow_source"] is None
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v, single_fetch=True)
    reg2 = ConsensusRegistry(tmp_path / "consensus_registry.parquet")
    got = reg2.get("US_CPI_20260911")
    assert got["single_fetch"] is True and got["manual_override"] is False
    assert got["auto_shadow_value"] is None  # NaN 아닌 None


def test_single_fetch_flag_set_only_when_given(reg):
    _register(reg)
    v = SCHED - timedelta(days=3)
    # D-3 성공(single_fetch=False) → D-1 성공(single_fetch=False): 둘 다 성공이면 False
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v, single_fetch=False)
    row = reg.upsert_consensus("US_CPI_20260911", 0.2, "%", "ff", "auto:ff", v + timedelta(days=2), single_fetch=False)
    assert row["single_fetch"] is False
    # None 이면 건드리지 않음
    reg.upsert_consensus("US_CPI_20260911", 0.25, "%", "ff", "auto:ff", v + timedelta(days=2, hours=1), single_fetch=True)
    row = reg.upsert_consensus("US_CPI_20260911", 0.26, "%", "ff", "auto:ff", v + timedelta(days=2, hours=2))
    assert row["single_fetch"] is True
    frozen = reg.freeze("US_CPI_20260911", v + timedelta(days=2, hours=3))
    assert frozen["single_fetch"] is True and frozen["grade"] == "A"


def test_manual_then_auto_keeps_manual_and_shadows_auto(reg, tmp_path):
    """AM-4 역방향: 수동 후 자동 → 동결값은 수동, 자동값은 auto_shadow_* 에 보존."""
    _register(reg)
    vm = SCHED - timedelta(days=2)
    row = reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", vm)
    assert row["manual_override"] is True and row["auto_shadow_value"] is None
    va = SCHED - timedelta(days=1)
    row = reg.upsert_consensus("US_CPI_20260911", 0.2, "%", "forexfactory https://ff", "auto:forexfactory", va,
                               single_fetch=True)
    # 동결 대상 필드는 수동값 유지
    assert row["consensus_value"] == 0.3 and row["entered_by"] == "manual:chungpyo" and row["vintage_ts"] == vm
    assert row["source"] == "manual" and row["manual_override"] is True
    # 자동값은 기록만
    assert row["auto_shadow_value"] == 0.2 and row["auto_shadow_vintage_ts"] == va
    assert row["auto_shadow_source"] == "forexfactory https://ff"
    assert row["single_fetch"] is True  # 자동 수집 이력 표기는 남는다
    frozen = reg.freeze("US_CPI_20260911", va + timedelta(hours=1))
    assert frozen["grade"] == "A" and frozen["consensus_value"] == 0.3 and frozen["entered_by"] == "manual:chungpyo"
    # 재적재 후에도 동일
    reg2 = ConsensusRegistry(tmp_path / "consensus_registry.parquet")
    got = reg2.get("US_CPI_20260911")
    assert got["consensus_value"] == 0.3 and got["auto_shadow_value"] == 0.2 and got["manual_override"] is True
    # shadow 기록도 vintage 규칙 적용 (사후 입력 금지) — 동결 전 상태로 확인
    reg3 = ConsensusRegistry(tmp_path / "x.parquet")
    _register(reg3)
    reg3.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", vm)
    with pytest.raises(VintageError):
        reg3.upsert_consensus("US_CPI_20260911", 0.2, "%", "ff", "auto:ff", SCHED)


def test_auto_then_manual_manual_wins_and_previous_auto_preserved(reg):
    _register(reg)
    va = SCHED - timedelta(days=3)
    reg.upsert_consensus("US_CPI_20260911", 0.2, "%", "ff", "auto:ff", va)
    vm = SCHED - timedelta(days=2)
    row = reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "manual", "manual:chungpyo", vm)
    assert row["consensus_value"] == 0.3 and row["entered_by"] == "manual:chungpyo" and row["manual_override"] is True
    assert row["auto_shadow_value"] == 0.2 and row["auto_shadow_vintage_ts"] == va and row["auto_shadow_source"] == "ff"
    # 이후 자동(D-1) 은 shadow 갱신만
    row = reg.upsert_consensus("US_CPI_20260911", 0.25, "%", "ff2", "auto:ff2", SCHED - timedelta(days=1))
    assert row["consensus_value"] == 0.3 and row["auto_shadow_value"] == 0.25 and row["auto_shadow_source"] == "ff2"


def test_manual_override_false_auto_applies_as_before(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v)
    row = reg.upsert_consensus("US_CPI_20260911", 0.2, "%", "ff", "auto:ff", v + timedelta(hours=1))
    assert row["consensus_value"] == 0.2 and row["manual_override"] is False and row["auto_shadow_value"] is None


def test_supersede_manual_sets_override_on_new_row(reg):
    _register(reg)
    v = SCHED - timedelta(days=1)
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", v)
    reg.freeze("US_CPI_20260911", v)
    new = reg.supersede("US_CPI_20260911", 0.25, "%", "manual", "manual:chungpyo", v + timedelta(hours=3),
                        freeze_at=v + timedelta(hours=3))
    assert new["manual_override"] is True and new["single_fetch"] is False
    assert reg.get("US_CPI_20260911")["manual_override"] is False  # 원 행 불변


def test_list_filters(reg):
    _register(reg)
    _register(reg, "US_NFP_20260904", "US_NFP", datetime(2026, 9, 4, 12, 30, tzinfo=UTC))
    reg.freeze("US_NFP_20260904", datetime(2026, 9, 3, tzinfo=UTC))
    assert [r["event_id"] for r in reg.list()] == ["US_NFP_20260904", "US_CPI_20260911"]
    assert [r["event_id"] for r in reg.list(frozen=True)] == ["US_NFP_20260904"]
    assert [r["event_id"] for r in reg.list(grade="C")] == ["US_NFP_20260904"]
    assert [r["event_id"] for r in reg.list(event_type="US_CPI")] == ["US_CPI_20260911"]
