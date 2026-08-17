"""부품 3G 빌드 잡 (T5-2) — ^SOX(bronze/sox_daily) + bronze/ohlcv_adj → gold/gap3g_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_gap3g.py [--no-fetch] [--wait-minutes 45] [--start 2023-01-03] [--summary-json path] [--out path]

- 1단계: ingest.sox.ingest() 로 ^SOX 재적재(--no-fetch 면 기존 bronze/sox_daily.parquet 사용). 실패 loud-failure 후 exit 2.
- 2단계: bronze/ohlcv_adj.parquet 없으면 --wait-minutes 동안 60초 간격 대기, 초과 exit 3 (loud). 입력은 읽기만.
- 3단계: components.gap3g.build_panel → gold/gap3g_panel.parquet + 요약 JSON. **gradec_panel(A-1, Gate R1)은 건드리지 않는다.**
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pandas as pd  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from mtpro import alerts, settings  # noqa: E402
from mtpro.components import gap3g as G  # noqa: E402
from mtpro.ingest import sox as S  # noqa: E402

OHLCV_ADJ = settings.BRONZE / "ohlcv_adj.parquet"


def wait_for(path: Path, minutes: float, interval_s: int = 60) -> bool:
    deadline = time.time() + minutes * 60
    while True:
        if path.exists():
            return True
        if time.time() >= deadline:
            return False
        print(f"[build_gap3g] waiting for {path.name} ... ({int((deadline - time.time()) // 60)} min left)", flush=True)
        time.sleep(interval_s)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-minutes", type=float, default=45)
    ap.add_argument("--no-fetch", action="store_true", help="^SOX 재적재 생략(기존 bronze 사용)")
    ap.add_argument("--start", type=date.fromisoformat, default=date(2023, 1, 3), help="패널 시작일(이전 행은 lookback 으로만 사용)")
    ap.add_argument("--summary-json", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=G.GOLD_GAP3G_PANEL_PATH)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    if a.no_fetch:
        if not S.SOX_DAILY_PATH.exists():
            print(f"[build_gap3g] --no-fetch but {S.SOX_DAILY_PATH} missing", file=sys.stderr)
            return 2
    else:
        try:
            S.ingest()
        except S.SoxIngestError as e:
            print(f"[build_gap3g] SOX ingest failed: {e}", file=sys.stderr)
            return 2
    sox = S.read_bronze()
    print(f"[build_gap3g] sox_daily rows={len(sox)} {sox['date'].iloc[0]}..{sox['date'].iloc[-1]}", flush=True)

    if not wait_for(OHLCV_ADJ, a.wait_minutes):
        alerts.loud_failure("PROCURE_FAIL", {"component": "build_gap3g", "missing": str(OHLCV_ADJ), "waited_min": a.wait_minutes})
        return 3
    ohlcv = pq.read_table(OHLCV_ADJ).to_pandas()
    print(f"[build_gap3g] ohlcv_adj rows={len(ohlcv)} codes={sorted(ohlcv['code'].astype(str).unique())}", flush=True)

    params = G.load_params()
    panel = G.build_panel(ohlcv, sox, params)
    panel = panel[pd.to_datetime(panel["date"]) >= pd.Timestamp(a.start)].reset_index(drop=True)
    G.write_gold(panel, a.out)
    summary = {"engine_ver": G.ENGINE_VER, "time_axis": G.TIME_AXIS, "params": params.__dict__, "out": str(a.out), "rows": int(len(panel)),
               "scopes": G.summarize(panel, params)}
    txt = json.dumps(summary, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
