"""T5-2 부품 10 Semi Transmission (components/transmission.py, ingest/us_daily.py) 테스트.

- 회귀 설계행렬 = [z_SOXX, resid_NVDA, resid_MU, resid_TSM] (방법 A). raw 4변수 동시 OLS 와 다름을 수치로 확인
- 참 계수 회복(β_SOXX·β_resid), 비대칭 β_up−β_down 회복
- 표본 규칙: z<60 None, 직교화<60 None, β<40 None, 비대칭<25 None, asym z / change20 z <60 None, 클립 ±3
- 정렬: 자산별 d ≤ t−1 엄격, 미국 휴장 reused → None (그날 z·resid None)
- 룩어헤드 assert: 미래 US 변조(d ≥ t) → t행 불변 / 미래 OHLCV 변조 → 과거 불변
- 상수 = config transmission.constants, 스키마 write/read, role(component/diagnostic)
- us_daily 정규화·loud-failure(부분 적재 없음)
"""
from __future__ import annotations

import pathlib
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd
import pytest
import yaml

from mtpro.components import transmission as T
from mtpro.components.gradec import ols_slope
from mtpro.ingest import us_daily as U

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
P = T.TransmissionParams()


def _bdays(start: date, n: int) -> list[date]:
    return [d.date() for d in pd.bdate_range(start, periods=n)]


def _us_frame(days, rets: dict) -> pd.DataFrame:
    parts = []
    for tk, r in rets.items():
        parts.append(pd.DataFrame({"date": days, "ticker": tk, "close": 100.0 + np.cumsum(r), "ret_pct": r, "source": "syn",
                                   "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")}))
    return pd.concat(parts, ignore_index=True)


