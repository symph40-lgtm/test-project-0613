"""T5-4 Semiconductor diffusion 빌드 잡 — bronze/silver → silver/semi_group_monthly.parquet → gold/semi_diffusion_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_semi_diffusion.py [--start 2023-01-03] [--no-fetch] [--summary-json path]

단계:
  1. 반도체 종목군 조달(월초 asof PIT): pykrx KRX 지수 PDF(config semi_diffusion.source.index_codes) ∩ bronze constituents(K200 PIT)
     → silver/semi_group_monthly.parquet. --no-fetch 면 기존 silver 를 재사용(없으면 exit 3).
  2. market_above20 = breadth.compute_breadth_panel(전 구간, output_start=None).above_20d_ratio (silver constituents_monthly 재사용)
     — gold/breadth_panel.parquet 와 겹치는 날짜에서 값 일치를 검사(불일치 → loud, exit 4).
  3. semi_diffusion.compute_semi_diffusion_panel → gold/semi_diffusion_panel.parquet, 요약 JSON 출력.
입력은 읽기만 한다(bronze/silver 기존 파일 수정 없음).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
import yaml  # noqa: E402

from mtpro import settings  # noqa: E402
from mtpro.components import breadth as B  # noqa: E402
from mtpro.components import semi_diffusion as SD  # noqa: E402
from mtpro.ingest import semi_group as SG  # noqa: E402

BRONZE_FILES = {
    "constituents": settings.BRONZE / "constituents.parquet",
    "ohlcv_adj_constituents": settings.BRONZE / "ohlcv_adj_constituents.parquet",
}
OPTIONAL_FILES = {"ohlcv_adj": settings.BRONZE / "ohlcv_adj.parquet"}
SILVER_CM = settings.SILVER / "constituents_monthly.parquet"
GOLD_BREADTH = settings.GOLD / "breadth_panel.parquet"
SILVER_OUT = SG.P_SEMI_GROUP
GOLD_OUT = settings.GOLD / "semi_diffusion_panel.parquet"


def load_config() -> dict:
    return yaml.safe_load((settings.CONFIG_DIR / "mtpro.yaml").read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=str, default=str(SD.OUTPUT_START))
    ap.add_argument("--no-fetch", action="store_true", help="silver/semi_group_monthly 재사용 (pykrx 호출 없음)")
    ap.add_argument("--summary-json", type=str, default=None)
    args = ap.parse_args(argv)

    missing = [k for k, p in BRONZE_FILES.items() if not p.exists()] + ([] if SILVER_CM.exists() else ["silver/constituents_monthly"])
    if missing:
        print(f"SEMI_DIFFUSION_INPUT_MISSING {missing}", file=sys.stderr)
        return 3

    cfg_all = load_config()
    cfg = cfg_all["semi_diffusion"]
    b_cfg = cfg_all["breadth"]
    lookback_start = pd.Timestamp(str(b_cfg["lookback_start"])).date()
    output_start = date.fromisoformat(args.start)
    index_codes = [str(c) for c in cfg["source"]["index_codes"]]
    leaders = [str(c) for c in cfg["leaders"]]

    cons = pq.read_table(BRONZE_FILES["constituents"]).to_pandas()
    ohlcv = pq.read_table(BRONZE_FILES["ohlcv_adj_constituents"]).to_pandas()
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.date
    ohlcv = ohlcv[ohlcv["date"] >= lookback_start]
    cm = pq.read_table(SILVER_CM).to_pandas()

    calendar = None
    if OPTIONAL_FILES["ohlcv_adj"].exists():
        idx = pq.read_table(OPTIONAL_FILES["ohlcv_adj"]).to_pandas()
        idx = idx[idx["code"].astype(str).isin(["1028", "KOSPI200"])]
        if len(idx):
            calendar = [d for d in sorted(pd.to_datetime(idx["date"]).dt.date.unique()) if d >= lookback_start]

    settings.ensure_dirs()
    # 1. 반도체 종목군 (월초 asof PIT)
    if args.no_fetch:
        sg = SG.read_semi_group(SILVER_OUT)
        if sg is None or not len(sg):
            print(f"SEMI_GROUP_MISSING {SILVER_OUT} (run without --no-fetch)", file=sys.stderr)
            return 3
        fetched = False
    else:
        sg = SG.fetch_semi_group_monthly(cons, index_codes=index_codes)
        if not len(sg):
            print("SEMI_GROUP_EMPTY (KRX PDF ∩ K200 = 0 for all asof)", file=sys.stderr)
            return 4
        SG.write_semi_group(sg, SILVER_OUT)
        fetched = True
    sg["asof"] = pd.to_datetime(sg["asof"]).dt.date
    empty_asofs = sorted(set(pd.to_datetime(cons["asof"]).dt.date.unique()) - set(sg["asof"].unique()))

    # 2. market_above20 (breadth 함수 재사용, 전 구간) + gold breadth_panel 일치 검사
    mkt = B.compute_breadth_panel(ohlcv, cm, output_start=None, calendar=calendar)
    market_above20 = pd.Series(mkt["above_20d_ratio"].values, index=mkt["date"].values, dtype=float)
    parity = None
    if GOLD_BREADTH.exists():
        gb = pq.read_table(GOLD_BREADTH).to_pandas()
        gb["date"] = pd.to_datetime(gb["date"]).dt.date
        j = gb[["date", "above_20d_ratio"]].merge(mkt[["date", "above_20d_ratio"]], on="date", suffixes=("_gold", "_recomp"))
        both = j.dropna()
        max_abs = float((both["above_20d_ratio_gold"] - both["above_20d_ratio_recomp"]).abs().max()) if len(both) else 0.0
        na_mismatch = int((j["above_20d_ratio_gold"].isna() != j["above_20d_ratio_recomp"].isna()).sum())
        parity = {"n_overlap": int(len(j)), "max_abs_diff": max_abs, "na_mismatch": na_mismatch}
        if max_abs > 1e-12 or na_mismatch:
            print(f"MARKET_ABOVE20_PARITY_FAIL {parity}", file=sys.stderr)
            return 4

    # 3. 패널
    panel = SD.compute_semi_diffusion_panel(ohlcv, sg, market_above20, leaders=leaders, output_start=output_start, calendar=calendar)
    pq.write_table(SD.panel_to_arrow(panel), GOLD_OUT)

    price_codes = set(ohlcv["code"].astype(str).unique())
    no_price = sorted(set(sg["code"].astype(str)) - price_codes)
    summary = SD.summarize_panel(panel)
    summary.update({
        "semi_group": SG.summarize_semi_group(sg),
        "semi_group_fetched_now": fetched,
        "semi_group_source": {"method": cfg["source"]["method"], "index_codes": index_codes,
                              "index_names": {c: SG.INDEX_NAMES.get(c) for c in index_codes},
                              "survivorship_bias": bool(sg["survivorship_bias"].any())},
        "k200_asofs_without_semi_members": [str(a) for a in empty_asofs],
        "semi_members_without_price_rows": no_price,
        "market_above20_parity_vs_gold_breadth": parity,
        "calendar_source": "ohlcv_adj(1028)" if calendar is not None else "union(constituent dates)",
        "outputs": {"silver": str(SILVER_OUT), "gold": str(GOLD_OUT)},
        "constants": {"spread_change_days": SD.SPREAD_CHANGE_DAYS, "z": [SD.Z_WINDOW_DAYS, SD.Z_MIN_SAMPLES],
                      "leaders": list(SD.LEADERS), "impulse": [B.IMPULSE_RECENT_DAYS, B.IMPULSE_PRIOR_DAYS]},
    })
    text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
    print(text)
    if args.summary_json:
        Path(args.summary_json).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
