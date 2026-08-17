"""KRX 적재기 단위 테스트 (네트워크 없음 — pykrx 를 가짜 모듈로 대체).

- settings.krx_env: .env.local 에서 KRX_ID/KRX_PW 만 읽고 그 외 키는 읽지 않음, 없으면 PROCURE_FAIL:KRX_ENV
- 빈 DataFrame → PROCURE_FAIL:KRX_SESSION (조용히 0행 저장 금지)
- 3회 재시도 후 PROCURE_FAIL:KRX_API
- 증분 적재: 기존 parquet 마지막 날짜 이후만 요청
- 변환: 열 매핑·price_adjusted·source·fetch_ts, 스키마 준수 저장
- 구성종목 개별 0행 → 결측 목록 기록·저장 생략
"""
from __future__ import annotations

import datetime as dt
import types

import pandas as pd
import pyarrow.parquet as pq
import pytest

from mtpro import settings
from mtpro.ingest import krx, store
from mtpro.schema import BRONZE_INVESTOR_FLOW, BRONZE_OHLCV, BRONZE_CONSTITUENTS, BRONZE_MARKET_CAP


# ---- krx_env ---------------------------------------------------------------
def test_krx_env_reads_only_krx_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    f = tmp_path / ".env.local"
    f.write_text('KIS_APP_KEY=secret\nKRX_ID="me"\nKRX_PW=\'pw\'\nSUPABASE_KEY=x\n', encoding="utf-8")
    e = settings.krx_env(f)
    assert e == {"KRX_ID": "me", "KRX_PW": "pw"}
    assert set(e) == {"KRX_ID", "KRX_PW"}


def test_krx_env_missing_is_loud(tmp_path, monkeypatch):
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    f = tmp_path / ".env.local"
    f.write_text("KRX_ID=only\n", encoding="utf-8")
    with pytest.raises(settings.ConfigError, match="PROCURE_FAIL:KRX_ENV"):
        settings.krx_env(f)
    with pytest.raises(settings.ConfigError, match="PROCURE_FAIL:KRX_ENV"):
        settings.krx_env(tmp_path / "nope")


# ---- fake pykrx -------------------------------------------------------------
def _flow_df(dates):
    return pd.DataFrame({"기관합계": [1] * len(dates), "기타법인": [2] * len(dates), "개인": [3] * len(dates), "외국인합계": [4] * len(dates), "전체": [0] * len(dates)},
                        index=pd.DatetimeIndex(pd.to_datetime(dates), name="날짜"))


def _ohlcv_df(dates, adjusted):
    d = {"시가": [1] * len(dates), "고가": [2] * len(dates), "저가": [1] * len(dates), "종가": [2] * len(dates), "거래량": [10] * len(dates), "등락률": [0.0] * len(dates)}
    if not adjusted:
        d["거래대금"] = [100] * len(dates)
    return pd.DataFrame(d, index=pd.DatetimeIndex(pd.to_datetime(dates), name="날짜"))


class FakeStock:
    def __init__(self, days, empty_tickers=(), fail_times=0):
        self.days = [pd.Timestamp(x) for x in days]
        self.calls = []
        self.empty = set(empty_tickers)
        self.fail_times = fail_times

    def _rng(self, s, e):
        s, e = pd.Timestamp(s), pd.Timestamp(e)
        return [d for d in self.days if s <= d <= e]

    def get_market_trading_value_by_date(self, s, e, ticker, on="순매수"):
        self.calls.append(("flow", s, e, ticker, on))
        if ticker in self.empty:
            return pd.DataFrame()
        df = _flow_df(self._rng(s, e))
        if on == "매수":
            df["전체"] = 999
        return df

    def get_market_ohlcv(self, s, e, ticker, adjusted=True):
        self.calls.append(("ohlcv", s, e, ticker, adjusted))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise ConnectionError("429")
        if ticker in self.empty:
            return pd.DataFrame()
        return _ohlcv_df(self._rng(s, e), adjusted)

    def get_index_ohlcv(self, s, e, code):
        self.calls.append(("index", s, e, code))
        return _ohlcv_df(self._rng(s, e), False)

    def get_index_portfolio_deposit_file(self, code, d):
        self.calls.append(("pdf", code, d))
        if pd.Timestamp(d) not in self.days:
            return []
        return ["005930", "000660", "999999"]

    def get_market_cap(self, d, market="KOSPI"):
        self.calls.append(("mcap", d, market))
        return pd.DataFrame({"종가": [1, 2, 3], "시가총액": [10, 20, 30], "거래량": [1, 1, 1], "거래대금": [5, 5, 5], "상장주식수": [1, 1, 1]},
                            index=pd.Index(["005930", "000660", "999999"], name="티커"))


