"""T5-1 이벤트 독립성·purge — 계획서 §2.2 규칙·§2.3 9월 실례(캘린더 계산으로 검증, 하드코딩 기대값 아님)·검증 쌍·config 일치.

원칙: 9월 실례의 t0 는 XKRX 캘린더로 **계산**해 계획서 표(2026-08-17 계산 예시값)와 대조한다. 표와 다르면 문서 표를 의심한다
(§12.5: 코드가 매 실행 시 재계산). 알려진 차이: NFP 10/2 → 표 10/5, 캘린더 10/6 (10/5 = 개천절 10/3(토) 대체공휴일).
"""
from __future__ import annotations

import pathlib
from datetime import date, datetime, time, timezone

import pytest
import yaml

from mtpro.events import independence as I
from mtpro.events import kr_calendar as KC
from mtpro.events.calendar import load_calendar
from mtpro.events.registry import ConsensusRegistry, INDEPENDENCE_COLUMNS, RegistryError
from mtpro.schema import CONTAMINATION_REASONS, SCHEDULE_STATUSES, SILVER_CONSENSUS_REGISTRY, SILVER_EVENTS_KR

UTC = timezone.utc
CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cal() -> KC.KrCalendar:
    return KC.load_xkrx(date(2020, 1, 1))


def _ev(eid: str, et: str, ts: datetime, *, grade="A", status="confirmed", cons=1.0, actual=1.1, surprise_z=None, **kw):
    d = {"event_id": eid, "event_type": et, "scheduled_ts_utc": ts, "t0_mode": "A1_open", "grade": grade,
         "schedule_status": status, "consensus_value": cons, "actual_value": actual}
    if surprise_z is not None:
        d["surprise_z"] = surprise_z
    d.update(kw)
    return d


def _by_id(rows):
    return {r["event_id"]: r for r in rows}


# ---------------------------------------------------------------------------
# 사전 등록 상수 = config
# ---------------------------------------------------------------------------
def test_config_constants_match_module():
    c = CFG["events"]["independence"]
    assert c["w_digest"] == I.W_DIGEST == 5
    assert c["earnings_cluster_sessions"] == I.EARNINGS_CLUSTER_SESSIONS == 3
    assert tuple(c["earnings_types"]) == I.EARNINGS_TYPES == ("SEC_PRELIM", "HYNIX_EARN", "NVDA_EARN")
    assert c["calendar"] == I.CALENDAR == KC.CALENDAR_NAME == "XKRX"
    assert c["boundary"] == I.BOUNDARY == KC.BOUNDARY_RULE == "release < 09:00 KST → same session"
    assert (c["surprise_z_good"], c["surprise_z_bad"]) == (I.SURPRISE_Z_GOOD, I.SURPRISE_Z_BAD) == (0.3, -0.3)
    assert tuple(c["challengers"]) == I.CHALLENGERS == ("IND-C1", "IND-C2")
    # enum·스키마
    assert I.REASONS == CONTAMINATION_REASONS == (
        "OVERLAP_DIGEST_WINDOW", "SAME_DAY_MULTI", "EARNINGS_CLUSTER", "PSA_PENDING_SHOCK", "DATA_GAP")
    assert SCHEDULE_STATUSES == ("confirmed", "unconfirmed", "tentative")
    for col in ("schedule_status", "t0_kr", "digest_window_end", "independence_flag", "overlap_group", "contamination_reason", "verify_eligible"):
        assert col in SILVER_CONSENSUS_REGISTRY.names and col in SILVER_EVENTS_KR.names
    assert set(INDEPENDENCE_COLUMNS) <= set(SILVER_CONSENSUS_REGISTRY.names)


