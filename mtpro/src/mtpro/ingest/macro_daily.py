"""^VIX·^TNX 일봉 적재 (T5-6 Expected Reaction 피처 vix_z·rate_change_bp 재료) — ingest/us_daily 의 함수를 다른 상수로 재사용.

- 소스: yfinance ^VIX(변동성 지수, 레벨), ^TNX(미 10년 국채 수익률, % 단위 → rate_change 는 ×100 bp). auto_adjust=True(지수라 무의미, 명시).
- 산출: data/bronze/macro_daily.parquet — us_daily 와 같은 롱 포맷(date, ticker, close, ret_pct, source, fetch_ts).
- 실패는 us_daily.ingest 가 loud-failure(COLLECT_FAIL, component=ingest.us_daily, tickers=[^VIX, ^TNX]) 후 UsDailyIngestError.
- 시차 정렬은 여기서 하지 않는다 (events/expected_reaction.build_features 가 세션 d ≤ t0_kr−1 로 정렬).
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd

from mtpro import settings
from mtpro.ingest import us_daily as U

TICKERS: tuple[str, ...] = ("^VIX", "^TNX")
START = date(2022, 6, 1)
MACRO_DAILY_PATH = settings.BRONZE / "macro_daily.parquet"
BRONZE_MACRO_DAILY = U.BRONZE_US_DAILY


def ingest(start: date = START, end: Optional[date] = None, path: Path = MACRO_DAILY_PATH, min_rows: int = 200) -> pd.DataFrame:
    return U.ingest(start=start, end=end, path=path, tickers=TICKERS, min_rows=min_rows)


def read_bronze(path: Path = MACRO_DAILY_PATH) -> pd.DataFrame:
    return U.read_bronze(path)


def asset_frame(macro: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """[date, close, ret_pct] (오름차순)."""
    d = U.asset_frame(macro, ticker)
    return d[["date", "close", "ret_pct"]].reset_index(drop=True)


if __name__ == "__main__":
    d = ingest()
    for tk, g in d.groupby("ticker"):
        print(f"{tk}: rows={len(g)} {g['date'].iloc[0]}..{g['date'].iloc[-1]}")
    print(f"-> {MACRO_DAILY_PATH}")
