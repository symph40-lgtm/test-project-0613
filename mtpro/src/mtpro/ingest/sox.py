"""^SOX(필라델피아 반도체 지수) 일봉 적재 — 소급 트랙 등급C 재료 (T3-C, WORKORDER §2.1 "부품 0~2 등급C 모드").

- 소스: yfinance ``^SOX``, auto_adjust=True (지수라 수정 여부 무의미하나 명시). 시작 2022-12-01 (2023-01 지표용 lookback).
- 산출: data/bronze/sox_daily.parquet — date(미국 세션 날짜, NY 달력), close, ret_pct(전 세션 대비 %), source, fetch_ts.
- 실패(예외·빈 응답·행 수 급감)는 loud-failure(alerts.loud_failure "COLLECT_FAIL") 후 예외를 다시 던진다. 조용한 빈 파일 금지.
- 여기서는 시차 정렬을 하지 않는다 — 국내 거래일 정렬은 components/gradec.py ``align_prev_us_session`` 담당.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from mtpro import alerts, settings

TICKER = "^SOX"
START = date(2022, 12, 1)
SOURCE = "yfinance:^SOX:auto_adjust"
SOX_DAILY_PATH = settings.BRONZE / "sox_daily.parquet"

BRONZE_SOX_DAILY = pa.schema([
    ("date", pa.date32()),            # 미국 세션 날짜 (America/New_York 달력)
    ("close", pa.float64()),
    ("ret_pct", pa.float64()),        # 전 세션 종가 대비 % (첫 행 None)
    ("source", pa.string()),
    ("fetch_ts", pa.timestamp("s", tz="UTC")),
])


class SoxIngestError(RuntimeError):
    """^SOX 조달 실패 (loud-failure 기록 후 raise)."""


def _download(start: date, end: Optional[date]) -> pd.DataFrame:
    import yfinance as yf  # 지연 import: 테스트에서 네트워크 없이 모듈을 쓰기 위함

    df = yf.download(
        TICKER,
        start=start.isoformat(),
        end=end.isoformat() if end else None,
        auto_adjust=True,
        progress=False,
        threads=False,
    )
    return df


def normalize_history(raw: pd.DataFrame, fetch_ts: Optional[datetime] = None) -> pd.DataFrame:
    """yfinance 원본 → bronze 스키마 DataFrame. 열 이름 대소문자·MultiIndex 정리, 날짜는 NY 달력 날짜(date)."""
    if raw is None or len(raw) == 0:
        raise SoxIngestError("empty response")
    df = raw.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df.columns = [str(c).lower() for c in df.columns]
    if "close" not in df.columns:
        raise SoxIngestError(f"no close column: {list(df.columns)}")
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is not None:
        idx = idx.tz_convert("America/New_York").tz_localize(None)
    out = pd.DataFrame({"date": idx.normalize().date, "close": pd.to_numeric(df["close"], errors="coerce").values})
    out = out.dropna(subset=["close"]).drop_duplicates("date", keep="last").sort_values("date").reset_index(drop=True)
    if out.empty:
        raise SoxIngestError("all close values NaN")
    out["ret_pct"] = out["close"].pct_change() * 100.0          # 첫 행 NaN → parquet에서 null 유지
    out["source"] = SOURCE
    ts = fetch_ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    ts = ts.replace(microsecond=0)                                # 스키마 timestamp("s") 에 맞춰 초 단위 절단
    out["fetch_ts"] = pd.Timestamp(ts).tz_convert("UTC")
    return out


def write_bronze(df: pd.DataFrame, path: Path = SOX_DAILY_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pandas(df[[f.name for f in BRONZE_SOX_DAILY]], schema=BRONZE_SOX_DAILY, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def read_bronze(path: Path = SOX_DAILY_PATH) -> pd.DataFrame:
    df = pq.read_table(path).to_pandas()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.sort_values("date").reset_index(drop=True)


def ingest(start: date = START, end: Optional[date] = None, path: Path = SOX_DAILY_PATH, min_rows: int = 200) -> pd.DataFrame:
    """^SOX 일봉 적재. 실패 시 loud-failure 기록 후 SoxIngestError. 반환: 적재한 DataFrame."""
    fetch_ts = datetime.now(timezone.utc)
    try:
        raw = _download(start, end)
        df = normalize_history(raw, fetch_ts=fetch_ts)
        if len(df) < min_rows:
            raise SoxIngestError(f"too few rows: {len(df)} < {min_rows} (start={start})")
        # 기존 파일 대비 급감 방지 (조용한 축소 금지)
        if path.exists():
            prev = read_bronze(path)
            if len(df) < 0.9 * len(prev):
                raise SoxIngestError(f"row count shrank: {len(prev)} -> {len(df)}; refusing to overwrite")
        write_bronze(df, path)
        return df
    except Exception as e:  # noqa: BLE001 — 모든 실패를 loud 로
        alerts.loud_failure("COLLECT_FAIL", {"component": "ingest.sox", "ticker": TICKER, "start": start.isoformat(),
                                             "error": f"{type(e).__name__}: {e}"}, ts=fetch_ts)
        raise SoxIngestError(str(e)) from e


if __name__ == "__main__":
    d = ingest()
    print(f"sox_daily rows={len(d)} {d['date'].iloc[0]}..{d['date'].iloc[-1]} -> {SOX_DAILY_PATH}")