# ---------------------------------------------------------------------------
# 9월 실례 (계획서 §2.3) — 캘린더 계산 vs 표
# ---------------------------------------------------------------------------
def test_september_t0_computed_from_calendar_vs_plan_table(cal):
    events = load_calendar().events
    rows = _by_id(I.assign_t0([e.as_dict() for e in events], cal))
    # 표의 예시값 — 캘린더로 재계산한 값과 대조 (t0 = next_open_after 를 각 이벤트에 직접 적용한 것과 동일해야 한다)
    for e in events:
        assert rows[e.event_id]["t0_kr"] == cal.next_open_after(e.scheduled_ts_utc), e.event_id
        assert rows[e.event_id]["digest_window_end"] == cal.add_sessions(rows[e.event_id]["t0_kr"], I.W_DIGEST - 1)
        assert rows[e.event_id]["calendar_source"] == KC.SOURCE_XKRX
    plan = {  # 계획서 §2.3 표 (2026-08-17 계산 예시값)
        "US_NFP_20260904": date(2026, 9, 7), "US_CPI_20260911": date(2026, 9, 14), "FOMC_20260916": date(2026, 9, 17),
        "US_PCE_20260930": date(2026, 10, 1), "US_NFP_20261002": date(2026, 10, 5), "SEC_PRELIM_20261008": date(2026, 10, 8),
    }
    for eid, t0_plan in plan.items():
        t0 = rows[eid]["t0_kr"]
        if eid == "US_NFP_20261002":
            # 표 10/5 는 개천절 대체공휴일(10/3 토 → 10/5 월) 을 놓친 값. 캘린더가 10/5 를 세션이라 하면 표대로, 아니면 다음 세션 10/6.
            expected = t0_plan if cal.is_session(t0_plan) else cal.next_session_after(t0_plan)
            assert t0 == expected == date(2026, 10, 6)
        else:
            assert t0 == t0_plan, f"{eid}: calendar {t0} != plan {t0_plan}"
    # 소화 창 (표): NFP 9/7~9/11, CPI 9/14~9/18, FOMC 9/17·18·21·22·23 (추석 9/24·25 창 밖), PCE 10/1~ (10/1·2·6·7·8: 10/5 대체휴일)
    win = lambda eid: cal.sessions_between(rows[eid]["t0_kr"], rows[eid]["digest_window_end"])  # noqa: E731
    assert win("US_NFP_20260904") == [date(2026, 9, 7), date(2026, 9, 8), date(2026, 9, 9), date(2026, 9, 10), date(2026, 9, 11)]
    assert win("US_CPI_20260911") == [date(2026, 9, 14), date(2026, 9, 15), date(2026, 9, 16), date(2026, 9, 17), date(2026, 9, 18)]
    assert win("FOMC_20260916") == [date(2026, 9, 17), date(2026, 9, 18), date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23)]
    assert not cal.is_session(date(2026, 9, 24)) and not cal.is_session(date(2026, 9, 25))
    assert win("US_PCE_20260930") == [date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 6), date(2026, 10, 7), date(2026, 10, 8)]
    assert win("US_NFP_20261002") == [date(2026, 10, 6), date(2026, 10, 7), date(2026, 10, 8), date(2026, 10, 12), date(2026, 10, 13)]
    assert not cal.is_session(date(2026, 10, 9))   # 한글날
    # 8/26 PCE + NVDA(8/27 05:20 KST) → 같은 t0 8/27
    assert rows["US_PCE_20260826"]["t0_kr"] == rows["NVDA_EARN_20260826"]["t0_kr"] == date(2026, 8, 27)
    assert rows["US_PCE_20260826"]["digest_window_end"] == date(2026, 9, 2)


