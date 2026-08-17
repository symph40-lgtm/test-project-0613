"""KRX(pykrx) bronze 적재기 — T3-A §1. 스키마 = schema.BRONZE_*.

loud-failure 규약 (T1-1 확정):
- KRX_ID/KRX_PW 없음 → 즉시 `ProcureError("PROCURE_FAIL:KRX_ENV")` (settings.krx_env)
- pykrx가 핵심 시계열에서 빈 DataFrame 반환 → `PROCURE_FAIL:KRX_SESSION` (조용히 0행 저장 금지)
- 일시 오류(429 등)는 3회 재시도 후 `PROCURE_FAIL:KRX_API`
- 구성종목 개별 종목의 0행/오류는 결측 목록으로 기록·저장 생략(상장폐지 등) — 단 세션이 죽은 경우는 KRX_SESSION으로 승격
모든 행에 source·fetch_ts(UTC)·price_adjusted(해당 시) 기록. 증분 적재(기존 parquet 마지막 날짜 이후) 지원.

pykrx는 import 시점에 env(KRX_ID/KRX_PW)로 로그인하고 stdout에 로그인 ID를 찍으므로, `_stock()`이 env 주입 → import를 감싸고
배너는 마스킹해 로그에 남긴다. 세션은 pykrx가 60분 만료 시 자동 재로그인한다(auth.get_auth_session).
"""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pandas as pd

from mtpro import settings
from mtpro.alerts import loud_failure
from mtpro.ingest import store
from mtpro.schema import BRONZE_CONSTITUENTS, BRONZE_INVESTOR_FLOW, BRONZE_MARKET_CAP, BRONZE_OHLCV

SOURCE = "pykrx"
FLOW_START = dt.date(2023, 1, 3)        # 부품 4 소급 시작 (T1-1)
PRICE_START = dt.date(2022, 1, 3)       # 252일 lookback (T1-2)
KOSPI200_INDEX_CODE = "1028"
FLOW_COLMAP = {"기관합계": "institution", "기타법인": "other_corp", "개인": "individual", "외국인합계": "foreign", "전체": "total"}
OHLCV_COLMAP = {"시가": "open", "고가": "high", "저가": "low", "종가": "close", "거래량": "volume", "거래대금": "trading_value"}
MCAP_COLMAP = {"종가": "close", "시가총액": "market_cap", "거래대금": "trading_value", "상장주식수": "shares"}
SLEEP_SEC = 0.1
RETRIES = 3

P_INVESTOR_FLOW = settings.BRONZE / "investor_flow.parquet"
P_OHLCV_UNADJ = settings.BRONZE / "ohlcv_unadj.parquet"
P_OHLCV_ADJ = settings.BRONZE / "ohlcv_adj.parquet"
P_CONSTITUENTS = settings.BRONZE / "constituents.parquet"
P_MARKET_CAP = settings.BRONZE / "market_cap.parquet"
P_OHLCV_ADJ_CONST = settings.BRONZE / "ohlcv_adj_constituents.parquet"
P_INVESTOR_FLOW_CONST = settings.BRONZE / "investor_flow_constituents.parquet"


class ProcureError(RuntimeError):
    """loud-failure. 메시지는 PROCURE_FAIL:<TAG> 로 시작한다."""


def _fail(tag: str, detail) -> ProcureError:
    loud_failure(f"PROCURE_FAIL:{tag}", detail)
    return ProcureError(f"PROCURE_FAIL:{tag} {detail}")


# ---- pykrx 진입 -----------------------------------------------------------
_STOCK = None


def _stock():
    """env 주입 후 pykrx.stock import (1회). 로그인 배너의 ID는 마스킹해 stderr에 남긴다."""
    global _STOCK
    if _STOCK is not None:
        return _STOCK
    creds = settings.krx_env()                     # 없으면 PROCURE_FAIL:KRX_ENV
    os.environ.update(creds)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        from pykrx import stock                    # import 시 build_krx_session()
    banner = re.sub(r"(로그인 ID:\s*)\S+", r"\1***", buf.getvalue())
    print("[MTPRO KRX] " + " | ".join(l.strip() for l in banner.splitlines() if l.strip()), file=sys.stderr)
    _STOCK = stock
    return stock


def session_alive() -> bool:
    try:
        from pykrx.website.comm import auth
        s = auth.get_auth_session()
        return s is not None and s.is_valid()
    except Exception:
        return False


