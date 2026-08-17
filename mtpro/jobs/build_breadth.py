"""부품 5 Breadth 빌드 잡 — bronze → silver/constituents_monthly.parquet → gold/breadth_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_breadth.py [--wait-minutes 45] [--start 2023-01-03] [--summary-json path]

- bronze 파일이 아직 없으면 --wait-minutes 동안 60초 간격으로 대기(다른 잡이 적재 중일 수 있음). 시간 초과 시 exit 3 (loud).
- 입력은 읽기만 한다. config/mtpro.yaml 의 breadth 블록(tiers·lookback_start)을 상수 검증에 사용.
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
for _s in (sys.stdout, sys.stderr):          # Windows cp949 콘솔에서도 한글·대시 출력 (loud-failure 메시지가 인코딩으로 죽지 않게)
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import pandas as pd  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
import yaml  # noqa: E402

from mtpro import settings  # noqa: E402
from mtpro.components import breadth as B  # noqa: E402

BRONZE_FILES = {
    "constituents": settings.BRONZE / "constituents.parquet",
    "market_cap": settings.BRONZE / "market_cap.parquet",
    "ohlcv_adj_constituents": settings.BRONZE / "ohlcv_adj_constituents.parquet",
}
OPTIONAL_FILES = {"ohlcv_adj": settings.BRONZE / "ohlcv_adj.parquet"}   # 1028 지수 달력용 (없으면 종목 날짜 합집합)
SILVER_OUT = settings.SILVER / "constituents_monthly.parquet"
GOLD_OUT = settings.GOLD / "breadth_panel.parquet"


def wait_for_bronze(minutes: float, interval_s: int = 60) -> bool:
    deadline = time.time() + minutes * 60
    while True:
        missing = [k for k, p in BRONZE_FILES.items() if not p.exists()]
        if not missing:
            return True
        if time.time() >= deadline:
            print(f"BREADTH_WAIT_TIMEOUT missing={missing}", file=sys.stderr)
            return False
        print(f"[wait] bronze missing {missing} — retry in {interval_s}s "
              f"(remaining {int((deadline - time.time()) / 60)} min)", flush=True)
        time.sleep(interval_s)


def load_config() -> dict:
    return yaml.safe_load((settings.CONFIG_DIR / "mtpro.yaml").read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-minutes", type=float, default=0.0)
    ap.add_argument("--start", type=str, default=str(B.OUTPUT_START), help="출력 시작일 (기본 2023-01-03)")
    ap.add_argument("--index-code", type=str, default=B.DEFAULT_INDEX_CODE)
    ap.add_argument("--summary-json", type=str, default=None)
    args = ap.parse_args(argv)

    if not wait_for_bronze(args.wait_minutes):
        return 3

    cfg = load_config()["breadth"]
    tiers = {k: tuple(v) for k, v in cfg["tiers"].items()}
    lookback_start = pd.Timestamp(str(cfg["lookback_start"])).date()
    output_start = date.fromisoformat(args.start)

    cons = pq.read_table(BRONZE_FILES["constituents"]).to_pandas()
    mcap = pq.read_table(BRONZE_FILES["market_cap"]).to_pandas()
    ohlcv = pq.read_table(BRONZE_FILES["ohlcv_adj_constituents"]).to_pandas()
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.date
    ohlcv = ohlcv[ohlcv["date"] >= lookback_start]

    calendar = None
    if OPTIONAL_FILES["ohlcv_adj"].exists():
        idx = pq.read_table(OPTIONAL_FILES["ohlcv_adj"]).to_pandas()
        # ingest 는 지수 1028 을 code 'KOSPI200' 으로 저장 (krx.ingest_ohlcv_adj index_name). 둘 다 허용.
        idx = idx[idx["code"].astype(str).isin([args.index_code, "KOSPI200"])]
        if len(idx):
            calendar = sorted(pd.to_datetime(idx["date"]).dt.date.unique())
            calendar = [d for d in calendar if d >= lookback_start]

    settings.ensure_dirs()
    cm = B.build_constituents_monthly(cons, mcap, tiers=tiers, index_code=args.index_code)
    pq.write_table(B.constituents_monthly_to_arrow(cm), SILVER_OUT)

    panel = B.compute_breadth_panel(ohlcv, cm, output_start=output_start, calendar=calendar)
    pq.write_table(B.panel_to_arrow(panel), GOLD_OUT)

    # 보고용 진단 (파일 밖 정보: 멤버 대비 가격 커버리지)
    price_codes = set(ohlcv["code"].astype(str).unique())
    cm_codes = set(cm["code"].astype(str).unique())
    no_price = sorted(cm_codes - price_codes)
    tier_none = int(cm["tier"].isna().sum())
    summary = B.summarize_panel(panel)
    summary.update({
        "silver_constituents_monthly": {"rows": int(len(cm)), "months": int(cm["asof"].nunique()),
                                        "asof_range": [str(cm["asof"].min()), str(cm["asof"].max())],
                                        "codes_unique": len(cm_codes), "tier_none_rows": tier_none,
                                        "members_per_month": {"min": int(cm.groupby("asof").size().min()),
                                                              "max": int(cm.groupby("asof").size().max())}},
        "members_without_any_price_rows": {"count": len(no_price), "codes": no_price[:50]},
        "ohlcv_adj_constituents": {"rows": int(len(ohlcv)), "codes": len(price_codes),
                                   "date_range": [str(ohlcv["date"].min()), str(ohlcv["date"].max())]},
        "calendar_source": "ohlcv_adj(1028)" if calendar is not None else "union(constituent dates)",
        "outputs": {"silver": str(SILVER_OUT), "gold": str(GOLD_OUT)},
        "constants": {"MA": [B.MA_SHORT_DAYS, B.MA_LONG_DAYS], "HL": B.HIGH_LOW_WINDOW_DAYS,
                      "impulse": [B.IMPULSE_RECENT_DAYS, B.IMPULSE_PRIOR_DAYS],
                      "z": [B.IMPULSE_Z_WINDOW_DAYS, B.IMPULSE_Z_MIN_SAMPLES],
                      "leadership": [B.LEADERSHIP_LARGE_ONLY, B.LEADERSHIP_BROAD], "tiers": tiers},
    })
    text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
    print(text)
    if args.summary_json:
        Path(args.summary_json).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