def test_september_independence_flags(cal):
    events = [e.as_dict() | {"grade": "A", "consensus_value": 1.0, "actual_value": 1.2} for e in load_calendar().events]
    fl = _by_id(I.flag_independence(events, cal))
    # NFP 9/4 → 9/7: PCE 8/26 창(8/27~9/2) 밖 → 독립
    assert fl["US_NFP_20260904"]["independence_flag"] is True and fl["US_NFP_20260904"]["contamination_reason"] is None
    # CPI 9/11 → 9/14: NFP 창 9/11 종료 → 독립
    assert fl["US_CPI_20260911"]["independence_flag"] is True and fl["US_CPI_20260911"]["verify_eligible"] is True
    # FOMC 9/17 ∈ CPI 창(9/14~9/18) → 비독립, overlap_group = CPI; CPI 는 독립 유지(먼저 온 정보)
    f = fl["FOMC_20260916"]
    assert f["independence_flag"] is False and f["contamination_reason"] == "OVERLAP_DIGEST_WINDOW"
    assert f["overlap_group"] == "US_CPI_20260911" and f["verify_eligible"] is False
    # PCE 9/30 → 10/1: FOMC 창 9/17~9/23 밖 → 독립
    assert fl["US_PCE_20260930"]["independence_flag"] is True and fl["US_PCE_20260930"]["verify_eligible"] is True
    # NFP 10/2 → 10/6 ∈ PCE 창(10/1~10/8) → 비독립, group = PCE
    n = fl["US_NFP_20261002"]
    assert n["independence_flag"] is False and n["overlap_group"] == "US_PCE_20260930"
    assert n["contamination_reason"] == "OVERLAP_DIGEST_WINDOW"
    # SEC 10/8 (tentative): NFP 창(10/6·7·8·12·13) 안 (+ 재계산 시 PCE 창 10/8 까지) → 비독립, group = 가장 이른 원인의 체인 = PCE
    s = fl["SEC_PRELIM_20261008"]
    assert s["independence_flag"] is False and s["contamination_reason"] == "OVERLAP_DIGEST_WINDOW"
    assert s["overlap_group"] == "US_PCE_20260930"                       # 원인 체인 상속 (NFP 의 group = PCE)
    assert "EARNINGS_CLUSTER" not in s["contamination_reason"]           # NFP 는 매크로 — 실적 클러스터 아님
    assert s["schedule_status"] == "tentative" and s["verify_eligible"] is False   # tentative → 검증 불가 (독립이었어도)
    # 8/26 PCE + NVDA → t0 8/27 → SAME_DAY_MULTI 둘 다 비독립, group = 정렬 결합
    for eid in ("US_PCE_20260826", "NVDA_EARN_20260826"):
        assert fl[eid]["independence_flag"] is False and fl[eid]["contamination_reason"] == "SAME_DAY_MULTI"
        assert fl[eid]["overlap_group"] == "NVDA_EARN_20260826+US_PCE_20260826"
        assert fl[eid]["verify_eligible"] is False
    # 사유는 enum 만
    for r in fl.values():
        for reason in (r["contamination_reason"] or "").split(";"):
            assert reason == "" or reason in CONTAMINATION_REASONS