def _call(fn: Callable, *args, what: str, **kwargs):
    """3회 재시도(지수 백오프) 후 PROCURE_FAIL:KRX_API."""
    last = None
    for i in range(RETRIES):
        try:
            with contextlib.redirect_stdout(io.StringIO()):     # pykrx 재로그인 배너 억제
                out = fn(*args, **kwargs)
            time.sleep(SLEEP_SEC)
            return out
        except Exception as ex:                                  # noqa: BLE001
            last = ex
            time.sleep(1.5 * (2 ** i))
    raise _fail("KRX_API", {"what": what, "error": f"{type(last).__name__}: {str(last)[:200]}"})


def _ymd(d: dt.date) -> str:
    return d.strftime("%Y%m%d")


def _now_utc() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC").floor("s")


def _next_day(d: dt.date | None, default: dt.date) -> dt.date:
    return default if d is None else d + dt.timedelta(days=1)


# ---- 변환 -----------------------------------------------------------------
def flow_frame(df: pd.DataFrame, scope: str, fetch_ts) -> pd.DataFrame:
    """pykrx 투자자별 순매수 → BRONZE_INVESTOR_FLOW 행."""
    out = df.rename(columns=FLOW_COLMAP).reset_index().rename(columns={df.index.name or "index": "date"})
    out["date"] = pd.to_datetime(out["date"]).dt.date
    for c in FLOW_COLMAP.values():
        if c not in out.columns:
            out[c] = None
    out["scope"] = scope
    out["unit"] = "KRW"
    out["source"] = SOURCE
    out["fetch_ts"] = fetch_ts
    out["krx_session"] = True
    return out[[f.name for f in BRONZE_INVESTOR_FLOW]]


def ohlcv_frame(df: pd.DataFrame, code: str, price_adjusted: bool, fetch_ts) -> pd.DataFrame:
    out = df.rename(columns=OHLCV_COLMAP).reset_index().rename(columns={df.index.name or "index": "date"})
    out["date"] = pd.to_datetime(out["date"]).dt.date
    for c in ("open", "high", "low", "close", "volume", "trading_value"):
        if c not in out.columns:
            out[c] = None
    if price_adjusted:
        out["trading_value"] = None            # C-2: 거래대금은 비수정 원천에만 둔다 (수정주가 모드엔 원래 없음)
    out["code"] = code
    out["price_adjusted"] = price_adjusted
    out["source"] = SOURCE
    out["fetch_ts"] = fetch_ts
    return out[[f.name for f in BRONZE_OHLCV]]


# ---- 개별 적재기 -----------------------------------------------------------
def _require_rows(df: pd.DataFrame, what: str) -> pd.DataFrame:
    if df is None or len(df) == 0:
        raise _fail("KRX_SESSION", {"what": what, "rows": 0, "session_alive": session_alive()})
    return df


def ingest_investor_flow(scopes=("005930", "000660", "KOSPI"), start: dt.date = FLOW_START, end: dt.date | None = None,
                         path: Path = P_INVESTOR_FLOW) -> dict:
    """투자자별 순매수(순매수 = 기본 on). 증분: scope별 마지막 날짜 이후."""
    st = _stock()
    end = end or dt.date.today()
    old = store.read(path)
    frames, info = [], {}
    for sc in scopes:
        s = _next_day(store.last_date(old, "date", "scope", sc), start)
        if s > end:
            info[sc] = {"rows_new": 0, "skipped": "up-to-date"}
            continue
        df = _call(st.get_market_trading_value_by_date, _ymd(s), _ymd(end), sc, what=f"flow {sc} {s}~{end}")
        if old is None or store.last_date(old, "date", "scope", sc) is None:
            _require_rows(df, f"investor_flow {sc}")           # 최초 적재는 0행 불허
        if len(df):
            frames.append(flow_frame(df, sc, _now_utc()))
        info[sc] = {"rows_new": int(len(df))}
    n = store.append(pd.concat(frames) if frames else pd.DataFrame(), BRONZE_INVESTOR_FLOW, path, ["date", "scope"])
    return {"path": str(path), "rows_total": n, "per_scope": info}


