"""이벤트 독립성·purge (AM-9; 계획서 §2.1~§2.3·§12.5 — 승인된 사전 등록. 상수는 config/mtpro.yaml events.independence 와 일치 테스트).

순수 함수 위주 — 입력은 이벤트 dict 목록(레지스트리 행 또는 캘린더 이벤트 as_dict), 출력은 새 dict 목록(입력 불변).

규칙 (§2.2 그대로):
- t0_kr = scheduled_ts_utc → 그 시각 이후 최초 XKRX 세션 개장(09:00 KST) — kr_calendar.next_open_after (경계 "release < 09:00 KST → 당일").
- digest_window_end = t0_kr + (W_DIGEST − 1) 세션, W_DIGEST = 5.
- (a) 같은 t0_kr → 전부 비독립 SAME_DAY_MULTI, overlap_group = 그 t0 의 이벤트 id 정렬 '+' 결합.
- (b) t0_kr 가 **앞선 어떤 이벤트**(독립 여부 무관)의 [t0_kr, digest_window_end] 안 → 비독립 OVERLAP_DIGEST_WINDOW,
      overlap_group = 가장 이른 원인 이벤트의 group(체인 상속; 없으면 그 id). e1(먼저 온 정보)은 독립 유지.
- (c) 실적 3종(SEC_PRELIM·HYNIX_EARN·NVDA_EARN) 서로 [t0_kr ± 3 세션] → 양쪽 EARNINGS_CLUSTER (이미 비독립이면 사유 추가).
- contamination_reason = 사유 ';' 결합 문자열(순서: SAME_DAY_MULTI;OVERLAP_DIGEST_WINDOW;EARNINGS_CLUSTER), 독립이면 None.
- (d) verify_eligible = independence_flag ∧ grade=="A" ∧ 필수값(consensus_value·actual_value) 결측 없음 ∧ schedule_status != tentative.
- PSA_PENDING_SHOCK(T5-3)·DATA_GAP(T5-6) 은 enum 만 (schema.CONTAMINATION_REASONS) — 여기서 적용하지 않는다.
- 검증 쌍: 상태일 t 마다 e* = t 이후 최초 verify_eligible 이벤트(t0_kr > t). 추론 표본은 e* 당 1쌍(t = e*.t0_kr 직전 세션)
  role="inference", 나머지 매칭 role="descriptive". 방향 = surprise_z (> +0.3 good / < −0.3 bad / 그 외 neutral=라벨 불가 / None).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Iterable, Sequence

from mtpro.events import kr_calendar as KC
from mtpro.schema import CONTAMINATION_REASONS, SCHEDULE_STATUSES

ENGINE_VER = "independence-0.1"

# ---- 사전 등록 상수 (config/mtpro.yaml events.independence 와 tests/test_independence.py 로 일치 고정) ----
W_DIGEST = 5                                    # 소화 창 (t0_kr 포함 KR 거래일)
EARNINGS_CLUSTER_SESSIONS = 3                   # 실적 클러스터 [t0_kr ± 3 세션]
EARNINGS_TYPES: tuple[str, ...] = ("SEC_PRELIM", "HYNIX_EARN", "NVDA_EARN")
CALENDAR = KC.CALENDAR_NAME                     # "XKRX"
BOUNDARY = KC.BOUNDARY_RULE                     # "release < 09:00 KST → same session"
SURPRISE_Z_GOOD = 0.3
SURPRISE_Z_BAD = -0.3
CHALLENGERS: tuple[str, ...] = ("IND-C1", "IND-C2")   # 등록만 (shadow, T5-1 미구현)

# enum (schema.CONTAMINATION_REASONS 와 동일 — 여기선 이름 상수)
OVERLAP_DIGEST_WINDOW = "OVERLAP_DIGEST_WINDOW"
SAME_DAY_MULTI = "SAME_DAY_MULTI"
EARNINGS_CLUSTER = "EARNINGS_CLUSTER"
PSA_PENDING_SHOCK = "PSA_PENDING_SHOCK"         # T5-3 적용
DATA_GAP = "DATA_GAP"                           # T5-6 적용
REASONS: tuple[str, ...] = CONTAMINATION_REASONS
_REASON_ORDER = {SAME_DAY_MULTI: 0, OVERLAP_DIGEST_WINDOW: 1, EARNINGS_CLUSTER: 2, PSA_PENDING_SHOCK: 3, DATA_GAP: 4}

REQUIRED_FIELDS: tuple[str, ...] = ("consensus_value", "actual_value")   # verify_eligible 의 "필수값 결측 없음"
GROUP_SEP = "+"
REASON_SEP = ";"

ROLE_INFERENCE = "inference"
ROLE_DESCRIPTIVE = "descriptive"


class IndependenceError(RuntimeError):
    """입력 결함 (loud-failure)."""


# ---------------------------------------------------------------------------
# 유틸
# ---------------------------------------------------------------------------
def _ts(v: Any, eid: str) -> datetime:
    if isinstance(v, str):
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if not isinstance(v, datetime):
        raise IndependenceError(f"{eid}: scheduled_ts_utc must be datetime/ISO, got {type(v).__name__}")
    if v.tzinfo is None:
        raise IndependenceError(f"{eid}: scheduled_ts_utc must be tz-aware")
    return v.astimezone(timezone.utc)


def _missing(v: Any) -> bool:
    if v is None:
        return True
    try:
        return v != v  # NaN
    except Exception:  # noqa: BLE001
        return False


def _sort_key(e: dict[str, Any]) -> tuple:
    return (e["t0_kr"], e["scheduled_ts_utc"], e["event_id"])


# ---------------------------------------------------------------------------
# 1) t0_kr · digest_window_end
# ---------------------------------------------------------------------------
def assign_t0(events: Iterable[dict[str, Any]], cal: KC.KrCalendar | None = None,
              w_digest: int = W_DIGEST) -> list[dict[str, Any]]:
    """각 이벤트에 t0_kr(date)·digest_window_end(date)·calendar_source 를 붙인 새 dict 목록 (t0_kr 순 정렬)."""
    c = cal or KC.default_calendar()
    if w_digest < 1:
        raise IndependenceError(f"w_digest must be >= 1, got {w_digest}")
    out: list[dict[str, Any]] = []
    for e in events:
        eid = str(e.get("event_id"))
        ts = _ts(e.get("scheduled_ts_utc"), eid)
        t0 = c.next_open_after(ts)
        row = dict(e)
        row.update(event_id=eid, scheduled_ts_utc=ts, t0_kr=t0,
                   digest_window_end=c.add_sessions(t0, w_digest - 1), calendar_source=c.source)
        out.append(row)
    out.sort(key=_sort_key)
    return out


# ---------------------------------------------------------------------------
# 2) 독립성 판정
# ---------------------------------------------------------------------------
def flag_independence(
    events: Iterable[dict[str, Any]],
    cal: KC.KrCalendar | None = None,
    w_digest: int = W_DIGEST,
    cluster_sessions: int = EARNINGS_CLUSTER_SESSIONS,
    earnings_types: Sequence[str] = EARNINGS_TYPES,
) -> list[dict[str, Any]]:
    """t0 가 없으면 assign_t0 를 먼저 적용. 반환: independence_flag·overlap_group·contamination_reason·verify_eligible 이 붙은
    새 dict 목록 (t0_kr, scheduled_ts_utc, event_id 순)."""
    c = cal or KC.default_calendar()
    evs = list(events)
    if any(e.get("t0_kr") is None or e.get("digest_window_end") is None for e in evs):
        evs = assign_t0(evs, c, w_digest)
    else:
        evs = sorted((dict(e) for e in evs), key=_sort_key)
    ids = [e["event_id"] for e in evs]
    if len(ids) != len(set(ids)):
        dup = sorted({i for i in ids if ids.count(i) > 1})
        raise IndependenceError(f"duplicate event_id in input: {dup}")

    reasons: dict[str, list[str]] = {e["event_id"]: [] for e in evs}
    group: dict[str, str | None] = {e["event_id"]: None for e in evs}

    # (a) 같은 t0_kr 집합
    by_t0: dict[date, list[str]] = {}
    for e in evs:
        by_t0.setdefault(e["t0_kr"], []).append(e["event_id"])

    # (a)+(b) 를 t0 순 단일 패스로: 원인(앞선 이벤트)의 group 은 처리 시점에 이미 확정 → 체인 상속이 일관된다.
    for i, e in enumerate(evs):
        eid = e["event_id"]
        members = by_t0[e["t0_kr"]]
        if len(members) > 1:
            reasons[eid].append(SAME_DAY_MULTI)
        cause = None
        for p in evs[:i]:
            if p["t0_kr"] < e["t0_kr"] <= p["digest_window_end"]:
                cause = p                       # evs 는 t0 순 → 처음 만나는 p 가 가장 이른 원인
                break
        if cause is not None:
            reasons[eid].append(OVERLAP_DIGEST_WINDOW)
            group[eid] = group[cause["event_id"]] or cause["event_id"]     # 체인이면 원인의 group 상속
        elif len(members) > 1:
            group[eid] = GROUP_SEP.join(sorted(members))                   # 같은 날 id 정렬 결합

    # (c) 실적 클러스터 (서로 [t0_kr ± cluster_sessions] 세션)
    earn = [e for e in evs if e.get("event_type") in set(earnings_types)]
    for i, a in enumerate(earn):
        for b in earn[i + 1:]:
            if a["t0_kr"] == b["t0_kr"]:
                dist = 0
            else:
                dist = abs(c.session_distance(a["t0_kr"], b["t0_kr"]))
            if dist <= cluster_sessions:
                pair = GROUP_SEP.join(sorted((a["event_id"], b["event_id"])))
                for eid in (a["event_id"], b["event_id"]):
                    if EARNINGS_CLUSTER not in reasons[eid]:
                        reasons[eid].append(EARNINGS_CLUSTER)
                    if group[eid] is None:
                        group[eid] = pair

    out: list[dict[str, Any]] = []
    for e in evs:
        eid = e["event_id"]
        rs = sorted(set(reasons[eid]), key=_REASON_ORDER.__getitem__)
        flag = not rs
        row = dict(e)
        row.update(
            independence_flag=flag,
            overlap_group=group[eid],
            contamination_reason=(REASON_SEP.join(rs) if rs else None),
        )
        row["verify_eligible"] = verify_eligible(row)
        out.append(row)
    return out


def verify_eligible(e: dict[str, Any], required: Sequence[str] = REQUIRED_FIELDS) -> bool:
    """(d) independence_flag ∧ grade=="A" ∧ 필수값 결측 없음 ∧ schedule_status != tentative."""
    st = e.get("schedule_status")
    if st is not None and st not in SCHEDULE_STATUSES:
        raise IndependenceError(f"{e.get('event_id')}: schedule_status {st!r} not in {SCHEDULE_STATUSES}")
    return bool(
        e.get("independence_flag") is True
        and e.get("grade") == "A"
        and not any(_missing(e.get(k)) for k in required)
        and st != "tentative"
    )


# ---------------------------------------------------------------------------
# 3) 검증 쌍
# ---------------------------------------------------------------------------
def direction_of(surprise_z: Any, good: float = SURPRISE_Z_GOOD, bad: float = SURPRISE_Z_BAD) -> str | None:
    """surprise_z 부호 → good / bad / neutral(라벨 불가) / None(결측)."""
    if _missing(surprise_z):
        return None
    z = float(surprise_z)
    if z > good:
        return "good"
    if z < bad:
        return "bad"
    return "neutral"


def verification_pairs(
    mt_dates: Iterable[date],
    events: Iterable[dict[str, Any]],
    cal: KC.KrCalendar | None = None,
) -> list[dict[str, Any]]:
    """상태일 t 마다 e* = t 이후 최초 verify_eligible 이벤트(t0_kr > t). e* 없는 t 는 쌍 없음.
    role: t == e*.t0_kr 직전 세션이면 "inference"(e* 당 정확히 1쌍), 아니면 "descriptive".
    direction/label_ok: surprise_z 로 good/bad(라벨 가능) · neutral/None(라벨 불가). events 는 flag_independence 출력."""
    c = cal or KC.default_calendar()
    elig = sorted((e for e in events if e.get("verify_eligible") is True), key=_sort_key)
    for e in elig:
        if e.get("t0_kr") is None:
            raise IndependenceError(f"{e['event_id']}: verify_eligible without t0_kr")
    prev_of = {e["event_id"]: c.add_sessions(e["t0_kr"], -1) for e in elig}
    out: list[dict[str, Any]] = []
    for t in sorted({KC._as_date(d) for d in mt_dates}):
        star = next((e for e in elig if e["t0_kr"] > t), None)
        if star is None:
            continue
        d = direction_of(star.get("surprise_z"))
        out.append({
            "mt_date": t, "event_id": star["event_id"], "event_type": star.get("event_type"),
            "t0_kr": star["t0_kr"], "sessions_ahead": c.session_distance(t, star["t0_kr"]) if c.is_session(t) else None,
            "role": ROLE_INFERENCE if t == prev_of[star["event_id"]] else ROLE_DESCRIPTIVE,
            "surprise_z": star.get("surprise_z"), "direction": d, "label_ok": d in ("good", "bad"),
        })
    return out


# ---------------------------------------------------------------------------
# 요약
# ---------------------------------------------------------------------------
def summarize(flagged: Sequence[dict[str, Any]], pairs: Sequence[dict[str, Any]] | None = None) -> dict[str, Any]:
    n = len(flagged)
    reasons: dict[str, int] = {}
    for e in flagged:
        for r in (e.get("contamination_reason") or "").split(REASON_SEP):
            if r:
                reasons[r] = reasons.get(r, 0) + 1
    s: dict[str, Any] = {
        "engine_ver": ENGINE_VER, "n_events": n,
        "n_independent": sum(1 for e in flagged if e.get("independence_flag") is True),
        "n_verify_eligible": sum(1 for e in flagged if e.get("verify_eligible") is True),
        "n_tentative": sum(1 for e in flagged if e.get("schedule_status") == "tentative"),
        "reasons": reasons, "w_digest": W_DIGEST, "earnings_cluster_sessions": EARNINGS_CLUSTER_SESSIONS,
        "calendar_source": (flagged[0].get("calendar_source") if flagged else None),
    }
    if pairs is not None:
        s["n_pairs"] = len(pairs)
        s["n_inference"] = sum(1 for p in pairs if p["role"] == ROLE_INFERENCE)
        s["n_descriptive"] = sum(1 for p in pairs if p["role"] == ROLE_DESCRIPTIVE)
        s["n_label_ok"] = sum(1 for p in pairs if p["label_ok"])
    return s


__all__ = [
    "ENGINE_VER", "W_DIGEST", "EARNINGS_CLUSTER_SESSIONS", "EARNINGS_TYPES", "CALENDAR", "BOUNDARY",
    "SURPRISE_Z_GOOD", "SURPRISE_Z_BAD", "CHALLENGERS", "REASONS", "REQUIRED_FIELDS",
    "OVERLAP_DIGEST_WINDOW", "SAME_DAY_MULTI", "EARNINGS_CLUSTER", "PSA_PENDING_SHOCK", "DATA_GAP",
    "ROLE_INFERENCE", "ROLE_DESCRIPTIVE", "IndependenceError",
    "assign_t0", "flag_independence", "verify_eligible", "direction_of", "verification_pairs", "summarize",
]