def test_september_verification_pairs_skip_fomc(cal):
    """계획서 §2.3 검증 쌍 예: MT_{9/16} → e*=FOMC 비독립 건너뜀 → e*=PCE(10/1); 추론 표본은 (MT_{9/30}, PCE) 1건, 9/16..9/29 서술 전용."""
    events = [e.as_dict() | {"grade": "A", "consensus_value": 1.0, "actual_value": 1.2} for e in load_calendar().events]
    events = [dict(e, surprise_z=(0.8 if e["event_id"] == "US_PCE_20260930" else -0.9)) for e in events]
    fl = I.flag_independence(events, cal)
    mt_dates = cal.sessions_between(date(2026, 9, 14), date(2026, 9, 30))
    pairs = I.verification_pairs(mt_dates, fl, cal)
    p = {x["mt_date"]: x for x in pairs}
    assert p[date(2026, 9, 14)]["event_id"] == "US_PCE_20260930"           # CPI 9/14 는 t0_kr > t 아님, FOMC 비독립 → PCE
    assert p[date(2026, 9, 16)]["event_id"] == "US_PCE_20260930" and p[date(2026, 9, 16)]["role"] == "descriptive"
    assert p[date(2026, 9, 30)]["event_id"] == "US_PCE_20260930" and p[date(2026, 9, 30)]["role"] == "inference"
    inf = [x for x in pairs if x["role"] == "inference"]
    assert len(inf) == 1 and inf[0]["mt_date"] == date(2026, 9, 30) and inf[0]["direction"] == "good" and inf[0]["label_ok"]
    assert all(x["role"] == "descriptive" for x in pairs if x["mt_date"] != date(2026, 9, 30))
    assert p[date(2026, 9, 30)]["sessions_ahead"] == 1 and p[date(2026, 9, 16)]["sessions_ahead"] == 9   # 9/17·18·21·22·23·28·29·30·10/1
    # e* 당 추론 1쌍: 9/7 직전 세션(9/4)에 상태가 있으면 NFP 9/4 → 9/7 도 1건 (CPI 9/14 는 9/11)
    pairs2 = I.verification_pairs(cal.sessions_between(date(2026, 9, 1), date(2026, 9, 30)), fl, cal)
    inf2 = [(x["mt_date"], x["event_id"]) for x in pairs2 if x["role"] == "inference"]
    assert inf2 == [(date(2026, 9, 4), "US_NFP_20260904"), (date(2026, 9, 11), "US_CPI_20260911"), (date(2026, 9, 30), "US_PCE_20260930")]
    assert sum(1 for x in pairs2 if x["event_id"] == "US_NFP_20260904") == 4   # 9/1·2·3·4
    s = I.summarize(fl, pairs2)
    assert s["n_inference"] == 3 and s["n_pairs"] == len(pairs2) and s["calendar_source"] == KC.SOURCE_XKRX


# ---------------------------------------------------------------------------
# 규칙 단위 테스트 (합성 이벤트)
# ---------------------------------------------------------------------------
def test_0900_boundary_in_assign_t0(cal):
    mon = date(2026, 9, 14)
    a = _ev("US_CPI_20260914", "US_CPI", KC.kst(mon, time(8, 59, 59)))
    b = _ev("US_NFP_20260914", "US_NFP", KC.kst(mon, time(9, 0, 0)))
    rows = _by_id(I.assign_t0([a, b], cal))
    assert rows["US_CPI_20260914"]["t0_kr"] == mon
    assert rows["US_NFP_20260914"]["t0_kr"] == date(2026, 9, 15)
    fl = _by_id(I.flag_independence([a, b], cal))
    assert fl["US_CPI_20260914"]["independence_flag"] is True
    assert fl["US_NFP_20260914"]["independence_flag"] is False and fl["US_NFP_20260914"]["overlap_group"] == "US_CPI_20260914"


