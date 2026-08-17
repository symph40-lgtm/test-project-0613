"""T3-C 등급C 부품 0~2 (components/gradec.py + ingest/sox.py) 테스트.

- 시차·휴장 정렬: d < t 엄격(t일 미국 세션 미사용), reused/stale/missing 상태
- 룩어헤드 assert: 미래 행(SOX·OHLCV) 변경 → 과거 패널 불변; t일 SOX 세션 변경 → t일 값 불변
- 재료 없는 날(|justified| < 0.3%) → ERR None 제외
- 표본 부족 None(β<40, asymmetry<2, good/bad beta<3), 0 대체 없음
- |ERR_z|<5 비율 리포트(summarize) 산출
- SOX bronze 정규화(열·tz·ret_pct)와 loud-failure
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from mtpro.components import gradec as gc
from mtpro.ingest import sox as soxmod


# ---------------------------------------------------------------------------
# 합성 데이터
# ---------------------------------------------------------------------------

def _bdays(start: date, n: int) -> list[date]:
    return [d.date() for d in pd.bdate_range(start, periods=n)]


def _sox_frame(days: list[date], rets: np.ndarray) -> pd.DataFrame:
    return pd.DataFrame({"date": days, "ret_pct": rets, "close": 100.0 + np.cumsum(rets), "source": "syn",
                         "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})


def _ohlcv_frame(days: list[date], code: str, ret_pct: np.ndarray, gap_pct: np.ndarray | None = None) -> pd.DataFrame:
    """open→close = ret_pct, 전일 종가→시가 = gap_pct."""
    n = len(days)
    gap = np.zeros(n) if gap_pct is None else gap_pct
    close_prev = 100.0
    rows = []
    for i in range(n):
        o = close_prev * (1 + gap[i] / 100.0)
        c = o * (1 + ret_pct[i] / 100.0)
        rows.append({"date": days[i], "code": code, "open": o, "high": max(o, c), "low": min(o, c), "close": c,
                     "volume": 1.0, "trading_value": None, "price_adjusted": True, "source": "syn",
                     "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
        close_prev = c
    return pd.DataFrame(rows)


def make_world(n: int = 260, beta_true: float = 1.2, seed: int = 7, scopes=("KOSPI200", "005930", "000660")):
    """미국 세션 d 와 국내 거래일 t 가 같은 평일 달력. 국내 t 반응 = beta·SOX(t-1) + 잡음."""
    rng = np.random.default_rng(seed)
    days = _bdays(date(2023, 1, 2), n + 1)
    sox_ret = rng.normal(0, 1.5, n + 1)
    sox = _sox_frame(days, sox_ret)
    frames = []
    for k, sc in enumerate(scopes):
        prev = np.r_[np.nan, sox_ret[:-1]]              # 국내 t 는 미국 t-1 세션에 반응
        react = beta_true * np.nan_to_num(prev) + rng.normal(0, 1.0, n + 1) + 0.1 * k
        frames.append(_ohlcv_frame(days, sc, react, gap_pct=rng.normal(0, 0.5, n + 1)))
    return sox, pd.concat(frames, ignore_index=True), days


P = gc.GradeCParams()


# ---------------------------------------------------------------------------
# 정렬 규칙
# ---------------------------------------------------------------------------

def test_align_strictly_previous_session_never_same_day():
    """국내 t 에는 d < t 인 최신 세션만. d = t(그날 밤 미국장)는 절대 사용하지 않는다."""
    days = _bdays(date(2024, 1, 1), 10)
    sox = _sox_frame(days, np.arange(10, dtype=float))          # ret(d_i) = i
    al = gc.align_prev_us_session(days, sox)
    for i in range(1, 10):
        assert al.loc[i, "sox_session_date"] == days[i - 1]
        assert al.loc[i, "sox_ret_prev"] == float(i - 1)
        assert al.loc[i, "sox_ret_prev"] != float(i)             # t일 세션값 아님
        assert al.loc[i, "sox_align_status"] == "ok"
    assert al.loc[0, "sox_align_status"] == "missing" and pd.isna(al.loc[0, "sox_ret_prev"])


def test_align_monday_uses_friday_and_krx_holiday_skips_session():
    """월요일 → 금요일 세션. KRX 휴장(미국 개장)으로 건너뛴 세션은 측정하지 않고, 다음 국내 거래일은 '가장 최근' 세션 하나만."""
    us = _bdays(date(2024, 3, 4), 10)                            # 3/4(월)~3/15(금)
    sox = _sox_frame(us, np.arange(10, dtype=float))
    dom = [d for d in us if d != date(2024, 3, 7)]               # 국내 3/7(목) 휴장
    al = gc.align_prev_us_session(dom, sox).set_index("date")
    assert al.loc[date(2024, 3, 11), "sox_session_date"] == date(2024, 3, 8)      # 월 → 금
    assert al.loc[date(2024, 3, 8), "sox_session_date"] == date(2024, 3, 7)       # 금 → 목(미국 개장) 하나만
    assert al.loc[date(2024, 3, 8), "sox_align_status"] == "ok"
    assert date(2024, 3, 6) not in set(al["sox_session_date"].dropna())          # 3/6 세션은 건너뜀(측정 안 함)


def test_align_us_holiday_marks_reused_none():
    """미국 휴장(국내 개장): 직전 국내 거래일이 이미 쓴 세션 → reused → None (같은 재료 중복 사용 금지)."""
    us = [d for d in _bdays(date(2024, 7, 1), 10) if d != date(2024, 7, 4)]     # 7/4 미국 휴장
    sox = _sox_frame(us, np.ones(len(us)))
    dom = _bdays(date(2024, 7, 1), 10)                                          # 국내는 전부 개장
    al = gc.align_prev_us_session(dom, sox).set_index("date")
    assert al.loc[date(2024, 7, 4), "sox_session_date"] == date(2024, 7, 3) and al.loc[date(2024, 7, 4), "sox_align_status"] == "ok"
    assert al.loc[date(2024, 7, 5), "sox_session_date"] == date(2024, 7, 3)
    assert al.loc[date(2024, 7, 5), "sox_align_status"] == "reused"
    assert pd.isna(al.loc[date(2024, 7, 5), "sox_ret_prev"])
    assert al.loc[date(2024, 7, 8), "sox_session_date"] == date(2024, 7, 5) and al.loc[date(2024, 7, 8), "sox_align_status"] == "ok"


def test_align_stale_gap_is_none():
    us = _bdays(date(2024, 1, 1), 5)                             # 1/1~1/5 만 존재
    sox = _sox_frame(us, np.ones(5))
    dom = [date(2024, 1, 8), date(2024, 1, 15)]
    al = gc.align_prev_us_session(dom, sox, max_stale_calendar_days=7).set_index("date")
    assert al.loc[date(2024, 1, 8), "sox_align_status"] == "ok"                 # 3일
    assert al.loc[date(2024, 1, 15), "sox_align_status"] == "stale"             # 10일 > 7
    assert pd.isna(al.loc[date(2024, 1, 15), "sox_ret_prev"])


def test_align_rejects_unsorted():
    sox = _sox_frame(_bdays(date(2024, 1, 1), 3), np.ones(3))
    with pytest.raises(ValueError):
        gc.align_prev_us_session([date(2024, 1, 3), date(2024, 1, 2)], sox)


# ---------------------------------------------------------------------------
# 반응 기준·룩어헤드
# ---------------------------------------------------------------------------

def test_reactions_basis_and_c2_assert():
    days = _bdays(date(2024, 1, 1), 5)
    o = _ohlcv_frame(days, "005930", np.array([1.0, -2.0, 0.5, 0.0, 3.0]), gap_pct=np.array([0.0, 1.0, 1.0, 1.0, 1.0]))
    r = gc.reactions_from_ohlcv(o, "005930", "open_to_close").set_index("date")["actual_ret"]
    assert r[days[1]] == pytest.approx(-2.0)
    c2c = gc.reactions_from_ohlcv(o, "005930", "close_to_close").set_index("date")["actual_ret"]
    assert pd.isna(c2c[days[0]])
    assert c2c[days[1]] == pytest.approx((1.01 * 0.98 - 1) * 100)
    o2 = o.copy(); o2.loc[o2.index[2], "price_adjusted"] = False
    with pytest.raises(AssertionError, match="C-2"):
        gc.reactions_from_ohlcv(o2, "005930", "open_to_close")


def _panel(sox, ohlcv, params=P):
    return gc.build_panel(ohlcv, sox, params, scopes=("005930",)).reset_index(drop=True)


def _same_prefix(a: pd.DataFrame, b: pd.DataFrame, upto: int) -> None:
    pd.testing.assert_frame_equal(a.iloc[:upto].reset_index(drop=True), b.iloc[:upto].reset_index(drop=True), check_dtype=False)


def test_lookahead_future_ohlcv_change_leaves_past_unchanged():
    sox, ohlcv, days = make_world(n=200)
    base = _panel(sox, ohlcv)
    cut = 150
    mod = ohlcv.copy()
    m = (mod["code"] == "005930") & (pd.to_datetime(mod["date"]).dt.date > days[cut])
    mod.loc[m, "close"] = mod.loc[m, "close"] * 1.5
    mod.loc[m, "open"] = mod.loc[m, "open"] * 0.9
    after = _panel(sox, mod)
    _same_prefix(base, after, cut + 1)                                     # t ≤ cut 행 전부 불변
    assert not base.iloc[cut + 1:]["actual_ret"].equals(after.iloc[cut + 1:]["actual_ret"])   # 미래는 실제로 바뀜


def test_lookahead_sox_same_day_and_future_change_leaves_row_t_unchanged():
    """t일 이후(t 포함) 미국 세션 값을 바꿔도 t일 패널 행은 불변 — 정렬이 t일 세션을 쓰지 않는다는 증명."""
    sox, ohlcv, days = make_world(n=200)
    base = _panel(sox, ohlcv)
    t_idx = 120
    mod = sox.copy()
    m = pd.to_datetime(mod["date"]).dt.date >= days[t_idx]                  # d ≥ t (t일 세션 포함) 변경
    mod.loc[m, "ret_pct"] = mod.loc[m, "ret_pct"] + 5.0
    after = _panel(mod, ohlcv)
    _same_prefix(base, after, t_idx + 1)                                    # t 행까지 불변
    assert after.loc[t_idx + 1, "sox_ret_prev"] == pytest.approx(base.loc[t_idx + 1, "sox_ret_prev"] + 5.0)   # t+1 부터 반영


def test_no_material_days_excluded_from_err():
    sox, ohlcv, days = make_world(n=200)
    p = _panel(sox, ohlcv)
    defined = p[p["justified_pct"].notna()]
    assert len(defined) > 50
    nm = defined[defined["no_material_flag"] == True]  # noqa: E712
    assert len(nm) > 0, "합성 세계에 |justified|<0.3% 인 날이 있어야 한다"
    assert (nm["justified_pct"].abs() < P.min_justified_abs_pct).all()
    assert nm["err_pct"].isna().all() and nm["err_z"].isna().all()
    mat = defined[defined["no_material_flag"] == False]  # noqa: E712
    assert mat["err_pct"].notna().all()
    # err_pct = actual − justified (0 대체 없음)
    assert np.allclose(mat["err_pct"].astype(float), mat["actual_ret"].astype(float) - mat["justified_pct"].astype(float))


def test_beta_none_before_min_samples_and_recovers_true_beta():
    sox, ohlcv, days = make_world(n=200, beta_true=1.2)
    p = _panel(sox, ohlcv)
    # 첫 행 x None → 첫 40 유효 표본 전까지 β None
    first_beta = p["beta_sox"].first_valid_index()
    assert first_beta is not None and first_beta >= P.beta_min_samples
    assert p.loc[:first_beta - 1, "beta_sox"].isna().all()
    late = p["beta_sox_raw"].dropna().iloc[-50:]
    assert 0.9 < late.mean() < 1.5                                          # 참 β 1.2 근방
    assert (p["beta_sox"].dropna() >= 0.3).all() and (p["beta_sox"].dropna() <= 3.0).all()


def test_beta_clip_bounds():
    """음의 β 도 0.3 으로 절단된다(발주 사양 [0.3, 3.0])."""
    sox, ohlcv, days = make_world(n=150, beta_true=-1.0, seed=3)
    p = _panel(sox, ohlcv)
    raw = p["beta_sox_raw"].dropna()
    assert (raw < 0).mean() > 0.8
    assert (p["beta_sox"].dropna() == 0.3).all()


def test_asymmetry_and_gb_beta_none_when_insufficient():
    """모든 SOX 수익률이 양수 → bad 표본 0 → bad_resilience_z None(0.0 아님), bad_beta None."""
    n = 150
    days = _bdays(date(2023, 1, 2), n + 1)
    rng = np.random.default_rng(1)
    sox_ret = np.abs(rng.normal(0, 1.5, n + 1)) + 0.5
    sox = _sox_frame(days, sox_ret)
    prev = np.r_[np.nan, sox_ret[:-1]]
    ohlcv = _ohlcv_frame(days, "005930", 1.0 * np.nan_to_num(prev) + rng.normal(0, 0.8, n + 1))
    p = _panel(sox, ohlcv)
    assert p["bad_resilience_z"].isna().all()
    assert (p["bad_n"] == 0).all()
    assert p["bad_beta"].isna().all()
    tail = p.iloc[-30:]
    assert tail["good_acceptance_z"].notna().all()
    assert (tail["good_n"] >= P.asym_min_n).all()
    assert tail["good_beta"].notna().all()
    assert (tail["good_beta"] >= 0.3).all() and (tail["good_beta"] <= 2.0).all()


def test_expected_std_uses_only_past_residuals():
    """expected_std 는 t 이전 재료일 잔차만: t 의 err_pct 를 크게 바꿔도 t 의 expected_std 불변, t+1 이후만 변한다."""
    sox, ohlcv, days = make_world(n=220)
    base = _panel(sox, ohlcv)
    t = 180
    while base.loc[t, "err_pct"] is None or pd.isna(base.loc[t, "err_pct"]):
        t += 1
    mod = ohlcv.copy()
    m = (mod["code"] == "005930") & (pd.to_datetime(mod["date"]).dt.date == days[t])
    mod.loc[m, "close"] = mod.loc[m, "open"] * 1.30                             # t 반응 +30%
    after = _panel(sox, mod)
    assert after.loc[t, "expected_std"] == pytest.approx(base.loc[t, "expected_std"])
    assert after.loc[t + 1, "expected_std"] > base.loc[t + 1, "expected_std"]


def test_output_schema_and_no_zero_fill(tmp_path):
    sox, ohlcv, days = make_world(n=120)
    p = gc.build_panel(ohlcv, sox, P)
    assert set(p["scope"]) == set(gc.SCOPES)
    assert (p["grade"] == "C").all() and (p["t0_mode"] == "A1_open").all() and (p["engine_ver"] == gc.ENGINE_VER).all()
    required = ["date", "scope", "sox_ret_prev", "beta_sox", "justified_pct", "expected_std", "actual_ret", "err_pct", "err_z",
                "no_material_flag", "good_acceptance_z", "bad_resilience_z", "good_n", "bad_n", "good_beta", "bad_beta",
                "grade", "t0_mode", "engine_ver"]
    assert all(c in p.columns for c in required)
    # 초반 β 미정 구간: justified/err 가 0 이 아니라 None
    head = p[p["scope"] == "005930"].iloc[:P.beta_min_samples]
    assert head["justified_pct"].isna().all() and head["err_z"].isna().all()
    path = gc.write_gold(p, tmp_path / "gradec_panel.parquet")
    back = gc.read_gold(path)
    assert len(back) == len(p)
    assert back["justified_pct"].isna().sum() == p["justified_pct"].isna().sum()   # None 이 0 으로 바뀌지 않음
    assert (back["justified_pct"].fillna(1.0) != 0).all() or (p["justified_pct"].dropna() == 0).any()


def test_summarize_reports_err_z_lt5_ratio():
    sox, ohlcv, days = make_world(n=260)
    p = gc.build_panel(ohlcv, sox, P)
    s = gc.summarize(p, P)
    for sc in gc.SCOPES:
        r = s[sc]
        assert r["rows"] == 261
        assert r["err_z_defined"] > 50
        assert 0.9 <= r["abs_err_z_lt5_ratio"] <= 1.0
        assert 0.0 <= r["no_material_ratio_of_defined"] < 0.5
        assert r["good_reached_ratio"] > 0.5 and r["bad_reached_ratio"] > 0.5
        assert r["err_z_std"] is not None and 0.5 < r["err_z_std"] < 1.6


def test_load_params_reads_config():
    p = gc.load_params()
    assert p.beta_window_days == 60 and p.min_justified_abs_pct == 0.3 and p.err_z_window_days == 120
    q = gc.load_params(reaction_basis="close_to_close")
    assert q.reaction_basis == "close_to_close"
    with pytest.raises(ValueError):
        gc.GradeCParams(reaction_basis="foo")


# ---------------------------------------------------------------------------
# SOX bronze
# ---------------------------------------------------------------------------

def test_sox_normalize_multiindex_tz_and_ret(tmp_path):
    idx = pd.DatetimeIndex(pd.date_range("2024-01-02", periods=4, freq="B"), tz="America/New_York")
    cols = pd.MultiIndex.from_product([["Close", "Open"], ["^SOX"]])
    raw = pd.DataFrame([[100, 99], [102, 100], [101, 102], [104, 101]], index=idx, columns=cols, dtype=float)
    df = soxmod.normalize_history(raw, fetch_ts=datetime(2026, 8, 17, 1, 2, 3, 456, tzinfo=timezone.utc))
    assert list(df["date"]) == [date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4), date(2024, 1, 5)]
    assert pd.isna(df["ret_pct"].iloc[0])
    assert df["ret_pct"].iloc[1] == pytest.approx(2.0)
    path = soxmod.write_bronze(df, tmp_path / "sox.parquet")
    back = soxmod.read_bronze(path)
    assert len(back) == 4 and pd.isna(back["ret_pct"].iloc[0]) and back["source"].iloc[0] == soxmod.SOURCE


def test_sox_ingest_loud_failure_on_empty(tmp_path, monkeypatch):
    from mtpro import alerts
    calls = []
    monkeypatch.setattr(soxmod, "_download", lambda s, e: pd.DataFrame())
    monkeypatch.setattr(alerts, "loud_failure", lambda kind, detail, **kw: calls.append((kind, detail)) or {})
    with pytest.raises(soxmod.SoxIngestError):
        soxmod.ingest(path=tmp_path / "sox.parquet")
    assert calls and calls[0][0] == "COLLECT_FAIL" and calls[0][1]["component"] == "ingest.sox"
    assert not (tmp_path / "sox.parquet").exists()
