"""부품 0~2 등급C 빌드 잡 (T3-C) — ^SOX 적재 → bronze/ohlcv_adj.parquet 와 정렬 → gold/gradec_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_gradec.py [--wait-minutes 45] [--no-fetch] [--basis open_to_close|close_to_close]
                                               [--start 2023-01-03] [--summary-json path]

- 1단계: ingest.sox.ingest() 로 ^SOX 일봉 재적재(--no-fetch 면 기존 bronze/sox_daily.parquet 사용). 실패는 loud-failure 후 exit 2.
- 2단계: bronze/ohlcv_adj.parquet(T3-A 적재, price_adjusted=True: 005930·000660·KOSPI200) 없으면 --wait-minutes 동안 60초 간격 대기.
         시간 초과 시 exit 3 (loud). 입력은 읽기만 한다.
- 3단계: components.gradec.build_panel → gold/gradec_panel.parquet, 요약(JSON) 출력. 대체 반응 기준(비교용) 요약도 함께 출력(파일 저장 안 함).
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
from mtpro.components import gradec as G  # noqa: E402
from mtpro.ingest import sox as S  # noqa: E402

OHLCV_ADJ = settings.BRONZE / "ohlcv_adj.parquet"


def wait_for(path: Path, minutes: float, interval_s: int = 60) -> bool:
    deadline = time.time() + minutes * 60
    while True:
        if path.exists():
            return True
        if time.time() >= deadline:
            return False
        print(f"[build_gradec] waiting for {path.name} ... ({int((deadline - time.time()) // 60)} min left)", flush=True)
        time.sleep(interval_s)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-minutes", type=float, default=45)
    ap.add_argument("--no-fetch", action="store_true", help="^SOX 재적재 생략(기존 bronze 사용)")
    ap.add_argument("--basis", choices=list(G.REACTION_BASES), default="open_to_close")
    ap.add_argument("--start", type=date.fromisoformat, default=date(2023, 1, 3), help="패널 시작일(이전 행은 lookback 으로만 사용)")
    ap.add_argument("--summary-json", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=G.GOLD_GRADEC_PANEL_PATH)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    # 1) ^SOX
    if a.no_fetch:
        if not S.SOX_DAILY_PATH.exists():
            print(f"[build_gradec] --no-fetch but {S.SOX_DAILY_PATH} missing", file=sys.stderr)
            return 2
    else:
        try:
            S.ingest()
        except S.SoxIngestError as e:
            print(f"[build_gradec] SOX ingest failed: {e}", file=sys.stderr)
            return 2
    sox = S.read_bronze()
    print(f"[build_gradec] sox_daily rows={len(sox)} {sox['date'].iloc[0]}..{sox['date'].iloc[-1]}", flush=True)

    # 2) OHLCV (다른 잡 적재 대기)
    if not wait_for(OHLCV_ADJ, a.wait_minutes):
        alerts.loud_failure("PROCURE_FAIL", {"component": "build_gradec", "missing": str(OHLCV_ADJ), "waited_min": a.wait_minutes})
        return 3
    ohlcv = pq.read_table(OHLCV_ADJ).to_pandas()
    print(f"[build_gradec] ohlcv_adj rows={len(ohlcv)} codes={sorted(ohlcv['code'].astype(str).unique())}", flush=True)

    # 3) 패널
    params = G.load_params(reaction_basis=a.basis)
    panel = G.build_panel(ohlcv, sox, params)
    panel = panel[pd.to_datetime(panel["date"]) >= pd.Timestamp(a.start)].reset_index(drop=True)
    G.write_gold(panel, a.out)
    summary = {"basis": a.basis, "params": params.__dict__, "out": str(a.out), "rows": int(len(panel)),
               "scopes": G.summarize(panel, params)}
    alt = "close_to_close" if a.basis == "open_to_close" else "open_to_close"
    alt_panel = G.build_panel(ohlcv, sox, G.load_params(reaction_basis=alt))
    alt_panel = alt_panel[pd.to_datetime(alt_panel["date"]) >= pd.Timestamp(a.start)]
    summary["alt_basis"] = {"basis": alt, "scopes": G.summarize(alt_panel, params)}
    txt = json.dumps(summary, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
