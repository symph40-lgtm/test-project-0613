"""미국 4자산 일봉 적재 (T5-2, 계획서 §3.4·§12.3 부품 10 Semi Transmission 재료) — SOXX·NVDA·MU·TSM.

- 소스: yfinance, auto_adjust=True (배당·분할 수정 종가). 시작 2022-06-01 (2023-01 지표용 lookback: z 120 + 직교화 120).
- 산출: data/bronze/us_daily.parquet — date(미국 세션 NY 달력 날짜), ticker, close, ret_pct(같은 ticker 전 세션 대비 %),
  source, fetch_ts. 롱 포맷(자산별 행).
- 실패(예외·빈 응답·자산별 행 수 <min_rows·기존 대비 10%+ 급감·자산 누락)는 alerts.loud_failure("COLLECT_FAIL") 후
  UsDailyIngestError. 조용한 부분 적재 금지 — 4자산 전부 성공해야 쓴다.
- ^SOX(ingest/sox.py, 등급C 재료)는 그대로 둔다. 여기서도 시차 정렬은 하지 않는다 — 국내 거래일 정렬은
  components/gradec.align_prev_us_session(d ≤ t−1 엄격, reused → None) 을 transmission 이 자산별로 재사용한다.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from mtpro import alerts, settings

TICKERS: tuple[str, ...] = ("SOXX", "NVDA", "MU", "TSM")
START = date(2022, 6, 1)
SOURCE_FMT = "yfinance:{ticker}:auto_adjust"
US_DAILY_PATH = settings.BRONZE / "us_daily.parquet"

BRONZE_US_DAILY = pa.schema([
    ("date", pa.date32()),            # 미국 세션 날짜 (America/New_York 달력)
    ("ticker", pa.string()),
    ("close", pa.float64()),          # auto_adjust 종가
    ("ret_pct", pa.float64()),        # 같은 ticker 전 세션 종가 대비 % (첫 행 None)
    ("source", pa.string()),
    ("fetch_ts", pa.timestamp("s", tz="UTC")),
])


class UsDailyIngestError(RuntimeError):
    """미국 4자산 조달 실패 (loud-failure 기록 후 raise)."""


def _download(ticker: str, start: date, end: Optional[date]) -> pd.DataFrame:
    import yfinance as yf  # 지연 import: 테스트에서 네트워크 없이 모듈을 쓰기 위함

    return yf.download(
        ticker,
        start=start.isoformat(),
        end=end.isoformat() if end else None,
        auto_adjust=True,
        progress=False,
        threads=False,
    )


def normalize_history(raw: pd.DataFrame, ticker: str, fetch_ts: Optional[datetime] = None) -> pd.DataFrame:
    """yfinance 원본(단일 ticker) → bronze 스키마 DataFrame. 열 이름 대소문자·MultiIndex 정리, 날짜는 NY 달력 날짜."""
    if raw is None or len(raw) == 0:
        raise UsDailyIngestError(f"{ticker}: empty response")
    df = raw.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df.columns = [str(c).lower() for c in df.columns]
    if "close" not in df.columns:
        raise UsDailyIngestError(f"{ticker}: no close column: {list(df.columns)}")
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is not None:
        idx = idx.tz_convert("America/New_York").tz_localize(None)
    out = pd.DataFrame({"date": idx.normalize().date, "close": pd.to_numeric(df["close"], errors="coerce").values})
    out = out.dropna(subset=["close"]).drop_duplicates("date", keep="last").sort_values("date").reset_index(drop=True)
    if out.empty:
        raise UsDailyIngestError(f"{ticker}: all close values NaN")
    if (out["close"] <= 0).any():
        raise UsDailyIngestError(f"{ticker}: non-positive close present")
    out.insert(1, "ticker", ticker)
    out["ret_pct"] = out["close"].pct_change() * 100.0          # 첫 행 NaN → parquet null 유지
    out["source"] = SOURCE_FMT.format(ticker=ticker)
    ts = fetch_ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    ts = ts.replace(microsecond=0)
    out["fetch_ts"] = pd.Timestamp(ts).tz_convert("UTC")
    return out


def write_bronze(df: pd.DataFrame, path: Path = US_DAILY_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pandas(df[[f.name for f in BRONZE_US_DAILY]], schema=BRONZE_US_DAILY, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def read_bronze(path: Path = US_DAILY_PATH) -> pd.DataFrame:
    df = pq.read_table(path).to_pandas()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.sort_values(["ticker", "date"]).reset_index(drop=True)


def asset_frame(us: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """롱 포맷에서 자산 하나의 [date, ret_pct, close] (align_prev_us_session 입력용). 없으면 ValueError."""
    d = us[us["ticker"].astype(str) == ticker][["date", "ret_pct", "close"]].copy()
    if d.empty:
        raise ValueError(f"us_daily has no rows for ticker {ticker!r}")
    return d.sort_values("date").reset_index(drop=True)


def ingest(start: date = START, end: Optional[date] = None, path: Path = US_DAILY_PATH, tickers: Sequence[str] = TICKERS,
           min_rows: int = 200) -> pd.DataFrame:
    """4자산 일봉 적재. 하나라도 실패하면 loud-failure 기록 후 UsDailyIngestError (부분 적재 없음). 반환: 적재한 DataFrame."""
    fetch_ts = datetime.now(timezone.utc)
    try:
        parts = []
        for tk in tickers:
            raw = _download(tk, start, end)
            df = normalize_history(raw, tk, fetch_ts=fetch_ts)
            if len(df) < min_rows:
                raise UsDailyIngestError(f"{tk}: too few rows: {len(df)} < {min_rows} (start={start})")
            parts.append(df)
        new = pd.concat(parts, ignore_index=True)
        if path.exists():
            prev = read_bronze(path)
            for tk in tickers:
                n_prev = int((prev["ticker"] == tk).sum())
                n_new = int((new["ticker"] == tk).sum())
                if n_prev and n_new < 0.9 * n_prev:
                    raise UsDailyIngestError(f"{tk}: row count shrank: {n_prev} -> {n_new}; refusing to overwrite")
        write_bronze(new, path)
        return new
    except Exception as e:  # noqa: BLE001 — 모든 실패를 loud 로
        alerts.loud_failure("COLLECT_FAIL", {"component": "ingest.us_daily", "tickers": list(tickers), "start": start.isoformat(),
                                             "error": f"{type(e).__name__}: {e}"}, ts=fetch_ts)
        raise UsDailyIngestError(str(e)) from e


if __name__ == "__main__":
    d = ingest()
    for tk, g in d.groupby("ticker"):
        print(f"{tk}: rows={len(g)} {g['date'].iloc[0]}..{g['date'].iloc[-1]}")
    print(f"-> {US_DAILY_PATH}")