def test_same_day_multi_and_chain_inheritance(cal):
    # 9/14 CPI(독립) → 9/16 두 이벤트 같은 t0(SAME_DAY) + CPI 창 안(OVERLAP): 사유 둘 다, group 은 원인 체인(CPI)
    cpi = _ev("US_CPI_20260911", "US_CPI", KC.kst(date(2026, 9, 11), time(21, 30)))
    x = _ev("US_NFP_20260915", "US_NFP", KC.kst(date(2026, 9, 15), time(21, 30)))
    y = _ev("US_PCE_20260915", "US_PCE", KC.kst(date(2026, 9, 15), time(21, 30)))
    fl = _by_id(I.flag_independence([cpi, x, y], cal))
    for eid in ("US_NFP_20260915", "US_PCE_20260915"):
        assert fl[eid]["t0_kr"] == date(2026, 9, 16)
        assert fl[eid]["contamination_reason"] == "SAME_DAY_MULTI;OVERLAP_DIGEST_WINDOW"
        assert fl[eid]["overlap_group"] == "US_CPI_20260911"
    # 체인: 9/22 이벤트는 (비독립인) 9/16 이벤트 창(9/16~9/22) 안 → 비독립, group = 원인의 group 상속 = CPI
    z = _ev("FOMC_20260921", "FOMC", KC.kst(date(2026, 9, 22), time(3, 0)))
    fl2 = _by_id(I.flag_independence([cpi, x, y, z], cal))
    assert fl2["FOMC_20260921"]["t0_kr"] == date(2026, 9, 22)
    assert fl2["FOMC_20260921"]["independence_flag"] is False and fl2["FOMC_20260921"]["overlap_group"] == "US_CPI_20260911"
    # 원인이 SAME_DAY 만 있는 경우(앞선 창 없음) → 그 결합 group 을 상속
    fl3 = _by_id(I.flag_independence([x, y, z], cal))
    assert fl3["FOMC_20260921"]["overlap_group"] == "US_NFP_20260915+US_PCE_20260915"
    # 창 종료 다음 세션은 독립: 9/16 + 4 = 9/22 → 9/23 은 밖
    w = _ev("FOMC_20260922", "FOMC", KC.kst(date(2026, 9, 23), time(3, 0)))
    fl4 = _by_id(I.flag_independence([x, y, w], cal))
    assert fl4["FOMC_20260922"]["independence_flag"] is True


def test_earnings_cluster(cal):
    sec = _ev("SEC_PRELIM_20261008", "SEC_PRELIM", KC.kst(date(2026, 10, 8), time(8, 0)))
    # 하닉 10/14 → 세션 거리 3 (10/8→12→13→14) → 클러스터 (+ SEC 창 10/8~10/15 안이라 OVERLAP 도)
    hy3 = _ev("HYNIX_EARN_20261014", "HYNIX_EARN", KC.kst(date(2026, 10, 14), time(7, 0)))
    fl = _by_id(I.flag_independence([sec, hy3], cal))
    assert fl["SEC_PRELIM_20261008"]["contamination_reason"] == "EARNINGS_CLUSTER"        # 앞선 쪽도 비독립 (양쪽)
    assert fl["SEC_PRELIM_20261008"]["independence_flag"] is False
    assert fl["HYNIX_EARN_20261014"]["contamination_reason"] == "OVERLAP_DIGEST_WINDOW;EARNINGS_CLUSTER"
    assert fl["HYNIX_EARN_20261014"]["overlap_group"] == "SEC_PRELIM_20261008"
    assert fl["SEC_PRELIM_20261008"]["overlap_group"] == "HYNIX_EARN_20261014+SEC_PRELIM_20261008"
    # 하닉 10/15 → 거리 4 → 클러스터 아님, 그러나 SEC 창(10/8·12·13·14·15) 안 → OVERLAP 만; SEC 는 독립 유지
    hy4 = _ev("HYNIX_EARN_20261015", "HYNIX_EARN", KC.kst(date(2026, 10, 15), time(7, 0)))
    fl2 = _by_id(I.flag_independence([sec, hy4], cal))
    assert fl2["SEC_PRELIM_20261008"]["independence_flag"] is True
    assert fl2["HYNIX_EARN_20261015"]["contamination_reason"] == "OVERLAP_DIGEST_WINDOW"
    # 하닉 10/16 → 거리 5, 창 밖 → 둘 다 독립
    hy5 = _ev("HYNIX_EARN_20261016", "HYNIX_EARN", KC.kst(date(2026, 10, 16), time(7, 0)))
    fl3 = _by_id(I.flag_independence([sec, hy5], cal))
    assert fl3["SEC_PRELIM_20261008"]["independence_flag"] and fl3["HYNIX_EARN_20261016"]["independence_flag"]
    # 매크로는 실적 클러스터 대상 아님 (같은 거리라도)
    cpi = _ev("US_CPI_20261013", "US_CPI", KC.kst(date(2026, 10, 13), time(21, 30)))   # t0 10/14
    fl4 = _by_id(I.flag_independence([sec, cpi], cal))
    assert "EARNINGS_CLUSTER" not in (fl4["US_CPI_20261013"]["contamination_reason"] or "")
    assert fl4["SEC_PRELIM_20261008"]["independence_flag"] is True
    # NVDA(8/27) 와 하닉(8/28, 거리 1) 클러스터, 3종 이외 무시
    nv = _ev("NVDA_EARN_20260826", "NVDA_EARN", datetime(2026, 8, 26, 20, 20, tzinfo=UTC))
    hy = _ev("HYNIX_EARN_20260828", "HYNIX_EARN", KC.kst(date(2026, 8, 28), time(7, 0)))
    fl5 = _by_id(I.flag_independence([nv, hy], cal))
    assert "EARNINGS_CLUSTER" in fl5["NVDA_EARN_20260826"]["contamination_reason"]
    assert fl5["HYNIX_EARN_20260828"]["contamination_reason"] == "OVERLAP_DIGEST_WINDOW;EARNINGS_CLUSTER"