@pytest.fixture
def fake(monkeypatch, tmp_path):
    days = pd.bdate_range("2023-01-02", "2023-02-28")
    fs = FakeStock(days)
    monkeypatch.setattr(krx, "_STOCK", fs)
    monkeypatch.setattr(krx, "SLEEP_SEC", 0)
    monkeypatch.setattr(krx, "session_alive", lambda: True)
    monkeypatch.setattr(krx, "loud_failure", lambda kind, detail, **kw: {"kind": kind, "detail": detail})
    return fs, tmp_path


def test_flow_ingest_schema_and_incremental(fake):
    fs, tmp = fake
    p = tmp / "investor_flow.parquet"
    end = dt.date(2023, 1, 31)
    r = krx.ingest_investor_flow(scopes=("005930", "KOSPI"), start=dt.date(2023, 1, 3), end=end, path=p)
    t = pq.read_table(p)
    assert store.schema_matches(t.schema, BRONZE_INVESTOR_FLOW)
    df = t.to_pandas()
    assert set(df["scope"]) == {"005930", "KOSPI"} and (df["source"] == "pykrx").all() and df["krx_session"].all()
    assert (df["foreign"] == 4).all() and (df["institution"] == 1).all() and (df["other_corp"] == 2).all()
    assert df["fetch_ts"].dt.tz is not None
    n1 = r["rows_total"]
    # 증분: 2/28 까지 다시 호출하면 2/1 부터만 요청
    fs.calls.clear()
    r2 = krx.ingest_investor_flow(scopes=("005930", "KOSPI"), start=dt.date(2023, 1, 3), end=dt.date(2023, 2, 28), path=p)
    assert all(c[1] == "20230201" for c in fs.calls if c[0] == "flow")
    assert r2["rows_total"] > n1
    assert not pq.read_table(p).to_pandas().duplicated(["date", "scope"]).any()


def test_empty_frame_is_loud_session_failure(fake):
    fs, tmp = fake
    fs.empty.add("KOSPI")
    with pytest.raises(krx.ProcureError, match="PROCURE_FAIL:KRX_SESSION"):
        krx.ingest_investor_flow(scopes=("KOSPI",), end=dt.date(2023, 1, 31), path=tmp / "f.parquet")
    assert not (tmp / "f.parquet").exists()          # 0행 조용히 저장 금지


def test_retry_then_api_failure(fake, monkeypatch):
    fs, tmp = fake
    fs.fail_times = 99
    monkeypatch.setattr(krx.time, "sleep", lambda s: None)
    with pytest.raises(krx.ProcureError, match="PROCURE_FAIL:KRX_API"):
        krx.ingest_ohlcv_unadj(codes=("005930",), end=dt.date(2023, 1, 31), path=tmp / "u.parquet", market_code="")
    assert sum(1 for c in fs.calls if c[0] == "ohlcv") == krx.RETRIES


