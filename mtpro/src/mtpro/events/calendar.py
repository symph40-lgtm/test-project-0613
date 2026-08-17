"""이벤트 캘린더 — config/event_calendar.yaml 적재·검증·UTC 변환.

- 자동 크롤 없음(T1-3 결정). yaml이 공식 일정 등록부.
- CalendarEvent.scheduled_ts_utc 는 (local_date + event_type.local_time, tz) → UTC (zoneinfo, DST 자동).
- schedule_status=unconfirmed 이벤트는 그대로 노출하되 스케줄러가 alert 를 남긴다.
- schedule_status=tentative (T5-1, 계획서 §12.5): 공식 일정 미게시·예시 날짜(삼전 잠정 10/8, 하닉·NVDA 11월). unconfirmed(과거 패턴
  추정)와 구분한다. 스케줄러는 unconfirmed 와 동일하게 D-7 재확인·alert 처리, 독립성 모듈은 verify_eligible=False 로 강제.
  필드명은 발주자 확정(2026-08-17) `schedule_status` — yaml 키·CalendarEvent.schedule_status·레지스트리 schedule_status 컬럼 동일.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from mtpro import settings
from mtpro.events.registry import EVENT_TYPES, SCHEDULE_STATUSES, T0_MODES

DEFAULT_CALENDAR = settings.CONFIG_DIR / "event_calendar.yaml"
STATUSES = SCHEDULE_STATUSES   # ("confirmed", "unconfirmed", "tentative") — schedule_status 허용값


class CalendarError(RuntimeError):
    """캘린더 파일 결함 (loud-failure)."""


@dataclass(frozen=True)
class EventTypeSpec:
    event_type: str
    label: str
    official_source: str
    release_rule: str
    tz: str
    local_time: time
    t0_mode: str
    asset_scope: tuple[str, ...]
    consensus_source: str
    consensus_field: str
    consensus_unit: str
    ticker: str | None = None


@dataclass(frozen=True)
class CalendarEvent:
    event_id: str
    event_type: str
    local_date: date
    scheduled_ts_utc: datetime
    t0_mode: str
    asset_scope: tuple[str, ...]
    schedule_status: str
    evidence: str = ""
    spec: EventTypeSpec | None = field(default=None, compare=False, repr=False)

    @property
    def confirmed(self) -> bool:
        return self.schedule_status == "confirmed"

    @property
    def tentative(self) -> bool:
        return self.schedule_status == "tentative"

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id, "event_type": self.event_type, "local_date": self.local_date.isoformat(),
            "scheduled_ts_utc": self.scheduled_ts_utc.isoformat(), "t0_mode": self.t0_mode,
            "asset_scope": list(self.asset_scope), "schedule_status": self.schedule_status, "evidence": self.evidence,
        }


@dataclass
class Calendar:
    version: str
    types: dict[str, EventTypeSpec]
    events: list[CalendarEvent]

    def get(self, event_id: str) -> CalendarEvent | None:
        return next((e for e in self.events if e.event_id == event_id), None)

    def between(self, start: datetime, end: datetime) -> list[CalendarEvent]:
        s, e = _utc(start), _utc(end)
        return [ev for ev in self.events if s <= ev.scheduled_ts_utc <= e]

    def upcoming(self, now: datetime, horizon_days: int = 14) -> list[CalendarEvent]:
        n = _utc(now)
        return self.between(n, n + timedelta(days=horizon_days))


def _utc(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        raise CalendarError("timestamps must be tz-aware")
    return ts.astimezone(timezone.utc)


def _parse_time(s: str) -> time:
    hh, mm = s.split(":")
    return time(int(hh), int(mm))


def _spec(name: str, raw: dict[str, Any]) -> EventTypeSpec:
    if name not in EVENT_TYPES:
        raise CalendarError(f"event_types.{name}: not in EVENT_TYPES {EVENT_TYPES}")
    req = ("label", "official_source", "release_rule", "tz", "local_time", "t0_mode", "asset_scope",
           "consensus_source", "consensus_field", "consensus_unit")
    missing = [k for k in req if k not in raw]
    if missing:
        raise CalendarError(f"event_types.{name}: missing {missing}")
    if raw["t0_mode"] not in T0_MODES:
        raise CalendarError(f"event_types.{name}: t0_mode {raw['t0_mode']!r} not in {T0_MODES}")
    try:
        ZoneInfo(raw["tz"])
    except Exception as exc:  # noqa: BLE001
        raise CalendarError(f"event_types.{name}: bad tz {raw['tz']!r}: {exc}") from exc
    return EventTypeSpec(
        event_type=name, label=raw["label"], official_source=raw["official_source"],
        release_rule=raw["release_rule"], tz=raw["tz"], local_time=_parse_time(str(raw["local_time"])),
        t0_mode=raw["t0_mode"], asset_scope=tuple(str(s) for s in raw["asset_scope"]),
        consensus_source=raw["consensus_source"], consensus_field=raw["consensus_field"],
        consensus_unit=str(raw["consensus_unit"]), ticker=(str(raw["ticker"]) if raw.get("ticker") else None),
    )


def scheduled_utc(local_date: date, spec: EventTypeSpec, local_time: time | None = None, tz: str | None = None) -> datetime:
    lt = local_time or spec.local_time
    z = ZoneInfo(tz or spec.tz)
    return datetime.combine(local_date, lt, tzinfo=z).astimezone(timezone.utc)


def load_calendar(path: Path | None = None) -> Calendar:
    p = Path(path) if path is not None else DEFAULT_CALENDAR
    if not p.exists():
        raise CalendarError(f"calendar file missing: {p}")
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    types = {name: _spec(name, r or {}) for name, r in (raw.get("event_types") or {}).items()}
    events: list[CalendarEvent] = []
    seen: set[str] = set()
    for i, r in enumerate(raw.get("events") or []):
        for k in ("event_id", "event_type", "local_date", "schedule_status"):
            if k not in r:
                hint = " (구 키 'status' 는 schedule_status 로 개명 — 발주자 확정 2026-08-17)" if k == "schedule_status" and "status" in r else ""
                raise CalendarError(f"events[{i}]: missing {k}{hint}")
        et = r["event_type"]
        if et not in types:
            raise CalendarError(f"events[{i}] {r['event_id']}: event_type {et!r} has no event_types spec")
        spec = types[et]
        if r["schedule_status"] not in STATUSES:
            raise CalendarError(f"{r['event_id']}: schedule_status {r['schedule_status']!r} not in {STATUSES}")
        if r["event_id"] in seen:
            raise CalendarError(f"duplicate event_id {r['event_id']}")
        seen.add(r["event_id"])
        ld = r["local_date"] if isinstance(r["local_date"], date) else date.fromisoformat(str(r["local_date"]))
        expected_id = f"{et}_{ld.strftime('%Y%m%d')}"
        if r["event_id"] != expected_id:
            raise CalendarError(f"{r['event_id']}: event_id must be {expected_id} ({{type}}_{{YYYYMMDD}} 규칙)")
        lt = _parse_time(str(r["local_time"])) if r.get("local_time") else None
        t0_mode = r.get("t0_mode", spec.t0_mode)
        if t0_mode not in T0_MODES:
            raise CalendarError(f"{r['event_id']}: t0_mode {t0_mode!r}")
        scope = tuple(str(s) for s in r.get("asset_scope", spec.asset_scope))
        events.append(CalendarEvent(
            event_id=r["event_id"], event_type=et, local_date=ld,
            scheduled_ts_utc=scheduled_utc(ld, spec, lt, r.get("tz")), t0_mode=t0_mode, asset_scope=scope,
            schedule_status=r["schedule_status"], evidence=str(r.get("evidence", "")), spec=spec,
        ))
    events.sort(key=lambda e: (e.scheduled_ts_utc, e.event_id))
    return Calendar(version=str(raw.get("version", "")), types=types, events=events)