def test_verify_eligible_requires_grade_A_values_and_not_tentative(cal):
    base = KC.kst(date(2026, 9, 11), time(21, 30))
    ok = _ev("US_CPI_20260911", "US_CPI", base)
    assert I.flag_independence([ok], cal)[0]["verify_eligible"] is True
    assert I.flag_independence([dict(ok, grade="C")], cal)[0]["verify_eligible"] is False
    assert I.flag_independence([dict(ok, grade=None)], cal)[0]["verify_eligible"] is False
    assert I.flag_independence([dict(ok, consensus_value=None)], cal)[0]["verify_eligible"] is False   # 결측 None
    assert I.flag_independence([dict(ok, actual_value=float("nan"))], cal)[0]["verify_eligible"] is False
    assert I.flag_independence([dict(ok, schedule_status="tentative")], cal)[0]["verify_eligible"] is False
    assert I.flag_independence([dict(ok, schedule_status="unconfirmed")], cal)[0]["verify_eligible"] is True   # unconfirmed ≠ tentative
    assert I.flag_independence([dict(ok, schedule_status=None)], cal)[0]["verify_eligible"] is True
    with pytest.raises(I.IndependenceError):
        I.flag_independence([dict(ok, schedule_status="maybe")], cal)
    # 독립성 필드는 tentative 여도 계산된다 (검증만 막음)
    r = I.flag_independence([dict(ok, schedule_status="tentative")], cal)[0]
    assert r["independence_flag"] is True and r["t0_kr"] == date(2026, 9, 14)


