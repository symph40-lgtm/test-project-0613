"""컨센서스 레지스트리 — parquet 백엔드 (SILVER/consensus_registry.parquet).

불변 규칙 (WORKORDER v10.1 §5-1·2·4, T1 보고 T1-3 스키마 초안, 발주자 개정 D3 2026-08-17):
- 사전 동결: freeze(event_id, at) 후 컨센서스 필드 UPDATE 시도 → FrozenError (hard assert).
- vintage 기록: upsert 시 vintage_ts 필수. vintage_ts >= scheduled_ts_utc 면 VintageError (사후 입력 금지).
- 정정은 새 행 + supersedes 링크로만 (supersede()). 원 행은 그대로 보존.
- 동결 시점에 값이 없으면 grade="C" (방향만) 로 기록. 값이 있으면 "A".
- actual_value 는 발표 후 입력. available_at >= actual_ts assert. 동결된 행에만 허용(순서 강제).
- AM-4 (역방향, 2026-08-17): 수동 입력이 자동을 이긴다. entered_by="manual:*" upsert → manual_override=True.
  이후 entered_by="auto:*" upsert 는 auto_shadow_* 에 **기록만** 하고 동결 대상 필드(consensus_value 등)는 수동값 유지.
  (수동이 기존 자동값을 덮을 때도 그 자동값은 shadow 로 보존 — 자동값·vintage 는 버리지 않는다.)
- 운영 결정 ① (2026-08-17): D-3 수집 불가(주간 피드 밖·미실행) 후 D-1 에서만 자동 수집된 행은 single_fetch=True.
  자동 수집 이력에 대한 표기이며 스케줄러가 upsert_consensus(single_fetch=...) 로 지정한다. D-3 성공 후 D-1 성공이면 False.

스키마 (한 행 = 한 이벤트 컨센서스 레코드):
  event_id(str, PK) event_type(enum 7종) asset_scope(list[str]) scheduled_ts_utc(ts) t0_mode(enum)
  consensus_value(float|None) consensus_unit(str|None) vintage_ts(ts|None) source(str|None)
  entered_by("auto:<source>"|"manual:<name>"|None) frozen(bool) frozen_ts(ts|None) grade("A"|"C"|None)
  actual_value(float|None) actual_ts(ts|None) available_at(ts|None) supersedes(str|None) note(str|None)
  single_fetch(bool, 기본 False) manual_override(bool, 기본 False)
  auto_shadow_value(float|None) auto_shadow_vintage_ts(ts|None) auto_shadow_source(str|None)
  --- T5-1 (AM-9, 계획서 §2.1) 파생 필드 (동결 대상 아님, set_independence()로만 갱신) ---
  status(confirmed|unconfirmed|tentative|None) t0_kr(date|None) digest_window_end(date|None)
  independence_flag(bool|None: None=미계산) overlap_group(str|None) contamination_reason(str|None)
  verify_eligible(bool, 기본 False)
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq

from mtpro import settings
from mtpro.schema import CONTAMINATION_REASONS

EVENT_TYPES: tuple[str, ...] = (
    "FOMC",  # FOMC 성명 (금리 결정)
    "US_CPI",  # 미 CPI
    "US_NFP",  # 미 고용보고서 (Employment Situation)
    "US_PCE",  # 미 PCE (Personal Income and Outlays)
    "SEC_PRELIM",  # 삼성전자 잠정실적
    "HYNIX_EARN",  # SK하이닉스 실적
    "NVDA_EARN",  # 엔비디아 실적
)
T0_MODES: tuple[str, ...] = ("A1_open", "release_time")
GRADES: tuple[str, ...] = ("A", "C")
EVENT_STATUSES: tuple[str, ...] = ("confirmed", "unconfirmed", "tentative")   # T5-1 (= schema.EVENT_STATUSES)

INDEPENDENCE_COLUMNS: tuple[str, ...] = (                                # T5-1 파생 필드 (set_independence)
    "t0_kr", "digest_window_end", "independence_flag", "overlap_group", "contamination_reason", "verify_eligible",
)
COLUMNS: tuple[str, ...] = (
    "event_id", "event_type", "asset_scope", "scheduled_ts_utc", "t0_mode",
    "consensus_value", "consensus_unit", "vintage_ts", "source", "entered_by",
    "frozen", "frozen_ts", "grade", "actual_value", "actual_ts", "available_at",
    "supersedes", "note",
    "single_fetch", "manual_override",                                   # 운영 결정 ① / AM-4
    "auto_shadow_value", "auto_shadow_vintage_ts", "auto_shadow_source",  # AM-4: 자동값 기록 보존
    "status",                                                            # T5-1: 캘린더 status 전달
    *INDEPENDENCE_COLUMNS,                                               # T5-1: t0·독립성 파생 (구 파일 부재 → None/False)
)
BOOL_COLUMNS: tuple[str, ...] = ("frozen", "single_fetch", "manual_override", "verify_eligible")
# independence_flag 는 BOOL_COLUMNS 에 넣지 않는다: None = "미계산" 을 False("비독립") 로 바꾸지 않기 위함 (verify_eligible 은
# 보수적 기본 False 가 안전하므로 bool 강제).

_TS = pa.timestamp("us", tz="UTC")
SCHEMA = pa.schema([
    ("event_id", pa.string()),
    ("event_type", pa.string()),
    ("asset_scope", pa.list_(pa.string())),
    ("scheduled_ts_utc", _TS),
    ("t0_mode", pa.string()),
    ("consensus_value", pa.float64()),
    ("consensus_unit", pa.string()),
    ("vintage_ts", _TS),
    ("source", pa.string()),
    ("entered_by", pa.string()),
    ("frozen", pa.bool_()),
    ("frozen_ts", _TS),
    ("grade", pa.string()),
    ("actual_value", pa.float64()),
    ("actual_ts", _TS),
    ("available_at", _TS),
    ("supersedes", pa.string()),
    ("note", pa.string()),
    ("single_fetch", pa.bool_()),
    ("manual_override", pa.bool_()),
    ("auto_shadow_value", pa.float64()),
    ("auto_shadow_vintage_ts", _TS),
    ("auto_shadow_source", pa.string()),
    ("status", pa.string()),                       # T5-1
    ("t0_kr", pa.date32()),
    ("digest_window_end", pa.date32()),
    ("independence_flag", pa.bool_()),
    ("overlap_group", pa.string()),
    ("contamination_reason", pa.string()),
    ("verify_eligible", pa.bool_()),
])

DEFAULT_PATH = settings.SILVER / "consensus_registry.parquet"

_ENTERED_BY_RE = re.compile(r"^(auto|manual):[^\s]+$")


class RegistryError(RuntimeError):
    """레지스트리 규칙 위반 (loud-failure)."""


class FrozenError(RegistryError):
    """동결된 행 수정 시도."""


class VintageError(RegistryError):
    """vintage_ts >= scheduled_ts_utc (사후 입력) 또는 vintage 누락."""


class UnknownEventError(RegistryError):
    """미등록 event_id."""


def _utc(ts: datetime | None, name: str) -> datetime | None:
    if ts is None:
        return None
    if not isinstance(ts, datetime):
        raise RegistryError(f"{name} must be datetime, got {type(ts).__name__}")
    if ts.tzinfo is None:
        raise RegistryError(f"{name} must be tz-aware (UTC)")
    return ts.astimezone(timezone.utc)


def _clean(v: Any) -> Any:
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


class ConsensusRegistry:
    """parquet 파일 하나를 통째로 읽고/쓰는 단순 레지스트리 (건수 ≈ 수십/년)."""

    def __init__(self, path: Path | None = None, autosave: bool = True):
        self.path = Path(path) if path is not None else DEFAULT_PATH
        self.autosave = autosave
        self._rows: dict[str, dict[str, Any]] = {}
        self._load()

    # ---------- 저장/적재 ----------
    def _load(self) -> None:
        if self.path.exists():
            table = pq.read_table(self.path)
            for rec in table.to_pylist():
                rec = {k: _clean(rec.get(k)) for k in COLUMNS}
                for b in BOOL_COLUMNS:  # 구 스키마 파일(컬럼 부재) 호환: None → False
                    rec[b] = bool(rec[b]) if rec[b] is not None else False
                self._rows[rec["event_id"]] = rec

    def save(self) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rows = [{k: r.get(k) for k in COLUMNS} for r in self._rows.values()]
        table = pa.Table.from_pylist(rows, schema=SCHEMA)
        tmp = self.path.with_suffix(".parquet.tmp")
        pq.write_table(table, tmp)
        tmp.replace(self.path)
        return self.path

    def _commit(self) -> None:
        if self.autosave:
            self.save()

    # ---------- 조회 ----------
    def get(self, event_id: str) -> dict[str, Any] | None:
        r = self._rows.get(event_id)
        return dict(r) if r is not None else None

    def _require(self, event_id: str) -> dict[str, Any]:
        r = self._rows.get(event_id)
        if r is None:
            raise UnknownEventError(f"unknown event_id {event_id!r}")
        return r

    def list(
        self,
        event_type: str | None = None,
        frozen: bool | None = None,
        grade: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[dict[str, Any]]:
        out = []
        for r in self._rows.values():
            if event_type is not None and r["event_type"] != event_type:
                continue
            if frozen is not None and bool(r["frozen"]) != frozen:
                continue
            if grade is not None and r["grade"] != grade:
                continue
            if since is not None and r["scheduled_ts_utc"] < _utc(since, "since"):
                continue
            if until is not None and r["scheduled_ts_utc"] > _utc(until, "until"):
                continue
            out.append(dict(r))
        out.sort(key=lambda r: (r["scheduled_ts_utc"], r["event_id"]))
        return out

    def effective(self, event_id: str) -> dict[str, Any]:
        """supersedes 체인의 최신 행 (정정이 있으면 정정본)."""
        cur = self._require(event_id)
        seen = {event_id}
        while True:
            nxt = next((r for r in self._rows.values() if r.get("supersedes") == cur["event_id"]), None)
            if nxt is None or nxt["event_id"] in seen:
                return dict(cur)
            seen.add(nxt["event_id"])
            cur = nxt

    def __len__(self) -> int:
        return len(self._rows)

    def __contains__(self, event_id: str) -> bool:
        return event_id in self._rows

    # ---------- 등록 ----------
    def register_event(
        self,
        event_id: str,
        event_type: str,
        asset_scope: Iterable[str],
        scheduled_ts_utc: datetime,
        t0_mode: str,
        note: str | None = None,
        supersedes: str | None = None,
        exist_ok: bool = False,
        status: str | None = None,
    ) -> dict[str, Any]:
        if event_type not in EVENT_TYPES:
            raise RegistryError(f"event_type {event_type!r} not in {EVENT_TYPES}")
        if t0_mode not in T0_MODES:
            raise RegistryError(f"t0_mode {t0_mode!r} not in {T0_MODES}")
        if status is not None and status not in EVENT_STATUSES:
            raise RegistryError(f"status {status!r} not in {EVENT_STATUSES}")
        scope = [str(s) for s in asset_scope]
        if not scope:
            raise RegistryError("asset_scope must be non-empty")
        sched = _utc(scheduled_ts_utc, "scheduled_ts_utc")
        if event_id in self._rows:
            cur = self._rows[event_id]
            same = (
                cur["event_type"] == event_type
                and list(cur["asset_scope"]) == scope
                and cur["scheduled_ts_utc"] == sched
                and cur["t0_mode"] == t0_mode
            )
            if exist_ok and same:
                if status is not None and cur.get("status") != status:
                    cur["status"] = status          # 캘린더 status 갱신(unconfirmed → confirmed 등)은 동결 대상 아님
                    self._commit()
                return dict(cur)
            raise RegistryError(
                f"event_id {event_id!r} already registered"
                + ("" if same else " with different fields (register a new id / supersede)")
            )
        if supersedes is not None and supersedes not in self._rows:
            raise UnknownEventError(f"supersedes target {supersedes!r} unknown")
        row = {k: None for k in COLUMNS}
        row.update(
            event_id=event_id, event_type=event_type, asset_scope=scope, scheduled_ts_utc=sched,
            t0_mode=t0_mode, frozen=False, supersedes=supersedes, note=note,
            single_fetch=False, manual_override=False, status=status, verify_eligible=False,
        )
        self._rows[event_id] = row
        self._commit()
        return dict(row)

    # ---------- T5-1 독립성 파생 필드 ----------
    def set_independence(
        self,
        event_id: str,
        t0_kr: date | None,
        digest_window_end: date | None,
        independence_flag: bool | None,
        overlap_group: str | None,
        contamination_reason: str | None,
        verify_eligible: bool,
    ) -> dict[str, Any]:
        """t0·독립성 파생 필드 갱신 (independence.flag_independence 결과). 동결 대상 필드가 아니므로 frozen 여부와 무관.
        contamination_reason 은 CONTAMINATION_REASONS 만 ';' 결합 허용."""
        row = self._require(event_id)
        for r in (contamination_reason or "").split(";"):
            if r and r not in CONTAMINATION_REASONS:
                raise RegistryError(f"{event_id}: contamination_reason {r!r} not in {CONTAMINATION_REASONS}")
        if independence_flag is not None and not independence_flag and not contamination_reason:
            raise RegistryError(f"{event_id}: independence_flag=False requires contamination_reason")
        row.update(
            t0_kr=t0_kr, digest_window_end=digest_window_end,
            independence_flag=(None if independence_flag is None else bool(independence_flag)),
            overlap_group=overlap_group, contamination_reason=contamination_reason,
            verify_eligible=bool(verify_eligible),
        )
        self._commit()
        return dict(row)

    # ---------- 컨센서스 ----------
    def upsert_consensus(
        self,
        event_id: str,
        value: float,
        unit: str,
        source: str,
        entered_by: str,
        vintage_ts: datetime,
        note: str | None = None,
        single_fetch: bool | None = None,
    ) -> dict[str, Any]:
        """동결 전에만 허용. vintage_ts < scheduled_ts_utc 강제.

        - entered_by="manual:*" → 값 반영 + manual_override=True (AM-4). 덮이는 기존 자동값은 auto_shadow_* 로 보존.
        - entered_by="auto:*"   → manual_override=False 면 값 반영, True 면 auto_shadow_* 에 기록만(동결 대상 필드 불변).
        - single_fetch: 자동 수집 이력 표기(운영 결정 ①). 자동 upsert 에서만 의미가 있고 None 이면 건드리지 않는다.
        """
        row = self._require(event_id)
        if row["frozen"]:
            raise FrozenError(f"{event_id}: frozen at {row['frozen_ts']} — 정정은 supersede()로 새 행 추가")
        vt = _utc(vintage_ts, "vintage_ts")
        if vt is None:
            raise VintageError(f"{event_id}: vintage_ts required")
        if vt >= row["scheduled_ts_utc"]:
            raise VintageError(
                f"{event_id}: vintage_ts {vt.isoformat()} >= scheduled {row['scheduled_ts_utc'].isoformat()} (사후 입력 금지)"
            )
        if value is None or (isinstance(value, float) and math.isnan(value)):
            raise RegistryError(f"{event_id}: consensus value must be a number (None/NaN 금지 — 없으면 upsert하지 말 것)")
        if not _ENTERED_BY_RE.match(entered_by or ""):
            raise RegistryError(f"entered_by must be 'auto:<source>' or 'manual:<name>', got {entered_by!r}")
        is_manual = entered_by.startswith("manual:")
        if not is_manual and row["manual_override"]:
            # AM-4: 수동 우선 — 자동값은 shadow 에 기록만 (vintage·값·출처 보존), 동결 대상 필드는 수동값 유지
            row.update(auto_shadow_value=float(value), auto_shadow_vintage_ts=vt, auto_shadow_source=str(source))
            if single_fetch is not None:
                row["single_fetch"] = bool(single_fetch)
            self._commit()
            return dict(row)
        if is_manual and row["consensus_value"] is not None and str(row["entered_by"] or "").startswith("auto:"):
            # 수동이 기존 자동값을 덮는 경우: 자동값을 shadow 로 옮겨 보존
            row.update(auto_shadow_value=row["consensus_value"], auto_shadow_vintage_ts=row["vintage_ts"],
                       auto_shadow_source=row["source"])
        row.update(
            consensus_value=float(value), consensus_unit=str(unit), source=str(source),
            entered_by=entered_by, vintage_ts=vt,
        )
        if is_manual:
            row["manual_override"] = True
        elif single_fetch is not None:
            row["single_fetch"] = bool(single_fetch)
        if note is not None:
            row["note"] = note
        self._commit()
        return dict(row)

    def freeze(self, event_id: str, at: datetime) -> dict[str, Any]:
        """동결. 값 있으면 grade A, 없으면 grade C(자동 격하). 이미 동결이면 FrozenError."""
        row = self._require(event_id)
        if row["frozen"]:
            raise FrozenError(f"{event_id}: already frozen at {row['frozen_ts']}")
        at_utc = _utc(at, "at")
        if at_utc is None:
            raise RegistryError("freeze requires 'at'")
        has_value = row["consensus_value"] is not None
        row.update(frozen=True, frozen_ts=at_utc, grade="A" if has_value else "C")
        self._commit()
        return dict(row)

    def supersede(
        self,
        event_id: str,
        value: float,
        unit: str,
        source: str,
        entered_by: str,
        vintage_ts: datetime,
        note: str | None = None,
        new_event_id: str | None = None,
        freeze_at: datetime | None = None,
    ) -> dict[str, Any]:
        """동결 후 정정: 원 행은 보존, 새 행(supersedes=event_id)을 등록하고 값 입력.
        vintage 규칙은 동일하게 적용(사후 정정 금지). freeze_at 이 주어지면 즉시 동결."""
        old = self._require(event_id)
        if new_event_id is None:
            base = old["event_id"].split("~r")[0]
            n = 2
            while f"{base}~r{n}" in self._rows:
                n += 1
            new_event_id = f"{base}~r{n}"
        # 원자적: 값 규칙(vintage 등) 위반 시 새 행을 남기지 않는다.
        prev_autosave, self.autosave = self.autosave, False
        try:
            self.register_event(
                new_event_id, old["event_type"], old["asset_scope"], old["scheduled_ts_utc"], old["t0_mode"],
                note=note, supersedes=event_id,
            )
            try:
                self.upsert_consensus(new_event_id, value, unit, source, entered_by, vintage_ts, note=note)
                if freeze_at is not None:
                    self.freeze(new_event_id, freeze_at)
            except RegistryError:
                self._rows.pop(new_event_id, None)
                raise
        finally:
            self.autosave = prev_autosave
        self._commit()
        return self.get(new_event_id)  # type: ignore[return-value]

    # ---------- 실제값 ----------
    def set_actual(
        self,
        event_id: str,
        actual_value: float,
        actual_ts: datetime,
        available_at: datetime,
        note: str | None = None,
    ) -> dict[str, Any]:
        row = self._require(event_id)
        if not row["frozen"]:
            raise RegistryError(f"{event_id}: freeze() 먼저 (컨센서스 동결 전 실제값 입력 금지)")
        if row["actual_value"] is not None:
            raise FrozenError(f"{event_id}: actual already set ({row['actual_value']} @ {row['actual_ts']})")
        a_ts = _utc(actual_ts, "actual_ts")
        av = _utc(available_at, "available_at")
        if av < a_ts:
            raise RegistryError(f"{event_id}: available_at {av} < actual_ts {a_ts}")
        if row["frozen_ts"] is not None and a_ts < row["frozen_ts"]:
            raise RegistryError(f"{event_id}: actual_ts {a_ts} < frozen_ts {row['frozen_ts']}")
        row.update(actual_value=float(actual_value), actual_ts=a_ts, available_at=av)
        if note is not None:
            row["note"] = note
        self._commit()
        return dict(row)


# ---------- 모듈 편의 함수 (기본 경로) ----------
def open_registry(path: Path | None = None) -> ConsensusRegistry:
    return ConsensusRegistry(path)


def register_event(*a, path: Path | None = None, **kw):
    return open_registry(path).register_event(*a, **kw)


def upsert_consensus(*a, path: Path | None = None, **kw):
    return open_registry(path).upsert_consensus(*a, **kw)


def freeze(event_id: str, at: datetime, path: Path | None = None):
    return open_registry(path).freeze(event_id, at)


def set_actual(*a, path: Path | None = None, **kw):
    return open_registry(path).set_actual(*a, **kw)


def get(event_id: str, path: Path | None = None):
    return open_registry(path).get(event_id)


def list_events(path: Path | None = None, **kw):
    return open_registry(path).list(**kw)