def ingest_ohlcv_unadj(codes=("005930", "000660"), start: dt.date = FLOW_START, end: dt.date | None = None,
                       path: Path = P_OHLCV_UNADJ, market_code: str = "KOSPI") -> dict:
    """비수정 OHLCV(거래대금 포함, price_adjusted=False). 시장 단위(KOSPI)는 매수 총액 = 거래대금만(OHLC None)."""
    st = _stock()
    end = end or dt.date.today()
    old = store.read(path)
    frames, info = [], {}
    for code in codes:
        s = _next_day(store.last_date(old, "date", "code", code), start)
        if s > end:
            info[code] = {"rows_new": 0, "skipped": "up-to-date"}
            continue
        df = _call(st.get_market_ohlcv, _ymd(s), _ymd(end), code, adjusted=False, what=f"ohlcv_unadj {code}")
        if store.last_date(old, "date", "code", code) is None:
            _require_rows(df, f"ohlcv_unadj {code}")
        if len(df):
            frames.append(ohlcv_frame(df, code, False, _now_utc()))
        info[code] = {"rows_new": int(len(df))}
    if market_code:
        s = _next_day(store.last_date(old, "date", "code", market_code), start)
        if s > end:
            info[market_code] = {"rows_new": 0, "skipped": "up-to-date"}
        else:
            df = _call(st.get_market_trading_value_by_date, _ymd(s), _ymd(end), market_code, on="매수", what=f"tv {market_code}")
            if store.last_date(old, "date", "code", market_code) is None:
                _require_rows(df, f"trading_value {market_code}")
            if len(df):
                f = pd.DataFrame({"date": pd.to_datetime(df.index).date, "trading_value": df["전체"].astype("float64").values})
                f["volume"] = None
                frames.append(ohlcv_frame(f.set_index("date"), market_code, False, _now_utc()))
            info[market_code] = {"rows_new": int(len(df))}
    n = store.append(pd.concat(frames) if frames else pd.DataFrame(), BRONZE_OHLCV, path, ["date", "code"])
    return {"path": str(path), "rows_total": n, "per_code": info}


def ingest_ohlcv_adj(codes=("005930", "000660"), index_code: str = KOSPI200_INDEX_CODE, index_name: str = "KOSPI200",
                     start: dt.date = PRICE_START, end: dt.date | None = None, path: Path = P_OHLCV_ADJ) -> dict:
    """수정주가 OHLCV(price_adjusted=True, trading_value None) + KOSPI200 지수(1028 → code 'KOSPI200')."""
    st = _stock()
    end = end or dt.date.today()
    old = store.read(path)
    frames, info = [], {}
    for code in codes:
        s = _next_day(store.last_date(old, "date", "code", code), start)
        if s > end:
            info[code] = {"rows_new": 0, "skipped": "up-to-date"}
            continue
        df = _call(st.get_market_ohlcv, _ymd(s), _ymd(end), code, adjusted=True, what=f"ohlcv_adj {code}")
        if store.last_date(old, "date", "code", code) is None:
            _require_rows(df, f"ohlcv_adj {code}")
        if len(df):
            frames.append(ohlcv_frame(df, code, True, _now_utc()))
        info[code] = {"rows_new": int(len(df))}
    if index_code:
        s = _next_day(store.last_date(old, "date", "code", index_name), start)
        if s > end:
            info[index_name] = {"rows_new": 0, "skipped": "up-to-date"}
        else:
            df = _call(st.get_index_ohlcv, _ymd(s), _ymd(end), index_code, what=f"index_ohlcv {index_code}")
            if store.last_date(old, "date", "code", index_name) is None:
                _require_rows(df, f"index_ohlcv {index_code}")
            if len(df):
                frames.append(ohlcv_frame(df, index_name, True, _now_utc()))
            info[index_name] = {"rows_new": int(len(df))}
    n = store.append(pd.concat(frames) if frames else pd.DataFrame(), BRONZE_OHLCV, path, ["date", "code"])
    return {"path": str(path), "rows_total": n, "per_code": info}


def trading_days(ohlcv_adj_path: Path = P_OHLCV_ADJ, code: str = "KOSPI200") -> list[dt.date]:
    """거래일 캘린더 = 적재된 KOSPI200 지수 일자 (ingest_ohlcv_adj 선행 필요)."""
    df = store.read(ohlcv_adj_path)
    if df is None or not len(df):
        raise _fail("CALENDAR_MISSING", {"path": str(ohlcv_adj_path)})
    d = sorted(set(pd.to_datetime(df.loc[df["code"] == code, "date"]).dt.date))
    if not d:
        raise _fail("CALENDAR_MISSING", {"code": code})
    return d


def month_first_trading_days(days: list[dt.date], start: dt.date = PRICE_START, end: dt.date | None = None) -> list[dt.date]:
    end = end or dt.date.today()
    seen, out = set(), []
    for d in days:
        if d < start or d > end:
            continue
        ym = (d.year, d.month)
        if ym not in seen:
            seen.add(ym)
            out.append(d)
    return out