def test_verification_pairs_roles_directions_and_missing(cal):
    good = _ev("US_CPI_20260911", "US_CPI", KC.kst(date(2026, 9, 11), time(21, 30)), surprise_z=0.31)      # t0 9/14
    bad = _ev("US_PCE_20260930", "US_PCE", KC.kst(date(2026, 9, 30), time(21, 30)), surprise_z=-0.31)     # t0 10/1
    neutral = _ev("US_NFP_20261016", "US_NFP", KC.kst(date(2026, 10, 16), time(21, 30)), surprise_z=0.3)  # t0 10/19, 경계 = neutral
    nosz = _ev("FOMC_20261028", "FOMC", KC.kst(date(2026, 10, 29), time(3, 0)))                          # 10/29, surprise_z 없음
    fl = I.flag_independence([good, bad, neutral, nosz], cal)
    assert all(e["verify_eligible"] for e in fl)
    mt = cal.sessions_between(date(2026, 9, 7), date(2026, 10, 30))
    pairs = I.verification_pairs(mt, fl, cal)
    inf = {x["event_id"]: x for x in pairs if x["role"] == "inference"}
    assert set(inf) == {"US_CPI_20260911", "US_PCE_20260930", "US_NFP_20261016", "FOMC_20261028"}   # e* 당 정확히 1쌍
    assert inf["US_CPI_20260911"]["mt_date"] == date(2026, 9, 11) and inf["US_CPI_20260911"]["direction"] == "good"
    assert inf["US_PCE_20260930"]["mt_date"] == date(2026, 9, 30) and inf["US_PCE_20260930"]["direction"] == "bad"
    assert inf["US_NFP_20261016"]["mt_date"] == date(2026, 10, 16) and inf["US_NFP_20261016"]["direction"] == "neutral"
    assert inf["US_NFP_20261016"]["label_ok"] is False
    assert inf["FOMC_20261028"]["mt_date"] == date(2026, 10, 28) and inf["FOMC_20261028"]["direction"] is None
    assert inf["FOMC_20261028"]["label_ok"] is False and inf["FOMC_20261028"]["surprise_z"] is None
    # t0 당일(t0_kr > t 아님)은 다음 e* 로 넘어간다; 마지막 e* 이후 t 는 쌍 없음
    by_t = {x["mt_date"]: x for x in pairs}
    assert by_t[date(2026, 9, 14)]["event_id"] == "US_PCE_20260930"
    assert date(2026, 10, 29) not in by_t and date(2026, 10, 30) not in by_t
    # 직전 세션에 상태가 없으면 그 e* 의 추론 쌍은 생기지 않는다 (규칙 그대로: t = t0 직전 거래일 하나만)
    pairs2 = I.verification_pairs([d for d in mt if d != date(2026, 9, 30)], fl, cal)
    assert "US_PCE_20260930" not in {x["event_id"] for x in pairs2 if x["role"] == "inference"}
    assert I.direction_of(None) is None and I.direction_of(0.5) == "good" and I.direction_of(-0.5) == "bad" and I.direction_of(0.0) == "neutral"


def test_inputs_are_not_mutated_and_duplicates_rejected(cal):
    a = _ev("US_CPI_20260911", "US_CPI", KC.kst(date(2026, 9, 11), time(21, 30)))
    snapshot = dict(a)
    out = I.flag_independence([a], cal)
    assert a == snapshot and "t0_kr" not in a and out[0]["t0_kr"] == date(2026, 9, 14)
    with pytest.raises(I.IndependenceError):
        I.flag_independence([a, dict(a)], cal)
    with pytest.raises(I.IndependenceError):
        I.assign_t0([dict(a, scheduled_ts_utc=datetime(2026, 9, 11, 12, 30))], cal)   # naive
    # ISO 문자열 timestamp 도 허용 (calendar.as_dict 호환)
    assert I.assign_t0([dict(a, scheduled_ts_utc="2026-09-11T12:30:00+00:00")], cal)[0]["t0_kr"] == date(2026, 9, 14)


