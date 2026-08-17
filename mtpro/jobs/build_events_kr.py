"""T5-1 이벤트 독립성 빌드 잡 — 레지스트리(∪ 캘린더) 이벤트의 t0_kr·소화 창·독립성 → data/silver/events_kr.parquet + 요약.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_events_kr.py [--registry path] [--calendar path] [--out path]
                                                  [--no-registry-write] [--summary-json path] [--calendar-only]

- 입력: silver/consensus_registry.parquet 행(있으면) ∪ config/event_calendar.yaml 이벤트(레지스트리에 없는 것만 추가, row_source=calendar).
  레지스트리가 없으면 캘린더 이벤트만. 소화 창 겹침은 전체 이벤트 집합으로 판정해야 하므로 두 소스를 합친다.
- 캘린더: exchange_calendars XKRX champion, 실패 시 폴백(관측 거래일)+notify(XKRX_FALLBACK) — kr_calendar.load_kr_calendar.
- 출력: silver/events_kr.parquet (schema.SILVER_EVENTS_KR). 레지스트리 행에는 파생 필드를 set_independence 로 되써 준다
  (--no-registry-write 로 끔). 동결 대상 필드는 건드리지 않는다.
- 요약: 이벤트별 표(t0_kr·창·판정·사유·verify_eligible)와 집계를 stdout 에, --summary-json 이면 JSON 저장.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from mtpro import settings  # noqa: E402
from mtpro.events import independence as I  # noqa: E402
from mtpro.events import kr_calendar as KC  # noqa: E402
from mtpro.events.calendar import load_calendar  # noqa: E402
from mtpro.events.registry import ConsensusRegistry  # noqa: E402
from mtpro.schema import SILVER_EVENTS_KR  # noqa: E402

OUT_PATH = settings.SILVER / "events_kr.parquet"


def collect_events(registry: ConsensusRegistry | None, calendar_path: Path | None, calendar_only: bool) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    if registry is not None and not calendar_only:
        for r in registry.list():
            rows[r["event_id"]] = {**r, "row_source": "registry"}
    cal = load_calendar(calendar_path)
    for ev in cal.events:
        if ev.event_id in rows:
            if rows[ev.event_id].get("schedule_status") is None:
                rows[ev.event_id]["schedule_status"] = ev.schedule_status      # 구 레지스트리 파일(컬럼 부재) 보완
            continue
        d = ev.as_dict()
        d.update(scheduled_ts_utc=ev.scheduled_ts_utc, grade=None, consensus_value=None, actual_value=None,
                 row_source="calendar")
        rows[ev.event_id] = d
    return list(rows.values())


def to_table(flagged: list[dict[str, Any]]) -> pa.Table:
    recs = []
    for e in flagged:
        recs.append({
            "event_id": e["event_id"], "event_type": e.get("event_type"), "scheduled_ts_utc": e["scheduled_ts_utc"],
            "t0_mode": e.get("t0_mode"), "schedule_status": e.get("schedule_status"), "grade": e.get("grade"),
            "t0_kr": e["t0_kr"], "digest_window_end": e["digest_window_end"],
            "independence_flag": bool(e["independence_flag"]), "overlap_group": e.get("overlap_group"),
            "contamination_reason": e.get("contamination_reason"), "verify_eligible": bool(e["verify_eligible"]),
            "row_source": e.get("row_source"), "calendar_source": e.get("calendar_source"), "engine_ver": I.ENGINE_VER,
        })
    return pa.Table.from_pylist(recs, schema=SILVER_EVENTS_KR)


def print_table(flagged: list[dict[str, Any]]) -> None:
    hdr = f"{'event_id':<22} {'sched_stat':<11} {'grade':<5} {'t0_kr':<10} {'digest_end':<10} {'ind':<5} {'verify':<6} {'reason':<45} overlap_group"
    print(hdr)
    print("-" * len(hdr))
    for e in flagged:
        print(f"{e['event_id']:<22} {str(e.get('schedule_status')):<11} {str(e.get('grade')):<5} {e['t0_kr']} {e['digest_window_end']} "
              f"{str(e['independence_flag']):<5} {str(e['verify_eligible']):<6} {str(e.get('contamination_reason')):<45} "
              f"{e.get('overlap_group')}")


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", type=Path, default=None, help="consensus_registry.parquet (기본 settings.SILVER)")
    ap.add_argument("--calendar", type=Path, default=None, help="event_calendar.yaml (기본 config/)")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    ap.add_argument("--no-registry-write", action="store_true", help="레지스트리 파생 필드 되쓰기 생략")
    ap.add_argument("--calendar-only", action="store_true", help="레지스트리 무시, 캘린더 이벤트만")
    ap.add_argument("--summary-json", type=Path, default=None)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    reg_path = a.registry or ConsensusRegistry(path=None, autosave=False).path
    registry = ConsensusRegistry(reg_path, autosave=False) if (reg_path.exists() and not a.calendar_only) else None
    print(f"[build_events_kr] registry={'none' if registry is None else f'{reg_path} rows={len(registry)}'}", flush=True)

    cal = KC.load_kr_calendar()
    print(f"[build_events_kr] calendar={json.dumps(cal.describe(), ensure_ascii=False)}", flush=True)

    events = collect_events(registry, a.calendar, a.calendar_only)
    flagged = I.flag_independence(events, cal)
    print_table(flagged)

    tbl = to_table(flagged)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".parquet.tmp")
    pq.write_table(tbl, tmp)
    tmp.replace(a.out)

    n_written = 0
    if registry is not None and not a.no_registry_write:
        for e in flagged:
            if e.get("row_source") == "registry":
                registry.set_independence(e["event_id"], e["t0_kr"], e["digest_window_end"], e["independence_flag"],
                                          e.get("overlap_group"), e.get("contamination_reason"), e["verify_eligible"])
                n_written += 1
        registry.save()

    summary = I.summarize(flagged)
    summary.update(out=str(a.out), n_registry_rows_updated=n_written, calendar=cal.describe(),
                   n_from_registry=sum(1 for e in flagged if e.get("row_source") == "registry"),
                   n_from_calendar=sum(1 for e in flagged if e.get("row_source") == "calendar"))
    print(f"[build_events_kr] summary={json.dumps(summary, ensure_ascii=False, default=str)}", flush=True)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