def ingest_constituents_and_mcap(index_code: str = KOSPI200_INDEX_CODE, start: dt.date = PRICE_START, end: dt.date | None = None,
                                 path_c: Path = P_CONSTITUENTS, path_m: Path = P_MARKET_CAP, days: list[dt.date] | None = None) -> dict:
    """월초 첫 거래일 PIT 구성종목 + 같은 asof 시총 단면(KOSPI). 0행이면 재시도, 다음 거래일로 롤링(최대 5일), 그래도 0이면 loud-failure."""
    st = _stock()
    days = days or trading_days()
    asofs = month_first_trading_days(days, start, end)
    old_c, old_m = store.read(path_c), store.read(path_m)
    have_c = set(pd.to_datetime(old_c["asof"]).dt.to_period("M").astype(str)) if old_c is not None and len(old_c) else set()
    have_m = set(pd.to_datetime(old_m["asof"]).dt.to_period("M").astype(str)) if old_m is not None and len(old_m) else set()
    fc, fm, info = [], [], {"months_new": [], "rolled": {}}
    for asof in asofs:
        ym = asof.strftime("%Y-%m")
        need_c, need_m = ym not in have_c, ym not in have_m
        if not (need_c or need_m):
            continue
        d = asof
        lst: list[str] = []
        idx = days.index(asof)
        for k in range(5):
            d = days[idx + k] if idx + k < len(days) else None
            if d is None:
                break
            lst = _call(st.get_index_portfolio_deposit_file, index_code, _ymd(d), what=f"pdf {index_code} {d}") if need_c else ["_"]
            if len(lst):
                break
        if not lst or d is None:
            raise _fail("KRX_SESSION", {"what": f"constituents {index_code} {asof} (rolled 5 trading days)", "rows": 0, "session_alive": session_alive()})
        if d != asof:
            info["rolled"][ym] = [str(asof), str(d)]
        ts = _now_utc()
        if need_c:
            fc.append(pd.DataFrame({"asof": d, "index_code": index_code, "code": list(lst), "source": SOURCE, "fetch_ts": ts}))
        if need_m:
            mc = _call(st.get_market_cap, _ymd(d), market="KOSPI", what=f"mcap {d}")
            if mc is None or len(mc) == 0:
                raise _fail("KRX_SESSION", {"what": f"market_cap {d}", "rows": 0, "session_alive": session_alive()})
            m = mc.rename(columns=MCAP_COLMAP).reset_index().rename(columns={mc.index.name or "index": "code"})
            m["asof"] = d
            m["price_adjusted"] = False
            m["source"] = SOURCE
            m["fetch_ts"] = ts
            fm.append(m[[f.name for f in BRONZE_MARKET_CAP]])
        info["months_new"].append(ym)
    n_c = store.append(pd.concat(fc) if fc else pd.DataFrame(), BRONZE_CONSTITUENTS, path_c, ["asof", "index_code", "code"])
    n_m = store.append(pd.concat(fm) if fm else pd.DataFrame(), BRONZE_MARKET_CAP, path_m, ["asof", "code"])
    return {"path_constituents": str(path_c), "rows_constituents": n_c, "path_market_cap": str(path_m), "rows_market_cap": n_m,
            "months_total": len(asofs), **info}


def pit_universe(path_c: Path = P_CONSTITUENTS) -> list[str]:
    """역대 PIT 리스트의 합집합."""
    df = store.read(path_c)
    if df is None or not len(df):
        raise _fail("CONSTITUENTS_MISSING", {"path": str(path_c)})
    return sorted(set(df["code"].astype(str)))


@dataclass
class PerTickerResult:
    ok: list[str] = field(default_factory=list)
    missing: dict[str, str] = field(default_factory=dict)      # code → 사유
    rows_new: int = 0
    seconds: float = 0.0