def _ohlcv_c2c(days, code, ret_pct):
    rows, prev = [], 100.0
    for d, r in zip(days, ret_pct):
        c = prev * (1 + r / 100)
        rows.append({"date": d, "code": code, "open": prev, "high": max(prev, c), "low": min(prev, c), "close": c, "volume": 1.0,
                     "trading_value": None, "price_adjusted": True, "source": "syn", "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
        prev = c
    return pd.DataFrame(rows)


def make_world(n=420, seed=11, b_soxx=1.0, b_nvda=0.5, b_mu=0.0, b_tsm=0.0, asym=0.0, noise=0.5, scopes=("005930",)):
    """미국 세션 d 와 국내 t 가 같은 평일 달력. NVDA/MU/TSM 는 SOXX 와 상관(공통 요인) + 고유 충격.
    국내 t 의 close→close 수익률(%) = b_soxx·z_SOXX + b_j·resid_j 형태를 (원시 스케일로) 흉내: 표준화 전 원시 수익률로 생성하되
    회귀 대상은 z 이므로 계수는 스케일 차이만큼 달라진다 → 테스트는 부호·상대 크기·설계행렬 일치를 본다."""
    rng = np.random.default_rng(seed)
    days = _bdays(date(2023, 1, 2), n + 1)
    soxx = rng.normal(0, 1.5, n + 1)
    idio = {k: rng.normal(0, 1.0, n + 1) for k in ("NVDA", "MU", "TSM")}
    us = {"SOXX": soxx, "NVDA": 0.8 * soxx + idio["NVDA"], "MU": 0.7 * soxx + idio["MU"], "TSM": 0.6 * soxx + idio["TSM"]}
    prev = {k: np.r_[np.nan, v[:-1]] for k, v in us.items()}       # 국내 t 는 미국 t−1 세션에 반응
    frames = []
    for sc in scopes:
        s = np.nan_to_num(prev["SOXX"])
        r = b_soxx * s + asym * np.where(s > 0, s, 0.0)
        r = r + b_nvda * np.nan_to_num(np.r_[np.nan, idio["NVDA"][:-1]]) + b_mu * np.nan_to_num(np.r_[np.nan, idio["MU"][:-1]]) \
            + b_tsm * np.nan_to_num(np.r_[np.nan, idio["TSM"][:-1]]) + rng.normal(0, noise, n + 1)
        frames.append(_ohlcv_c2c(days, sc, r))
    return _us_frame(days, us), pd.concat(frames, ignore_index=True), days


def _panel(us, ohlcv, params=P, scopes=("005930",)):
    return T.build_panel(ohlcv, us, params, scopes=scopes).reset_index(drop=True)


def _same_prefix(a, b, upto):
    pd.testing.assert_frame_equal(a.iloc[:upto].reset_index(drop=True), b.iloc[:upto].reset_index(drop=True), check_dtype=False)


# ---------------------------------------------------------------------------
# 방법 A 설계행렬
# ---------------------------------------------------------------------------

def test_design_matrix_is_soxx_plus_residuals_not_raw_four():
    """회귀 설계행렬 = [z_SOXX, resid×3]. 패널의 β 를 수동 재계산으로 대조하고, raw 4변수 동시 OLS 의 SOXX 계수와 **다름**을 확인."""
    assert T.DESIGN_COLUMNS == ("z_soxx", "resid_nvda", "resid_mu", "resid_tsm")
    assert tuple(CFG["transmission"]["design_columns"]) == T.DESIGN_COLUMNS and CFG["transmission"]["method"] == T.METHOD == "A"
    us, ohlcv, days = make_world(n=400, b_soxx=1.0, b_nvda=0.6)
    p = _panel(us, ohlcv)
    i = len(p) - 1
    w = p.iloc[i - P.beta_window_days + 1:i + 1]
    m = w[["r_close", *T.DESIGN_COLUMNS]].dropna()
    assert len(m) >= P.beta_min_samples and int(p.loc[i, "beta_n"]) == len(m)
    X = np.column_stack([np.ones(len(m)), m[list(T.DESIGN_COLUMNS)].to_numpy(float)])
    coef = np.linalg.lstsq(X, m["r_close"].to_numpy(float), rcond=None)[0]
    assert p.loc[i, "beta_soxx"] == pytest.approx(coef[1])
    assert p.loc[i, "beta_resid_nvda"] == pytest.approx(coef[2])
    assert p.loc[i, "beta_resid_mu"] == pytest.approx(coef[3]) and p.loc[i, "beta_resid_tsm"] == pytest.approx(coef[4])
    # raw 4변수(z_soxx, z_nvda, z_mu, z_tsm) 동시 OLS 의 SOXX 계수는 다르다 (금지된 설계)
    raw = w[["r_close", "z_soxx", "z_nvda", "z_mu", "z_tsm"]].dropna()
    Xr = np.column_stack([np.ones(len(raw)), raw[["z_soxx", "z_nvda", "z_mu", "z_tsm"]].to_numpy(float)])
    cr = np.linalg.lstsq(Xr, raw["r_close"].to_numpy(float), rcond=None)[0]
    assert abs(cr[1] - coef[1]) > 0.05
    # 직교화: resid_j = z_j − b_j·z_soxx, b_j = 과거 120행(t 미포함) OLS 기울기
    j0 = max(0, i - P.orth_window_days)
    past = p.iloc[j0:i][["z_nvda", "z_soxx"]].dropna()
    b = ols_slope(past["z_soxx"], past["z_nvda"])
    assert p.loc[i, "b_nvda"] == pytest.approx(b)
    assert p.loc[i, "resid_nvda"] == pytest.approx(p.loc[i, "z_nvda"] - b * p.loc[i, "z_soxx"])


def test_recovers_true_coefficients_sign_and_relative_size():
    us, ohlcv, days = make_world(n=420, b_soxx=1.0, b_nvda=0.6, b_mu=0.0, b_tsm=0.0, noise=0.3)
    p = _panel(us, ohlcv)
    late = p.dropna(subset=["beta_soxx"]).iloc[-100:]
    assert late["beta_soxx"].mean() > 1.0                          # z_SOXX 는 원시(σ≈1.5)를 표준화 → 계수 ≈ 1.5
    assert late["beta_resid_nvda"].mean() > 0.3
    assert abs(late["beta_resid_mu"].mean()) < 0.2 and abs(late["beta_resid_tsm"].mean()) < 0.2


def test_asymmetry_beta_up_minus_beta_down():
    us, ohlcv, days = make_world(n=420, b_soxx=0.5, asym=1.0, noise=0.2)   # 양의 충격에만 +1.0 추가 → β_up − β_down ≈ 1.5(z 스케일)
    p = _panel(us, ohlcv)
    late = p.dropna(subset=["transmission_asym"]).iloc[-100:]
    assert late["beta_up"].mean() > late["beta_down"].mean()
    assert late["transmission_asym"].mean() > 0.8
    assert np.allclose(late["transmission_asym"], late["beta_up"] - late["beta_down"])
    assert ((p["n_up"] >= P.asym_min_samples) | p["beta_up"].isna()).all()
    assert ((p["n_down"] >= P.asym_min_samples) | p["beta_down"].isna()).all()
    # 표본 25 미만 → None (창 첫 행들 또는 부호 편중)
    few = p[(p["beta_n"] >= P.beta_min_samples) & (p["n_up"] < P.asym_min_samples)]
    assert few["beta_up"].isna().all()


# ---------------------------------------------------------------------------
# 표본 규칙 · 과거 전용
# ---------------------------------------------------------------------------

def test_sample_rules_none_before_thresholds_and_clip():
    us, ohlcv, days = make_world(n=420)
    p = _panel(us, ohlcv)
    fz = p["z_soxx"].first_valid_index()
    assert fz is not None and fz >= P.z_min_samples and p.loc[:fz - 1, ["z_soxx", "z_nvda", "z_mu", "z_tsm"]].isna().all().all()
    fb = p["b_nvda"].first_valid_index()
    assert fb is not None and fb >= fz + P.orth_min_samples and p.loc[:fb - 1, "resid_nvda"].isna().all()
    fbeta = p["beta_soxx"].first_valid_index()
    assert fbeta is not None and fbeta >= fb + P.beta_min_samples - 1 and p.loc[:fbeta - 1, "beta_soxx"].isna().all()
    assert (p.loc[p["beta_soxx"].isna(), "beta_n"] < P.beta_min_samples).all()
    fa = p["transmission_asym_z"].first_valid_index()
    assert fa is not None
    assert int(p.loc[max(0, fa - P.z_window_days):fa - 1, "transmission_asym"].notna().sum()) >= P.z_min_samples
    fc = p["beta_change20_z_soxx"].first_valid_index()
    assert fc is not None and fc >= fbeta + P.change_days + P.change_z_min_samples
    for c in ("z_soxx", "z_nvda", "z_mu", "z_tsm", "transmission_asym_z", "beta_change20_z_soxx", "beta_change20_z_nvda"):
        assert p[c].abs().max() <= P.z_clip_abs
    # change20 수동 대조: Δβ(t) = β(t) − β(t−20) 을 t−1까지 120행 Δβ 분포로 z
    i = len(p) - 1
    beta = p["beta_soxx"].tolist()
    d20 = [None] * len(p)
    for k in range(P.change_days, len(p)):
        if beta[k] is not None and not pd.isna(beta[k]) and beta[k - P.change_days] is not None and not pd.isna(beta[k - P.change_days]):
            d20[k] = beta[k] - beta[k - P.change_days]
    past = pd.Series([v for v in d20[max(0, i - P.change_z_window_days):i] if v is not None])
    z = (d20[i] - past.mean()) / past.std(ddof=1)
    assert p.loc[i, "beta_change20_z_soxx"] == pytest.approx(float(np.clip(z, -3, 3)))


def test_z_and_orth_use_past_only_row_t_excluded():
    us, ohlcv, days = make_world(n=400)
    base = _panel(us, ohlcv)
    t = 300
    # 행 t 의 US 정렬값(=세션 t−1)만 바꾸면 z_j(t) 는 바뀌되 z 의 참조 분포·b_j(t) 는 불변 (t 미포함)
    mod = us.copy()
    m = (mod["ticker"] == "NVDA") & (pd.to_datetime(mod["date"]).dt.date == days[t - 1])
    mod.loc[m, "ret_pct"] = mod.loc[m, "ret_pct"] + 6.0
    after = _panel(mod, ohlcv)
    assert after.loc[t, "b_nvda"] == pytest.approx(base.loc[t, "b_nvda"])
    assert after.loc[t, "z_nvda"] != pytest.approx(base.loc[t, "z_nvda"])
    _same_prefix(base, after, t)                                     # t−1 까지 전부 불변


# ---------------------------------------------------------------------------
# 정렬·룩어헤드
# ---------------------------------------------------------------------------

def test_us_holiday_reused_none_per_asset():
    us, ohlcv, days = make_world(n=300)
    hol = days[200]
    us2 = us[~((us["ticker"] == "MU") & (us["date"] == hol))]         # MU 만 휴장(합성) → 국내 days[201] MU 는 reused
    p = _panel(us2, ohlcv).set_index("date")
    assert p.loc[days[201], "align_status_mu"] == "reused" and pd.isna(p.loc[days[201], "x_mu"]) and pd.isna(p.loc[days[201], "z_mu"])
    assert pd.isna(p.loc[days[201], "resid_mu"])
    assert p.loc[days[201], "align_status_soxx"] == "ok" and pd.notna(p.loc[days[201], "z_soxx"])
    # 세션 날짜는 t−1 (d ≤ t−1 엄격)
    assert p.loc[days[201], "session_date_soxx"] == days[200] and p.loc[days[201], "session_date_mu"] == days[199]


def test_lookahead_future_us_change_leaves_row_t_unchanged():
    us, ohlcv, days = make_world(n=400)
    base = _panel(us, ohlcv)
    t = 320
    mod = us.copy()
    m = pd.to_datetime(mod["date"]).dt.date >= days[t]                 # d ≥ t (t일 밤 세션 포함) 변조, 4자산 전부
    mod.loc[m, "ret_pct"] = mod.loc[m, "ret_pct"] + 5.0
    after = _panel(mod, ohlcv)
    _same_prefix(base, after, t + 1)
    assert after.loc[t + 1, "x_soxx"] == pytest.approx(base.loc[t + 1, "x_soxx"] + 5.0)


def test_lookahead_future_ohlcv_change_leaves_past_unchanged():
    us, ohlcv, days = make_world(n=400)
    base = _panel(us, ohlcv)
    cut = 330
    mod = ohlcv.copy()
    m = pd.to_datetime(mod["date"]).dt.date > days[cut]
    mod.loc[m, "close"] = mod.loc[m, "close"] * 1.4
    after = _panel(ohlcv=mod, us=us)
    _same_prefix(base, after, cut + 1)
    assert not base.iloc[cut + 1:]["beta_soxx"].equals(after.iloc[cut + 1:]["beta_soxx"])


# ---------------------------------------------------------------------------
# 상수·스키마·역할
# ---------------------------------------------------------------------------

def test_constants_match_config_and_roles():
    c = CFG["transmission"]["constants"]
    for f in P.__dataclass_fields__:
        assert c[f] == getattr(P, f), f
    assert T.load_params() == P
    assert tuple(CFG["transmission"]["scopes_component"]) == T.SCOPES_COMPONENT
    assert tuple(CFG["transmission"]["scopes_diagnostic"]) == T.SCOPES_DIAGNOSTIC
    assert CFG["transmission"]["reaction_basis"] == T.REACTION_BASIS == "close_to_close"
    assert tuple(CFG["us_assets"]["tickers"]) == U.TICKERS == T.ASSETS
    assert str(CFG["us_assets"]["start"]) == U.START.isoformat()
    us, ohlcv, days = make_world(n=150, scopes=("005930", "KOSPI200"))
    p = _panel(us, ohlcv, scopes=("005930", "KOSPI200"))
    assert set(p.loc[p["scope"] == "005930", "role"]) == {"component"} and set(p.loc[p["scope"] == "KOSPI200", "role"]) == {"diagnostic"}


def test_schema_roundtrip_no_zero_fill(tmp_path):
    us, ohlcv, days = make_world(n=200)
    p = _panel(us, ohlcv)
    path = tmp_path / "tr.parquet"
    T.write_gold(p, path)
    r = T.read_gold(path)
    assert list(r.columns) == [f.name for f in T.GOLD_TRANSMISSION_PANEL] and len(r) == len(p)
    assert r["z_soxx"].iloc[:P.z_min_samples].isna().all() and r["beta_soxx"].iloc[:P.beta_min_samples].isna().all()
    assert (r["method"] == "A").all() and (r["reaction_basis"] == "close_to_close").all()


# ---------------------------------------------------------------------------
# us_daily 적재
# ---------------------------------------------------------------------------

def test_us_daily_normalize_multiindex_tz_and_ret():
    idx = pd.DatetimeIndex(pd.date_range("2024-01-02", periods=4, freq="B", tz="America/New_York"))
    raw = pd.DataFrame({("Close", "NVDA"): [10.0, 11.0, np.nan, 12.1], ("Open", "NVDA"): [1, 1, 1, 1]}, index=idx)
    raw.columns = pd.MultiIndex.from_tuples(raw.columns)
    out = U.normalize_history(raw, "NVDA", fetch_ts=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert list(out["date"]) == [date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 5)]
    assert (out["ticker"] == "NVDA").all()
    assert pd.isna(out["ret_pct"].iloc[0]) and out["ret_pct"].iloc[1] == pytest.approx(10.0) and out["ret_pct"].iloc[2] == pytest.approx(10.0)
    assert out["source"].iloc[0] == "yfinance:NVDA:auto_adjust"
    with pytest.raises(U.UsDailyIngestError):
        U.normalize_history(pd.DataFrame(), "MU")
    frame = U.asset_frame(out, "NVDA")
    assert list(frame.columns) == ["date", "ret_pct", "close"]
    with pytest.raises(ValueError):
        U.asset_frame(out, "TSM")


def test_us_daily_ingest_partial_failure_is_loud_and_writes_nothing(tmp_path, monkeypatch):
    calls = []

    def fake_download(ticker, start, end):
        calls.append(ticker)
        if ticker == "TSM":
            raise RuntimeError("boom")
        idx = pd.DatetimeIndex(pd.date_range("2024-01-02", periods=300, freq="B"))
        return pd.DataFrame({"Close": np.linspace(10, 20, 300)}, index=idx)

    monkeypatch.setattr(U, "_download", fake_download)
    recorded = []
    monkeypatch.setattr(U.alerts, "loud_failure", lambda kind, detail, **kw: recorded.append((kind, detail)))
    out = tmp_path / "us.parquet"
    with pytest.raises(U.UsDailyIngestError, match="boom"):
        U.ingest(path=out)
    assert not out.exists() and calls == ["SOXX", "NVDA", "MU", "TSM"]
    assert recorded and recorded[0][0] == "COLLECT_FAIL" and recorded[0][1]["component"] == "ingest.us_daily"
    # 전부 성공하면 4자산 롱 포맷 기록
    monkeypatch.setattr(U, "_download", lambda t, s, e: fake_download(t if t != "TSM" else "MU", s, e))
    d = U.ingest(path=out)
    assert out.exists() and set(d["ticker"]) == set(U.TICKERS) and len(d) == 1200