def test_ohlcv_unadj_and_adj_flags(fake):
    fs, tmp = fake
    end = dt.date(2023, 1, 31)
    krx.ingest_ohlcv_unadj(codes=("005930",), end=end, path=tmp / "u.parquet")
    u = pq.read_table(tmp / "u.parquet")
    assert store.schema_matches(u.schema, BRONZE_OHLCV)
    ud = u.to_pandas()
    assert (~ud["price_adjusted"]).all()
    k = ud[ud["code"] == "KOSPI"]
    assert (k["trading_value"] == 999).all() and k["close"].isna().all()
    assert (ud.loc[ud["code"] == "005930", "trading_value"] == 100).all()
    krx.ingest_ohlcv_adj(codes=("005930",), end=end, path=tmp / "a.parquet")
    ad = pq.read_table(tmp / "a.parquet").to_pandas()
    assert ad["price_adjusted"].all() and ad["trading_value"].isna().all()
    assert set(ad["code"]) == {"005930", "KOSPI200"}


def test_constituents_mcap_monthly_and_rolling(fake):
    fs, tmp = fake
    krx.ingest_ohlcv_adj(codes=(), end=dt.date(2023, 2, 28), path=tmp / "a.parquet")
    days = krx.trading_days(tmp / "a.parquet")
    assert days[0] == dt.date(2023, 1, 2)
    r = krx.ingest_constituents_and_mcap(end=dt.date(2023, 2, 28), path_c=tmp / "c.parquet", path_m=tmp / "m.parquet", days=days)
    c = pq.read_table(tmp / "c.parquet")
    assert store.schema_matches(c.schema, BRONZE_CONSTITUENTS)
    cd = c.to_pandas()
    assert sorted(set(pd.to_datetime(cd["asof"]).dt.date)) == [dt.date(2023, 1, 2), dt.date(2023, 2, 1)]
    m = pq.read_table(tmp / "m.parquet")
    assert store.schema_matches(m.schema, BRONZE_MARKET_CAP)
    assert (~m.to_pandas()["price_adjusted"]).all()
    assert r["months_total"] == 2
    # 재실행 시 이미 있는 달은 건너뜀
    fs.calls.clear()
    krx.ingest_constituents_and_mcap(end=dt.date(2023, 2, 28), path_c=tmp / "c.parquet", path_m=tmp / "m.parquet", days=days)
    assert not [x for x in fs.calls if x[0] in ("pdf", "mcap")]


def test_constituent_loop_records_missing_and_skips(fake):
    fs, tmp = fake
    fs.empty.add("999999")
    r = krx.ingest_constituent_ohlcv_adj(codes=["005930", "000660", "999999"], end=dt.date(2023, 1, 31), path=tmp / "co.parquet")
    assert r["ok"] == 2 and list(r["missing"]) == ["999999"]
    df = pq.read_table(tmp / "co.parquet").to_pandas()
    assert set(df["code"]) == {"005930", "000660"} and df["price_adjusted"].all()
    r2 = krx.ingest_constituent_flow(codes=["005930", "999999"], end=dt.date(2023, 1, 31), path=tmp / "cf.parquet")
    assert r2["ok"] == 1 and "999999" in r2["missing"]


def test_constituent_loop_dead_session_escalates(fake, monkeypatch):
    fs, tmp = fake
    fs.empty.add("000660")
    monkeypatch.setattr(krx, "session_alive", lambda: False)
    with pytest.raises(krx.ProcureError, match="KRX_SESSION"):
        krx.ingest_constituent_ohlcv_adj(codes=["005930", "000660"], end=dt.date(2023, 1, 31), path=tmp / "co.parquet")


def test_store_append_dedupes_keeps_latest(tmp_path):
    p = tmp_path / "x.parquet"
    a = pd.DataFrame({"date": [dt.date(2023, 1, 2)], "scope": ["A"], "foreign": [1.0], "unit": ["KRW"], "source": ["t"], "fetch_ts": [pd.Timestamp("2023-01-01", tz="UTC")], "krx_session": [True]})
    store.append(a, BRONZE_INVESTOR_FLOW, p, ["date", "scope"])
    b = a.copy()
    b["foreign"] = 5.0
    n = store.append(b, BRONZE_INVESTOR_FLOW, p, ["date", "scope"])
    df = store.read(p)
    assert n == 1 and df["foreign"].iloc[0] == 5.0 and pd.isna(df["institution"].iloc[0])