# ---------------------------------------------------------------------------
# 레지스트리 필드 추가 (호환·set_independence)
# ---------------------------------------------------------------------------
def test_registry_status_and_independence_roundtrip(tmp_path, cal):
    p = tmp_path / "reg.parquet"
    reg = ConsensusRegistry(p)
    ts = datetime(2026, 9, 11, 12, 30, tzinfo=UTC)
    row = reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200"], ts, "A1_open", schedule_status="confirmed")
    assert row["schedule_status"] == "confirmed" and row["independence_flag"] is None and row["verify_eligible"] is False
    with pytest.raises(RegistryError):
        reg.register_event("US_NFP_20260904", "US_NFP", ["KOSPI200"], ts, "A1_open", schedule_status="maybe")
    reg.register_event("SEC_PRELIM_20261008", "SEC_PRELIM", ["005930"], datetime(2026, 10, 7, 23, 0, tzinfo=UTC), "A1_open",
                       schedule_status="tentative")
    # exist_ok 재등록으로 schedule_status 갱신 (tentative → confirmed) 허용, 동결 대상 필드 아님
    reg.upsert_consensus("US_CPI_20260911", 0.3, "%", "ff", "auto:ff", datetime(2026, 9, 10, tzinfo=UTC))
    reg.freeze("US_CPI_20260911", datetime(2026, 9, 10, 12, tzinfo=UTC))
    r2 = reg.register_event("US_CPI_20260911", "US_CPI", ["KOSPI200"], ts, "A1_open", exist_ok=True, schedule_status="unconfirmed")
    assert r2["schedule_status"] == "unconfirmed" and r2["frozen"] is True
    # 동결된 행에도 파생 필드 기록 가능
    fl = I.flag_independence([reg.get("US_CPI_20260911") | {"grade": "A"}, reg.get("SEC_PRELIM_20261008")], cal)
    for e in fl:
        reg.set_independence(e["event_id"], e["t0_kr"], e["digest_window_end"], e["independence_flag"], e["overlap_group"],
                             e["contamination_reason"], e["verify_eligible"])
    with pytest.raises(RegistryError):
        reg.set_independence("US_CPI_20260911", date(2026, 9, 14), date(2026, 9, 18), False, None, "BOGUS", False)
    with pytest.raises(RegistryError):
        reg.set_independence("US_CPI_20260911", date(2026, 9, 14), date(2026, 9, 18), False, None, None, False)   # 비독립인데 사유 없음
    reg2 = ConsensusRegistry(p)
    c = reg2.get("US_CPI_20260911")
    assert c["t0_kr"] == date(2026, 9, 14) and c["digest_window_end"] == date(2026, 9, 18)
    assert c["independence_flag"] is True and c["overlap_group"] is None and c["contamination_reason"] is None
    assert c["consensus_value"] == 0.3 and c["frozen"] is True     # 동결값 불변
    s = reg2.get("SEC_PRELIM_20261008")
    assert s["schedule_status"] == "tentative" and s["t0_kr"] == date(2026, 10, 8) and s["verify_eligible"] is False


def test_registry_old_file_without_new_columns_loads(tmp_path):
    """구 스키마 파일(T5-1 이전 컬럼만) 호환: 없으면 None / verify_eligible False."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from mtpro.events import registry as R

    old_cols = [f for f in R.SCHEMA if f.name not in ("schedule_status", *R.INDEPENDENCE_COLUMNS)]
    old_schema = pa.schema(old_cols)
    row = {f.name: None for f in old_cols}
    row.update(event_id="US_CPI_20260911", event_type="US_CPI", asset_scope=["KOSPI200"],
               scheduled_ts_utc=datetime(2026, 9, 11, 12, 30, tzinfo=UTC), t0_mode="A1_open", frozen=False,
               single_fetch=False, manual_override=False)
    p = tmp_path / "old.parquet"
    pq.write_table(pa.Table.from_pylist([row], schema=old_schema), p)
    reg = ConsensusRegistry(p)
    r = reg.get("US_CPI_20260911")
    assert r["schedule_status"] is None and r["t0_kr"] is None and r["independence_flag"] is None and r["overlap_group"] is None
    assert r["verify_eligible"] is False
    reg.save()
    assert set(pq.read_schema(p).names) == set(R.COLUMNS)


def test_scheduler_registration_carries_schedule_status(tmp_path):
    from mtpro.events.calendar import CalendarEvent, EventTypeSpec
    from mtpro.events.scheduler import _ensure_registered

    spec = EventTypeSpec("SEC_PRELIM", "l", "o", "r", "Asia/Seoul", time(8, 0), "A1_open", ("005930",), "kr_earnings", "f", "u")
    ev = CalendarEvent("SEC_PRELIM_20261008", "SEC_PRELIM", date(2026, 10, 8), datetime(2026, 10, 7, 23, tzinfo=UTC), "A1_open",
                       ("005930",), "tentative", "e", spec)
    reg = ConsensusRegistry(tmp_path / "r.parquet")
    row = _ensure_registered(reg, ev)
    assert row["schedule_status"] == "tentative" and reg.get("SEC_PRELIM_20261008")["schedule_status"] == "tentative"
