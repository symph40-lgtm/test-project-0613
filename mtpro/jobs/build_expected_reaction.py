"""등급A Expected Reaction 빌드 잡 (T5-6) — silver/consensus_registry + bronze(macro_daily·sox_daily) + gold/gap3g_panel → gold/expected_reaction_events.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_expected_reaction.py [--no-fetch] [--registry path] [--summary-json path] [--out path]

- 1단계: ingest.macro_daily.ingest() 로 ^VIX·^TNX 재적재(--no-fetch 면 기존 bronze 사용, 없으면 피처 None 으로 진행 + 기록). 실패 loud-failure 후 exit 2.
- 2단계: 레지스트리 등급A(동결·actual 있음) 이벤트 → surprise_z·피처 → 스코프별 독립 Expected Reaction. 등급A 이벤트 0건이면 **0행 파일 + "0 이벤트" 정직 출력**(exit 0).
- 3단계: 요약 JSON(stdout, --summary-json). gap3g_panel 파일은 건드리지 않는다(overlay 는 순수 함수 인터페이스만).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):                       # Windows 콘솔(cp949) 에서 JSON/한글 출력 깨짐·예외 방지
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

import pandas as pd  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from mtpro import alerts, settings  # noqa: E402
from mtpro.components import gap3g as G  # noqa: E402
from mtpro.events import expected_reaction as ER  # noqa: E402
from mtpro.events import kr_calendar as KC  # noqa: E402
from mtpro.events.registry import ConsensusRegistry  # noqa: E402
from mtpro.ingest import macro_daily as M  # noqa: E402
from mtpro.ingest import sox as S  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true", help="^VIX·^TNX 재적재 생략(기존 bronze/macro_daily 사용)")
    ap.add_argument("--registry", type=Path, default=None, help="consensus_registry.parquet (기본 settings.SILVER)")
    ap.add_argument("--summary-json", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=ER.GOLD_EXPECTED_REACTION_PATH)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    notes: list[str] = []
    if not a.no_fetch:
        try:
            M.ingest()
        except Exception as e:  # noqa: BLE001 — ingest 가 이미 loud-failure 기록
            print(f"[build_expected_reaction] macro ingest failed: {e}", file=sys.stderr)
            return 2
    vix = tnx = None
    if M.MACRO_DAILY_PATH.exists():
        macro = M.read_bronze()
        try:
            vix = M.asset_frame(macro, "^VIX")
            tnx = M.asset_frame(macro, "^TNX")
        except ValueError as e:
            notes.append(f"macro_daily incomplete: {e}")
    else:
        notes.append("bronze/macro_daily.parquet missing → vix_z·rate_change_bp None")
    sox = S.read_bronze() if S.SOX_DAILY_PATH.exists() else None
    if sox is None:
        notes.append("bronze/sox_daily.parquet missing → sox_shift_z None")
    reactions = None
    if G.GOLD_GAP3G_PANEL_PATH.exists():
        reactions = G.read_gold()[["date", "scope", "gap_pct"]]
    else:
        notes.append("gold/gap3g_panel.parquet missing → gap_pct None (build_gap3g 먼저)")

    reg = ConsensusRegistry(a.registry) if a.registry else ConsensusRegistry()
    rows = reg.list()
    cal = KC.default_calendar()
    events = ER.event_table(rows, cal)
    dropped = events.attrs.get("dropped", [])
    params = ER.load_params()
    if len(events):
        events = ER.add_surprise(events, params)
        sess = cal.sessions_between(min(events["t0_kr"]) - pd.Timedelta(days=14).to_pytimedelta(), max(events["t0_kr"]))
        events = ER.build_features(events, vix, sox, tnx, params, sessions=sess)
        out = ER.build_events(events, reactions, params)
    else:
        out = pd.DataFrame(columns=[f.name for f in ER.GOLD_EXPECTED_REACTION_EVENTS])
    ER.write_gold(out, a.out)
    summary = ER.summarize(out, dropped)
    summary.update({"registry_rows": len(rows), "grade_a_events": int(len(events)), "params": params.__dict__, "out": str(a.out),
                    "calendar": cal.describe(), "notes": notes})
    if not len(events):
        summary["verdict"] = "0 grade-A events in registry (frozen with consensus & actual) — nothing to estimate; wrote empty table"
        print("[build_expected_reaction] 등급A 이벤트 0건 — 산출 없음(0행 파일 기록)", file=sys.stderr)
    txt = json.dumps(summary, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
