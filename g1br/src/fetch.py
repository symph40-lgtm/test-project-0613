# T2 — 수집 + parquet 캐시 (WORKORDER §3 / 스펙 §2.1)
# 멱등: 캐시 존재 시 마지막 날짜-7일부터 증분 수집 후 data_date 기준 dedupe(최신 우선).
# 정규화(수정주가·통화·단위)는 여기서 하지 않는다 — align 이후 단계 소관 (1주차 범위 밖).
# 각 레코드 필수 컬럼: source, fetch_ts, data_date (WORKORDER §3).
import os
import datetime as dt
from pathlib import Path

import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
START = "2023-01-01"

# 스펙 §2.1 + AUDIT 결정 반영: 금리 = 야후(^TNX·2YY=F) 주 소스, FRED 검증 병행 (AUDIT §3-부록)
YF_DAILY = [
    "^GSPC", "SOXX", "TSM", "MU", "NVDA", "EWY", "KRW=X", "SMSN.IL",
    "^N225", "^AXJO", "RSP", "SPY", "^TNX", "2YY=F",
]
PYKRX_EQUITY = ["005930", "000660"]


def _fname(name: str) -> Path:
    return RAW / (name.replace("^", "_i_").replace("=", "_eq_").replace(".", "_") + ".parquet")


def _save_incremental(path: Path, new_df: pd.DataFrame) -> pd.DataFrame:
    if new_df.empty:
        return pd.read_parquet(path) if path.exists() else new_df
    if path.exists():
        old = pd.read_parquet(path)
        df = pd.concat([old, new_df], ignore_index=True)
        df = df.drop_duplicates(subset=["data_date"], keep="last").sort_values("data_date")
    else:
        df = new_df.sort_values("data_date")
    df.to_parquet(path, index=False)
    return df


def _resume_start(path: Path) -> str:
    # 멱등 증분: 캐시 마지막 날짜 − 7일 (수정·정정 반영 여지)
    if not path.exists():
        return START
    last = pd.read_parquet(path)["data_date"].max()
    return (pd.Timestamp(last) - pd.Timedelta(days=7)).date().isoformat()


def fetch_yf_daily() -> dict:
    import yfinance as yf
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    summary = {}
    for t in YF_DAILY:
        path = _fname("yf_" + t)
        try:
            df = yf.Ticker(t).history(start=_resume_start(path), auto_adjust=True)
            if df.empty:
                summary[t] = "empty(신규 없음)"
                continue
            out = pd.DataFrame({
                "data_date": [d.date().isoformat() for d in df.index],
                "open": df["Open"].values, "high": df["High"].values,
                "low": df["Low"].values, "close": df["Close"].values,
                "volume": df["Volume"].values,
                "source": f"yfinance:{t}", "fetch_ts": now,
            })
            total = _save_incremental(path, out)
            summary[t] = f"{len(total)}행 (+{len(out)} 수집)"
        except Exception as e:
            summary[t] = f"ERR {type(e).__name__}: {e}"[:120]
    return summary


def fetch_pykrx_equity() -> dict:
    from pykrx import stock
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    summary = {}
    for code in PYKRX_EQUITY:
        path = _fname("krx_" + code)
        try:
            s = _resume_start(path).replace("-", "")
            df = stock.get_market_ohlcv(s, dt.date.today().isoformat().replace("-", ""), code, adjusted=True)
            if df.empty:
                summary[code] = "empty"
                continue
            out = pd.DataFrame({
                "data_date": [d.date().isoformat() for d in df.index],
                "open": df["시가"].values, "high": df["고가"].values,
                "low": df["저가"].values, "close": df["종가"].values,
                "volume": df["거래량"].values,
                "source": f"pykrx:{code}(adj)", "fetch_ts": now,
            })
            total = _save_incremental(path, out)
            summary[code] = f"{len(total)}행 (+{len(out)})"
        except Exception as e:
            summary[code] = f"ERR {type(e).__name__}: {e}"[:120]
    return summary


def fetch_kospi200() -> dict:
    # AUDIT §3-부록 결정 1: KRX_ID/KRX_PW 있으면 pykrx 지수(정본), 없으면 ^KS200 폴백.
    # 어느 쪽을 썼는지 source 컬럼에 남는다 — 소스 전환 시 파일을 새로 만들어 혼합을 막는다.
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    has_account = bool(os.environ.get("KRX_ID") and os.environ.get("KRX_PW"))
    if has_account:
        from pykrx import stock
        path = _fname("kospi200_pykrx")
        try:
            s = _resume_start(path).replace("-", "")
            df = stock.get_index_ohlcv(s, dt.date.today().isoformat().replace("-", ""), "1028")
            out = pd.DataFrame({
                "data_date": [d.date().isoformat() for d in df.index],
                "open": df["시가"].values, "high": df["고가"].values,
                "low": df["저가"].values, "close": df["종가"].values,
                "volume": df.get("거래량", pd.Series([0] * len(df))).values,
                "source": "pykrx:1028", "fetch_ts": now,
            })
            total = _save_incremental(path, out)
            return {"kospi200": f"pykrx 정본 {len(total)}행"}
        except Exception as e:
            return {"kospi200": f"pykrx 실패({str(e)[:60]}) — 계정 확인 필요, 이번 회차 ^KS200 폴백 미실행"}
    import yfinance as yf
    path = _fname("kospi200_ks200")
    df = yf.Ticker("^KS200").history(start=_resume_start(path), auto_adjust=True)
    out = pd.DataFrame({
        "data_date": [d.date().isoformat() for d in df.index],
        "open": df["Open"].values, "high": df["High"].values,
        "low": df["Low"].values, "close": df["Close"].values,
        "volume": df["Volume"].values,
        "source": "yfinance:^KS200(폴백)", "fetch_ts": now,
    })
    total = _save_incremental(path, out)
    return {"kospi200": f"^KS200 폴백 {len(total)}행 (KRX_ID 미설정)"}


def fetch_fred() -> dict:
    # 검증 병행용 (주 소스는 야후 — AUDIT 결정 2). 지연 1영업일은 실측 확정 사항.
    import pandas_datareader.data as web
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    summary = {}
    for s in ["DGS2", "DGS10"]:
        path = _fname("fred_" + s)
        try:
            df = web.DataReader(s, "fred", _resume_start(path), dt.date.today())
            ser = df[s]
            out = pd.DataFrame({
                "data_date": [d.date().isoformat() for d in ser.index],
                "close": ser.values,
                "source": f"fred:{s}", "fetch_ts": now,
            })
            total = _save_incremental(path, out)
            summary[s] = f"{len(total)}행"
        except Exception as e:
            summary[s] = f"ERR {str(e)[:100]}"
    return summary


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    all_summary = {}
    for fn in [fetch_yf_daily, fetch_pykrx_equity, fetch_kospi200, fetch_fred]:
        all_summary.update(fn())
    width = max(len(k) for k in all_summary)
    for k, v in all_summary.items():
        print(f"  {k.ljust(width)}  {v}")


if __name__ == "__main__":
    main()
