"""D-3/D-1 수집 스케줄러 (발주자 개정 D3 2026-08-17, 운영 결정 ①⑤·AM-4 2026-08-17).

run_collection(now, calendar, registry, collectors, alert, notify):
  1. 캘린더에서 대상 선별 (select_targets): scheduled_ts_utc 기준 UTC 날짜 차이로
       D-7 단계: status=unconfirmed 이벤트만, days_left ∈ D7_DAYS (기본 7; 캐치업 6) → notify(UNCONFIRMED_SCHEDULE_D7)
                 (운영 결정 ⑤ 재확인 체크. 수집·등록 없음. 정보성 알림이라 loud_failure 아님)
       D-3 단계: days_left ∈ D3_DAYS (기본 3; 놓친 경우 2도 D-3 취급, 값 없을 때만)
       D-1 단계: days_left ∈ D1_DAYS (기본 1; 놓친 경우 0(발표 전)도 D-1 취급)
       이미 동결된 이벤트는 제외. 발표 시각이 지났는데 미동결(미등록 포함)이면 "late" 단계 → 수집 없이 즉시 동결
       (값 없으면 등급C + alert LATE_FREEZE). 사후 컨센서스 입력은 vintage 규칙이 막는다.
  2. 레지스트리에 미등록이면 register (캘린더 값으로).
  3. 수집기 호출 → 성공: upsert_consensus(entered_by="auto:<source>", vintage_ts=fetched_at, single_fetch=...)
                     · 운영 결정 ①: D-1 에서 자동 성공했는데 그 전 자동 성공(D-3)이 없었으면 single_fetch=True
                     · AM-4: 행이 manual_override=True 면 레지스트리가 자동값을 shadow 에 기록만 → status "shadowed"
                → 실패: alert(COLLECT_FAIL) (D-3는 여기까지, 발주자 수동 입력 가능)
  4. D-1 단계는 수집 성공/실패와 무관하게 freeze(now). 값 없으면 grade C → alert(DEGRADE_C).
  5. unconfirmed 일정은 D-3/D-1 에서 alert(UNCONFIRMED_SCHEDULE) 만 남기고 동일하게 처리 (기존 로직 유지).
순수 함수 위주: 수집기·alert·notify·now 모두 주입 가능. 파일 I/O는 registry 객체 안에서만.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from mtpro.alerts import loud_failure, notify as notify_info
from mtpro.events.calendar import Calendar, CalendarEvent
from mtpro.events.collectors import CollectError, Collector, collector_for, default_collectors
from mtpro.events.registry import ConsensusRegistry, FrozenError, RegistryError, VintageError

D7_DAYS: tuple[int, ...] = (7, 6)   # config/mtpro.yaml consensus.unconfirmed_recheck_days_before=7 (+캐치업 6)
D3_DAYS: tuple[int, ...] = (3, 2)
D1_DAYS: tuple[int, ...] = (1, 0)

STAGE_D7 = "D-7"
STAGE_D3 = "D-3"
STAGE_D1 = "D-1"
STAGE_LATE = "late"

UNCONFIRMED_SCHEDULE_D7 = "UNCONFIRMED_SCHEDULE_D7"


@dataclass
class CollectionResult:
    event_id: str
    stage: str  # D-7 | D-3 | D-1 | late
    status: str  # collected | shadowed | frozen | failed | degraded_C | skipped | recheck
    value: float | None = None
    unit: str | None = None
    source: str | None = None
    grade: str | None = None
    detail: str = ""
    alerts: list[dict[str, Any]] = field(default_factory=list)


def _utc(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        raise ValueError("now must be tz-aware")
    return ts.astimezone(timezone.utc)


def days_left(event: CalendarEvent, now: datetime) -> int:
    n = _utc(now)
    return (event.scheduled_ts_utc.date() - n.date()).days


def select_targets(
    events: Iterable[CalendarEvent],
    now: datetime,
    registry: ConsensusRegistry | None = None,
    d3_days: tuple[int, ...] = D3_DAYS,
    d1_days: tuple[int, ...] = D1_DAYS,
    d7_days: tuple[int, ...] = D7_DAYS,
) -> list[tuple[CalendarEvent, str]]:
    """(event, stage) 목록. 동결된 이벤트 제외. 순수 함수(registry는 읽기만).
    D-7 단계는 unconfirmed 이벤트에만 붙는다(운영 결정 ⑤ 재확인 체크; 상태 없는 순수 선별이라 D-7·D-6 실행마다 알림)."""
    n = _utc(now)
    out: list[tuple[CalendarEvent, str]] = []
    for ev in events:
        row = registry.get(ev.event_id) if registry is not None else None
        if row is not None and row["frozen"]:
            continue
        dl = days_left(ev, n)
        if n >= ev.scheduled_ts_utc:
            # 발표 시각 경과, 미동결 (미등록 포함) → late: 수집 없이 즉시 동결 → 값 없으면 등급C 기록 (사후 등록 금지의 실체)
            out.append((ev, STAGE_LATE))
            continue
        if dl in d1_days:
            out.append((ev, STAGE_D1))
        elif dl in d3_days:
            has_value = row is not None and row["consensus_value"] is not None
            if dl == max(d3_days) or not has_value:
                out.append((ev, STAGE_D3))
        elif dl in d7_days and not ev.confirmed:
            out.append((ev, STAGE_D7))
    return out


def _had_auto_value(row: dict[str, Any]) -> bool:
    """이전 자동 수집 성공 여부 (동결 대상 필드가 auto:* 이거나 shadow 에 자동값이 있으면 True)."""
    if row.get("auto_shadow_value") is not None:
        return True
    return row.get("consensus_value") is not None and str(row.get("entered_by") or "").startswith("auto:")


def _ensure_registered(registry: ConsensusRegistry, ev: CalendarEvent) -> dict[str, Any]:
    row = registry.get(ev.event_id)
    if row is None:
        row = registry.register_event(
            ev.event_id, ev.event_type, ev.asset_scope, ev.scheduled_ts_utc, ev.t0_mode,
            note=f"calendar:{ev.status}", exist_ok=True,
        )
    return row


def process_event(
    ev: CalendarEvent,
    stage: str,
    now: datetime,
    registry: ConsensusRegistry,
    collectors: dict[str, Collector] | None,
    alert: Callable[..., dict[str, Any]],
    notify: Callable[..., dict[str, Any]] = notify_info,
) -> CollectionResult:
    n = _utc(now)
    res = CollectionResult(event_id=ev.event_id, stage=stage, status="skipped")
    if stage == STAGE_D7:
        # 운영 결정 ⑤: 미확인 일정 D-7 재확인 체크 — 정보성 알림만 (등록·수집·동결 없음; 날짜가 바뀌면 event_id 도 바뀐다)
        res.status = "recheck"
        res.detail = f"{stage} unconfirmed schedule — 공식 소스에서 날짜 확인 후 캘린더 갱신 필요"
        res.alerts.append(notify(UNCONFIRMED_SCHEDULE_D7, {
            "event_id": ev.event_id, "stage": stage, "days_left": days_left(ev, n),
            "scheduled_ts_utc": ev.scheduled_ts_utc.isoformat(), "status": ev.status, "evidence": ev.evidence,
            "action": "공식 소스에서 날짜 확인 → config/event_calendar.yaml status/local_date 갱신"}, ts=n))
        return res
    row = _ensure_registered(registry, ev)
    if not ev.confirmed:
        res.alerts.append(alert("UNCONFIRMED_SCHEDULE", {"event_id": ev.event_id, "stage": stage,
                                                          "scheduled_ts_utc": ev.scheduled_ts_utc.isoformat(),
                                                          "evidence": ev.evidence}, ts=n))
    # ---- 수집 (late 단계는 수집하지 않음: vintage 규칙상 사후 값 입력 불가) ----
    if stage in (STAGE_D3, STAGE_D1):
        try:
            fn = collector_for(ev, collectors)
            got = fn(ev, now=n)
            value, unit, source = got["value"], got["unit"], got["source"]
            fetched_at = got.get("fetched_at") or n
            # 운영 결정 ①: D-1 자동 성공인데 이전 자동 성공(D-3)이 없으면 D-1 단독 수집 → single_fetch=True
            single_fetch = (stage == STAGE_D1) and not _had_auto_value(row)
            updated = registry.upsert_consensus(
                ev.event_id, value, unit, source=f"{source} {got.get('source_url', '')}".strip(),
                entered_by=f"auto:{source}", vintage_ts=fetched_at, single_fetch=single_fetch,
            )
            if updated["manual_override"]:
                # AM-4: 수동 우선 — 자동값은 shadow 기록만
                res.status, res.value, res.unit, res.source = "shadowed", float(value), unit, source
                res.detail = (f"{stage} collected {value} {unit} from {source} → shadow only "
                              f"(manual_override, frozen fields keep {updated['entered_by']} {updated['consensus_value']})")
            else:
                res.status, res.value, res.unit, res.source = "collected", float(value), unit, source
                res.detail = f"{stage} collected {value} {unit} from {source}" + (" (single_fetch)" if single_fetch else "")
        except (CollectError, VintageError, RegistryError, KeyError, TypeError, ValueError) as exc:
            res.status = "failed"
            res.detail = f"{stage} collect failed: {type(exc).__name__}: {exc}"
            res.alerts.append(alert("COLLECT_FAIL", {"event_id": ev.event_id, "stage": stage,
                                                     "error": f"{type(exc).__name__}: {exc}"}, ts=n))
    # ---- D-1 / late 동결 ----
    if stage in (STAGE_D1, STAGE_LATE):
        if stage == STAGE_LATE:
            res.alerts.append(alert("LATE_FREEZE", {"event_id": ev.event_id,
                                                    "scheduled_ts_utc": ev.scheduled_ts_utc.isoformat(),
                                                    "reason": "scheduled time passed without D-1 freeze"}, ts=n))
        try:
            frozen = registry.freeze(ev.event_id, n)
        except FrozenError as exc:  # 동시 실행 등 — 이미 동결
            res.status, res.detail = "skipped", f"already frozen: {exc}"
            return res
        res.grade = frozen["grade"]
        if frozen["grade"] == "C":
            res.status = "degraded_C"
            res.detail = (res.detail + "; " if res.detail else "") + f"frozen without consensus at {stage} → grade C"
            res.alerts.append(alert("DEGRADE_C", {"event_id": ev.event_id, "stage": stage,
                                                  "frozen_ts": n.isoformat(),
                                                  "reason": "no consensus value at freeze"}, ts=n))
        else:
            res.status = "frozen"
            res.value = frozen["consensus_value"]
            res.unit = frozen["consensus_unit"]
            # 동결값의 출처: 수동 우선(AM-4)이면 자동 수집 출처가 아니라 수동 entered_by
            res.source = frozen["entered_by"] if frozen["manual_override"] else (res.source or frozen["entered_by"])
            res.detail = (res.detail + "; " if res.detail else "") + f"frozen grade A ({frozen['entered_by']})" + (
                " manual_override" if frozen["manual_override"] else "") + (
                " single_fetch" if frozen["single_fetch"] else "")
    return res


def run_collection(
    now: datetime,
    calendar: Calendar,
    registry: ConsensusRegistry,
    collectors: dict[str, Collector] | None = None,
    alert: Callable[..., dict[str, Any]] = loud_failure,
    d3_days: tuple[int, ...] = D3_DAYS,
    d1_days: tuple[int, ...] = D1_DAYS,
    notify: Callable[..., dict[str, Any]] = notify_info,
    d7_days: tuple[int, ...] = D7_DAYS,
) -> list[CollectionResult]:
    """한 번의 크론 실행. collectors=None 이면 실제 수집기(default_collectors).
    alert=실패 알림(loud_failure), notify=정보성 알림(UNCONFIRMED_SCHEDULE_D7)."""
    cols = collectors if collectors is not None else default_collectors()
    targets = select_targets(calendar.events, now, registry, d3_days, d1_days, d7_days)
    return [process_event(ev, stage, now, registry, cols, alert, notify) for ev, stage in targets]
