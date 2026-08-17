"""컨센서스 레지스트리 CLI.

  python -m mtpro.events.cli add-manual --event-id US_CPI_20260911 --value 0.3 --unit % [--by chungpyo] [--source ...] [--note ...] [--freeze]
  python -m mtpro.events.cli freeze --event-id US_CPI_20260911 [--at 2026-09-10T12:00:00+00:00]
  python -m mtpro.events.cli supersede --event-id US_CPI_20260911 --value 0.2 --unit % --by chungpyo [--note ...]
  python -m mtpro.events.cli set-actual --event-id ... --value 0.2 --actual-ts 2026-09-11T12:30:00+00:00 [--available-at ...]
  python -m mtpro.events.cli show [--event-id ...] [--all]
  python -m mtpro.events.cli calendar [--days 60]
  python -m mtpro.events.cli run [--now 2026-09-10T00:00:00+00:00] [--dry-run]

규칙: add-manual 은 캘린더에 있는 event_id 만 허용(자동 등록). 동결 후 add-manual/freeze 는 예외로 거부(정정은 supersede).
AM-4: add-manual 은 레지스트리 행에 manual_override=true 를 남기고, 이후 D-1 자동 수집은 auto_shadow_* 에 기록만 된다(수동값 동결).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from mtpro import settings
from mtpro.events.calendar import load_calendar
from mtpro.events.registry import ConsensusRegistry, RegistryError


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    ts = datetime.fromisoformat(s)
    if ts.tzinfo is None:
        raise SystemExit(f"timestamp must be tz-aware ISO8601 (e.g. 2026-09-10T12:00:00+00:00): {s}")
    return ts.astimezone(timezone.utc)


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str, indent=2)


def _registry(args) -> ConsensusRegistry:
    return ConsensusRegistry(Path(args.registry) if args.registry else None)


def cmd_add_manual(args) -> int:
    cal = load_calendar(Path(args.calendar) if args.calendar else None)
    ev = cal.get(args.event_id)
    if ev is None:
        raise SystemExit(f"event_id {args.event_id!r} not in calendar ({cal.version}) — 캘린더에 먼저 등록하세요 (사후 등록 금지)")
    reg = _registry(args)
    if args.event_id not in reg:
        reg.register_event(ev.event_id, ev.event_type, ev.asset_scope, ev.scheduled_ts_utc, ev.t0_mode,
                           note=f"calendar:{ev.status}")
    vintage = _parse_ts(args.vintage) or _now()
    row = reg.upsert_consensus(args.event_id, args.value, args.unit, source=args.source or "manual",
                               entered_by=f"manual:{args.by}", vintage_ts=vintage, note=args.note)
    if args.freeze:
        row = reg.freeze(args.event_id, _now())
    print(_dump(row))
    return 0


def cmd_freeze(args) -> int:
    reg = _registry(args)
    row = reg.freeze(args.event_id, _parse_ts(args.at) or _now())
    print(_dump(row))
    return 0


def cmd_supersede(args) -> int:
    reg = _registry(args)
    vintage = _parse_ts(args.vintage) or _now()
    row = reg.supersede(args.event_id, args.value, args.unit, source=args.source or "manual",
                        entered_by=f"manual:{args.by}", vintage_ts=vintage, note=args.note,
                        freeze_at=_now())
    print(_dump(row))
    return 0


def cmd_set_actual(args) -> int:
    reg = _registry(args)
    a_ts = _parse_ts(args.actual_ts)
    row = reg.set_actual(args.event_id, args.value, a_ts, _parse_ts(args.available_at) or _now(), note=args.note)
    print(_dump(row))
    return 0


def cmd_show(args) -> int:
    reg = _registry(args)
    if args.event_id:
        row = reg.get(args.event_id)
        if row is None:
            raise SystemExit(f"unknown event_id {args.event_id}")
        print(_dump(row))
        return 0
    rows = reg.list()
    if not rows:
        print(f"(empty registry at {reg.path})")
        return 0
    for r in rows:
        flags = "".join(f" {k}" for k in ("manual_override", "single_fetch") if r.get(k))
        shadow = f" shadow={r['auto_shadow_value']}@{r['auto_shadow_vintage_ts']}" if r.get("auto_shadow_value") is not None else ""
        print(f"{r['event_id']:<24} {r['event_type']:<11} sched={r['scheduled_ts_utc'].isoformat()} "
              f"cons={r['consensus_value']} {r['consensus_unit'] or ''} frozen={r['frozen']} grade={r['grade']} "
              f"by={r['entered_by']} actual={r['actual_value']} sup={r['supersedes']}{flags}{shadow}")
    return 0


def cmd_calendar(args) -> int:
    cal = load_calendar(Path(args.calendar) if args.calendar else None)
    now = _parse_ts(args.now) or _now()
    evs = cal.upcoming(now, args.days) if args.days else cal.events
    print(f"calendar {cal.version}: {len(evs)} events")
    for e in evs:
        print(f"{e.event_id:<24} {e.event_type:<11} {e.scheduled_ts_utc.isoformat()} {e.t0_mode:<12} {e.status:<11} {e.evidence[:70]}")
    return 0


def cmd_run(args) -> int:
    from mtpro.events.scheduler import run_collection, select_targets

    cal = load_calendar(Path(args.calendar) if args.calendar else None)
    reg = _registry(args)
    now = _parse_ts(args.now) or _now()
    if args.dry_run:
        for ev, stage in select_targets(cal.events, now, reg):
            print(f"[dry-run] {stage:<5} {ev.event_id} sched={ev.scheduled_ts_utc.isoformat()}")
        return 0
    settings.ensure_dirs()
    results = run_collection(now, cal, reg)
    for r in results:
        print(f"{r.stage:<5} {r.event_id:<24} {r.status:<11} value={r.value} {r.unit or ''} grade={r.grade} :: {r.detail}")
    if not results:
        print(f"no targets at {now.isoformat()}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m mtpro.events.cli", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--registry", help="parquet path (default SILVER/consensus_registry.parquet)")
    p.add_argument("--calendar", help="yaml path (default config/event_calendar.yaml)")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add-manual", help="발주자 수동 컨센서스 1건 입력 (동결 전만)")
    a.add_argument("--event-id", required=True)
    a.add_argument("--value", type=float, required=True)
    a.add_argument("--unit", required=True)
    a.add_argument("--by", default="chungpyo", help="입력자 이름 → entered_by=manual:<name>")
    a.add_argument("--source", help="값의 출처 메모(URL 등)")
    a.add_argument("--vintage", help="값을 확인한 시각(ISO, tz 필수). 기본 지금")
    a.add_argument("--note")
    a.add_argument("--freeze", action="store_true", help="입력 즉시 동결")
    a.set_defaults(fn=cmd_add_manual)

    f = sub.add_parser("freeze", help="동결 (값 없으면 등급C)")
    f.add_argument("--event-id", required=True)
    f.add_argument("--at", help="동결 시각(ISO, tz 필수). 기본 지금")
    f.set_defaults(fn=cmd_freeze)

    s = sub.add_parser("supersede", help="동결 후 정정: 새 행 + supersedes 링크 (즉시 동결)")
    s.add_argument("--event-id", required=True)
    s.add_argument("--value", type=float, required=True)
    s.add_argument("--unit", required=True)
    s.add_argument("--by", default="chungpyo")
    s.add_argument("--source")
    s.add_argument("--vintage")
    s.add_argument("--note")
    s.set_defaults(fn=cmd_supersede)

    x = sub.add_parser("set-actual", help="발표 후 실제값 입력")
    x.add_argument("--event-id", required=True)
    x.add_argument("--value", type=float, required=True)
    x.add_argument("--actual-ts", required=True)
    x.add_argument("--available-at")
    x.add_argument("--note")
    x.set_defaults(fn=cmd_set_actual)

    sh = sub.add_parser("show", help="조회")
    sh.add_argument("--event-id")
    sh.add_argument("--all", action="store_true")
    sh.set_defaults(fn=cmd_show)

    c = sub.add_parser("calendar", help="캘린더 조회")
    c.add_argument("--days", type=int, default=0, help="지금부터 N일 (0=전체)")
    c.add_argument("--now")
    c.set_defaults(fn=cmd_calendar)

    r = sub.add_parser("run", help="D-3/D-1 수집 실행 (크론)")
    r.add_argument("--now")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(fn=cmd_run)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except RegistryError as exc:
        print(f"REGISTRY_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
