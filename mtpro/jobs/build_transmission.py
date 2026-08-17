"""부품 10 Semi Transmission 빌드 잡 (T5-2) — 미국 4자산 적재 + bronze/ohlcv_adj → gold/transmission_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_transmission.py [--no-fetch] [--wait-minutes 45] [--start 2023-01-03] [--summary-json path] [--out path]

- 1단계: ingest.us_daily.ingest() 로 SOXX·NVDA·MU·TSM 일봉 재적재(--no-fetch 면 기존 bronze/us_daily.parquet 사용). 실패 loud-failure 후 exit 2.
- 2단계: bronze/ohlcv_adj.parquet 없으면 --wait-minutes 동안 대기, 초과 exit 3 (loud).
- 3단계: components.transmission.build_panel(방법 A) → gold/transmission_panel.parquet + 요약 JSON.
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
from mtpro.components import transmission as T  # noqa: E402
from mtpro.ingest import us_daily as U  # noqa: E402

OHLCV_ADJ = settings.BRONZE / "ohlcv_adj.parquet"


def wait_for(path: Path, minutes: float, interval_s: int = 60) -> bool:
    deadline = time.time() + minutes * 60
    while True:
        if path.exists():
            return True
        if time.time() >= deadline:
            return False
        print(f"[build_transmission] waiting for {path.name} ... ({int((deadline - time.time()) // 60)} min left)", flush=True)
        time.sleep(interval_s)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-minutes", type=float, default=45)
    ap.add_argument("--no-fetch", action="store_true", help="미국 4자산 재적재 생략(기존 bronze 사용)")
    ap.add_argument("--start", type=date.fromisoformat, default=date(2023, 1, 3), help="패널 시작일(이전 행은 lookback 으로만 사용)")
    ap.add_argument("--summary-json", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=T.GOLD_TRANSMISSION_PANEL_PATH)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    if a.no_fetch:
        if not U.US_DAILY_PATH.exists():
            print(f"[build_transmission] --no-fetch but {U.US_DAILY_PATH} missing", file=sys.stderr)
            return 2
    else:
        try:
            U.ingest()
        except U.UsDailyIngestError as e:
            print(f"[build_transmission] US daily ingest failed: {e}", file=sys.stderr)
            return 2
    us = U.read_bronze()
    for tk, g in us.groupby("ticker"):
        print(f"[build_transmission] us_daily {tk}: rows={len(g)} {g['date'].iloc[0]}..{g['date'].iloc[-1]}", flush=True)
    missing = [t for t in T.ASSETS if t not in set(us["ticker"])]
    if missing:
        alerts.loud_failure("PROCURE_FAIL", {"component": "build_transmission", "missing_tickers": missing})
        return 2

    if not wait_for(OHLCV_ADJ, a.wait_minutes):
        alerts.loud_failure("PROCURE_FAIL", {"component": "build_transmission", "missing": str(OHLCV_ADJ), "waited_min": a.wait_minutes})
        return 3
    ohlcv = pq.read_table(OHLCV_ADJ).to_pandas()
    print(f"[build_transmission] ohlcv_adj rows={len(ohlcv)} codes={sorted(ohlcv['code'].astype(str).unique())}", flush=True)

    params = T.load_params()
    panel = T.build_panel(ohlcv, us, params)
    panel = panel[pd.to_datetime(panel["date"]) >= pd.Timestamp(a.start)].reset_index(drop=True)
    T.write_gold(panel, a.out)
    summary = {"engine_ver": T.ENGINE_VER, "method": T.METHOD, "design_columns": list(T.DESIGN_COLUMNS), "params": params.__dict__,
               "out": str(a.out), "rows": int(len(panel)), "scopes": T.summarize(panel, params)}
    txt = json.dumps(summary, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
