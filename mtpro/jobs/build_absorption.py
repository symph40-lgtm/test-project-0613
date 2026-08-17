"""부품 3 장중 6점 빌드 잡 (T5-6) — bronze/minute + gold/gap3g_panel(등급C 방향) + gold/expected_reaction_events(등급A 방향) → gold/absorption_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_absorption.py [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--summary-json path] [--out path]

- 패널 행 = XKRX 세션 [start, end] (start 기본 = 분봉 최초 적재일, end 기본 = 마지막 완결 세션). 분봉 없는 세션은 값 None 행(z 창 세기용).
- 분봉이 하나도 없으면 exit 3 (loud PROCURE_FAIL — accumulate_minutes 먼저).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):                       # Windows 콘솔(cp949) 에서 JSON/한글 출력 깨짐·예외 방지
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

import pandas as pd  # noqa: E402

from mtpro import alerts, settings  # noqa: E402
from mtpro.components import absorption as A  # noqa: E402
from mtpro.components import gap3g as G  # noqa: E402
from mtpro.events import expected_reaction as ER  # noqa: E402
from mtpro.events import kr_calendar as KC  # noqa: E402
from mtpro.ingest import kis_minute_store as MS  # noqa: E402
from mtpro.kis.client import KST  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=date.fromisoformat, default=None)
    ap.add_argument("--end", type=date.fromisoformat, default=None)
    ap.add_argument("--summary-json", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=A.GOLD_ABSORPTION_PANEL_PATH)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    stored = {c: MS.stored_days(c) for c in A.SCOPES}
    all_days = sorted(set().union(*stored.values())) if any(stored.values()) else []
    if not all_days:
        alerts.loud_failure("PROCURE_FAIL", {"component": "build_absorption", "missing": str(MS.MINUTE_ROOT), "action": "jobs/accumulate_minutes.py 먼저"})
        return 3
    cal = KC.default_calendar()
    now = datetime.now(KST)
    start = a.start or all_days[0]
    end = a.end or (MS.last_complete_session(cal.sessions_between(all_days[0], now.date()), now) or all_days[-1])
    sessions = cal.sessions_between(start, end)

    minute = pd.concat([MS.read_range(c, start, end) for c in A.SCOPES], ignore_index=True)
    gap3g = G.read_gold() if G.GOLD_GAP3G_PANEL_PATH.exists() else None
    er = ER.read_gold() if ER.GOLD_EXPECTED_REACTION_PATH.exists() else None
    notes = []
    if gap3g is None:
        notes.append("gold/gap3g_panel.parquet missing → 등급C 방향 없음")
    if er is None or not len(er):
        notes.append("gold/expected_reaction_events 없음/0행 → 등급A 방향 없음(전부 등급C)")
    material = A.material_table(gap3g, er, A.SCOPES)
    params = A.load_params()
    panel = A.build_panel(minute, material, sessions, params, A.SCOPES)
    A.write_gold(panel, a.out)
    summary = {"engine_ver": A.ENGINE_VER, "time_axis": A.TIME_AXIS, "params": params.__dict__, "out": str(a.out), "rows": int(len(panel)),
               "window": [start.isoformat(), end.isoformat()], "n_sessions": len(sessions),
               "minute_store": MS.summarize_store(A.SCOPES), "notes": notes, "scopes": A.summarize(panel)}
    txt = json.dumps(summary, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