def _per_ticker_loop(codes: list[str], fetch: Callable[[str, dt.date], pd.DataFrame], frame: Callable[[pd.DataFrame, str], pd.DataFrame],
                     old: pd.DataFrame | None, key_col: str, start: dt.date, end: dt.date, schema, path: Path, keys: list[str],
                     what: str, flush_every: int = 50) -> tuple[PerTickerResult, int]:
    """종목 루프 공통: 증분·재시도·0행 → 결측 기록(세션 사망이면 KRX_SESSION 승격)·중간 flush."""
    st = _stock()
    canary = _call(st.get_market_ohlcv, _ymd(end - dt.timedelta(days=14)), _ymd(end), "005930", adjusted=False, what="canary 005930")
    if canary is None or len(canary) == 0:
        raise _fail("KRX_SESSION", {"what": f"{what} canary", "rows": 0, "session_alive": session_alive()})
    res = PerTickerResult()
    t0 = time.time()
    buf: list[pd.DataFrame] = []
    n_total = len(old) if old is not None else 0
    for i, code in enumerate(codes):
        s = _next_day(store.last_date(old, "date", key_col, code), start)
        if s > end:
            res.ok.append(code)
            continue
        try:
            df = fetch(code, s)
        except ProcureError:
            raise
        except Exception as ex:                                # noqa: BLE001
            res.missing[code] = f"error {type(ex).__name__}: {str(ex)[:120]}"
            continue
        if df is None or len(df) == 0:
            if store.last_date(old, "date", key_col, code) is not None:
                res.ok.append(code)                            # 이미 있고 증분만 0행 (최근 상폐 등) — 결측 아님
                continue
            if not session_alive():
                raise _fail("KRX_SESSION", {"what": f"{what} {code}", "rows": 0, "session_alive": False})
            res.missing[code] = "0 rows (delisted/unavailable)"
            continue
        buf.append(frame(df, code))
        res.ok.append(code)
        res.rows_new += int(len(df))
        if len(buf) >= flush_every:
            n_total = store.append(pd.concat(buf), schema, path, keys)
            buf = []
            old = store.read(path)
    if buf:
        n_total = store.append(pd.concat(buf), schema, path, keys)
    res.seconds = round(time.time() - t0, 1)
    if len(codes) >= 20 and len(res.missing) > 0.15 * len(codes):
        raise _fail("KRX_SESSION", {"what": f"{what}: {len(res.missing)}/{len(codes)} tickers empty — session suspect", "missing": list(res.missing)[:10]})
    return res, n_total


def ingest_constituent_ohlcv_adj(codes: list[str] | None = None, start: dt.date = PRICE_START, end: dt.date | None = None,
                                 path: Path = P_OHLCV_ADJ_CONST) -> dict:
    """구성종목(역대 PIT 합집합) 수정주가 OHLCV. 조회 실패/0행 종목은 결측 목록으로 기록·저장 생략."""
    st = _stock()
    end = end or dt.date.today()
    codes = codes or pit_universe()
    old = store.read(path)
    res, n = _per_ticker_loop(
        codes, lambda c, s: _call(st.get_market_ohlcv, _ymd(s), _ymd(end), c, adjusted=True, what=f"const ohlcv_adj {c}"),
        lambda df, c: ohlcv_frame(df, c, True, _now_utc()), old, "code", start, end, BRONZE_OHLCV, path, ["date", "code"], "const_ohlcv_adj")
    return {"path": str(path), "rows_total": n, "tickers": len(codes), "ok": len(res.ok), "missing": res.missing, "rows_new": res.rows_new, "seconds": res.seconds}


def ingest_constituent_flow(codes: list[str] | None = None, start: dt.date = FLOW_START, end: dt.date | None = None,
                            path: Path = P_INVESTOR_FLOW_CONST) -> dict:
    """C-1 대사용: 구성종목별 투자자별 순매수 캐시 (scope = 종목코드)."""
    st = _stock()
    end = end or dt.date.today()
    codes = codes or pit_universe()
    old = store.read(path)
    res, n = _per_ticker_loop(
        codes, lambda c, s: _call(st.get_market_trading_value_by_date, _ymd(s), _ymd(end), c, what=f"const flow {c}"),
        lambda df, c: flow_frame(df, c, _now_utc()), old, "scope", start, end, BRONZE_INVESTOR_FLOW, path, ["date", "scope"], "const_flow")
    return {"path": str(path), "rows_total": n, "tickers": len(codes), "ok": len(res.ok), "missing": res.missing, "rows_new": res.rows_new, "seconds": res.seconds}


def summarize_parquet(path: Path, date_col: str, key_col: str) -> dict:
    df = store.read(path)
    if df is None or not len(df):
        return {"rows": 0}
    d = pd.to_datetime(df[date_col])
    return {"rows": int(len(df)), "range": [str(d.min().date()), str(d.max().date())], "keys": int(df[key_col].nunique()),
            "na_cells": int(df.drop(columns=[c for c in ("volume", "trading_value", "open", "high", "low", "close") if c in df.columns and df[c].isna().all()]).isna().sum().sum())}
