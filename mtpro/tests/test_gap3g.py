"""T5-2 부품 3G (components/gap3g.py) 테스트.

- 정의: gap_pct·gap_hold(|gap|<0.3% None, 클립 [−1,2])·gap_hold_signed·CLV(high=low None)
- z: t−1까지 120행 과거 전용, 표본<60 None, 클립 ±3
- Gap Reaction ERR: β_gap(60행 t 미포함, <40 None, 클립 [0.3,3])·expected_gap·재료 없는 날·σ_gap(<60 None)·err_z, expected_gap_source
- 룩어헤드 assert: 미래 OHLCV 변조 → 과거 불변 / t일 이후 SOX 세션 변조 → t행 불변(d ≤ t−1 엄격) / reused → None
- 상수 = config gap3g.constants, 스키마 write/read, gradec_panel(A-1) 경로와 분리
"""
from __future__ import annotations

import pathlib
from datetime import date

import numpy as np
import pandas as pd
import pytest
import yaml

from mtpro.components import gap3g as G
from mtpro.components import gradec

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
P = G.Gap3GParams()


def _bdays(start: date, n: int) -> list[date]:
    return [d.date() for d in pd.bdate_range(start, periods=n)]


def _sox_frame(days, rets):
    return pd.DataFrame({"date": days, "ret_pct": rets, "close": 100.0 + np.cumsum(rets), "source": "syn",
                         "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})


def _ohlcv_from(days, code, gap_pct, oc_pct, wick=0.5):
    """전일 종가→시가 = gap_pct(%), 시가→종가 = oc_pct(%), high/low = 시가·종가 범위 ± wick%."""
    rows = []
    prev = 100.0
    for i, d in enumerate(days):
        o = prev * (1 + gap_pct[i] / 100)
        c = o * (1 + oc_pct[i] / 100)
        hi = max(o, c) * (1 + wick / 100)
        lo = min(o, c) * (1 - wick / 100)
        rows.append({"date": d, "code": code, "open": o, "high": hi, "low": lo, "close": c, "volume": 1.0, "trading_value": None,
                     "price_adjusted": True, "source": "syn", "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
        prev = c
    return pd.DataFrame(rows)


def make_world(n=320, beta_true=0.9, seed=3, scopes=("005930",)):
    """미국 세션 d 와 국내 t 가 같은 평일 달력. 국내 t 갭 = beta·SOX(t−1) + 잡음."""
    rng = np.random.default_rng(seed)
    days = _bdays(date(2023, 1, 2), n + 1)
    sox_ret = rng.normal(0, 1.5, n + 1)
    sox = _sox_frame(days, sox_ret)
    frames = []
    for k, sc in enumerate(scopes):
        prev = np.r_[np.nan, sox_ret[:-1]]
        gap = beta_true * np.nan_to_num(prev) + rng.normal(0, 0.8, n + 1) + 0.05 * k
        oc = rng.normal(0, 1.0, n + 1)
        frames.append(_ohlcv_from(days, sc, gap, oc))
    return sox, pd.concat(frames, ignore_index=True), days


def _panel(sox, ohlcv, params=P, scopes=("005930",)):
    return G.build_panel(ohlcv, sox, params, scopes=scopes).reset_index(drop=True)


def _same_prefix(a, b, upto):
    pd.testing.assert_frame_equal(a.iloc[:upto].reset_index(drop=True), b.iloc[:upto].reset_index(drop=True), check_dtype=False)


# ---------------------------------------------------------------------------
# 정의
# ---------------------------------------------------------------------------

def test_gap_hold_definition_threshold_clip_and_sign():
    days = _bdays(date(2024, 1, 1), 6)
    #            d0    d1     d2     d3     d4     d5
    gap = np.array([0.0, 1.0, -1.0, 0.2, 2.0, -2.0])
    oc = np.array([0.0, 0.0, 0.0, 5.0, 3.0, -1.0])       # d1: 갭 유지(hold 1) d2: 유지(hold 1) d3: |gap|<0.3 → None d4: 확장(>2 클립) d5: 음의 갭 확장
    o = _ohlcv_from(days, "005930", gap, oc)
    p = _panel(_sox_frame(days, np.zeros(6)), o).set_index("date")
    assert pd.isna(p.loc[days[0], "gap_pct"]) and pd.isna(p.loc[days[0], "gap_hold"])           # prev_close 없음
    assert p.loc[days[1], "gap_pct"] == pytest.approx(1.0) and p.loc[days[1], "gap_hold"] == pytest.approx(1.0)
    assert p.loc[days[1], "gap_hold_signed"] == pytest.approx(1.0)
    assert p.loc[days[2], "gap_hold"] == pytest.approx(1.0) and p.loc[days[2], "gap_hold_signed"] == pytest.approx(-1.0)   # 음의 갭 유지 = −
    assert abs(p.loc[days[3], "gap_pct"]) < P.min_gap_abs_pct and pd.isna(p.loc[days[3], "gap_hold"]) and pd.isna(p.loc[days[3], "gap_hold_signed"])
    assert p.loc[days[4], "gap_hold"] == pytest.approx(2.0)                                       # (1.02·1.03−1)/0.02 = 2.53 → 클립 2
    hold5 = (1.02 * 1.03 * 0.98 * 0.99 / (1.02 * 1.03) - 1) / (0.98 - 1)                         # 음의 갭 확장 → >1
    assert p.loc[days[5], "gap_hold"] == pytest.approx(min(2.0, hold5))
    assert p.loc[days[5], "gap_hold_signed"] == pytest.approx(-min(2.0, hold5))                    # 음의 갭 확장 = −
    # 반전: 양의 갭 후 하락 마감 → hold<0, 클립 −1
    o2 = _ohlcv_from(days[:3], "005930", np.array([0.0, 1.0, 1.0]), np.array([0.0, -5.0, -1.5]))
    p2 = _panel(_sox_frame(days[:3], np.zeros(3)), o2).set_index("date")
    assert p2.loc[days[1], "gap_hold"] == pytest.approx(-1.0)                                      # (1.01·0.95−1)/0.01 = −4.05 → −1
    assert p2.loc[days[2], "gap_hold"] == pytest.approx((1.01 * 0.985 - 1) / 0.01)                # −0.515 (반전, 클립 안 걸림)
    assert p2.loc[days[2], "gap_hold_signed"] < 0


def test_close_acceptance_clv_and_flat_range_none():
    days = _bdays(date(2024, 1, 1), 3)
    o = _ohlcv_from(days, "005930", np.zeros(3), np.array([1.0, -1.0, 0.0]), wick=0.0)
    o.loc[2, ["high", "low"]] = o.loc[2, "close"]                     # high == low
    p = _panel(_sox_frame(days, np.zeros(3)), o).set_index("date")
    assert p.loc[days[0], "close_acceptance"] == pytest.approx(1.0)   # 상승 마감(wick 0) → 종가 = 고가
    assert p.loc[days[1], "close_acceptance"] == pytest.approx(0.0)
    assert pd.isna(p.loc[days[2], "close_acceptance"])
    assert ((p["close_acceptance"].dropna() >= 0) & (p["close_acceptance"].dropna() <= 1)).all()


def test_c2_price_adjusted_assert_and_t0_mode_unchanged():
    days = _bdays(date(2024, 1, 1), 3)
    o = _ohlcv_from(days, "005930", np.zeros(3), np.zeros(3))
    o.loc[1, "price_adjusted"] = False
    with pytest.raises(AssertionError, match="C-2"):
        G.scope_ohlcv(o, "005930")
    p = _panel(_sox_frame(days, np.zeros(3)), _ohlcv_from(days, "005930", np.zeros(3), np.zeros(3)))
    assert (p["t0_mode"] == "A1_open").all() and (p["time_axis"] == "A-1R").all() and (p["grade"] == "C").all()


# ---------------------------------------------------------------------------
# z·β·σ 규칙 (표본 부족 None, 과거 전용)
# ---------------------------------------------------------------------------

def test_z_none_before_min_samples_and_uses_past_only():
    sox, ohlcv, days = make_world(n=300)
    p = _panel(sox, ohlcv)
    for col, src in (("close_acceptance_z", "close_acceptance"), ("gap_hold_z", "gap_hold_signed")):
        valid = p[src].notna().to_numpy()
        # z 정의 행의 인덱스 i: values[i−120..i−1] 유효 표본 ≥ 60
        first = p[col].first_valid_index()
        assert first is not None
        assert int(valid[max(0, first - P.z_window_days):first].sum()) >= P.z_min_samples
        assert p.loc[:first - 1, col].isna().all()
        # 수동 재계산 (t−1까지 120행, ddof=1)
        i = first + 40
        past = p.loc[max(0, i - P.z_window_days):i - 1, src].dropna().astype(float)
        if pd.notna(p.loc[i, src]) and len(past) >= P.z_min_samples:
            z = (float(p.loc[i, src]) - past.mean()) / past.std(ddof=1)
            assert p.loc[i, col] == pytest.approx(float(np.clip(z, -3, 3)))
    assert p["gap_hold_z"].abs().max() <= P.z_clip_abs and p["close_acceptance_z"].abs().max() <= P.z_clip_abs


def test_beta_gap_recovers_true_beta_and_none_before_40():
    sox, ohlcv, days = make_world(n=300, beta_true=0.9)
    p = _panel(sox, ohlcv)
    first = p["beta_gap"].first_valid_index()
    assert first is not None and first >= P.beta_gap_min_samples
    assert p.loc[:first - 1, "beta_gap"].isna().all() and p.loc[:first - 1, "expected_gap"].isna().all()
    late = p["beta_gap_raw"].dropna().iloc[-60:]
    assert 0.7 < late.mean() < 1.1
    # β 는 t 미포함: 행 t 의 gap 을 크게 바꿔도 t 의 β 불변
    t = 200
    mod = ohlcv.copy()
    mod.loc[t, "open"] = mod.loc[t, "open"] * 1.2
    q = _panel(sox, mod)
    assert q.loc[t, "beta_gap_raw"] == pytest.approx(p.loc[t, "beta_gap_raw"])
    assert q.loc[t, "sigma_gap"] == pytest.approx(p.loc[t, "sigma_gap"])          # σ 도 t−1까지
    assert q.loc[t + 1, "beta_gap_raw"] != pytest.approx(p.loc[t + 1, "beta_gap_raw"])


def test_expected_gap_material_rule_and_err_z():
    sox, ohlcv, days = make_world(n=300)
    p = _panel(sox, ohlcv)
    d = p[p["expected_gap"].notna()]
    assert (d["expected_gap_source"] == "gradeC").all()
    assert p.loc[p["expected_gap"].isna(), "expected_gap_source"].isna().all()
    nm = d[d["no_material_flag"] == True]  # noqa: E712
    assert len(nm) > 0 and (nm["expected_gap"].abs() < P.min_expected_gap_abs_pct).all()
    assert nm["gap_reaction_err"].isna().all() and nm["gap_reaction_err_z"].isna().all()
    mat = d[d["no_material_flag"] == False]  # noqa: E712
    assert np.allclose(mat["gap_reaction_err"].astype(float), mat["gap_pct"].astype(float) - mat["expected_gap"].astype(float))
    # σ_gap: 과거 120행 잔차 표본 ≥ 60 전에는 None → err_z None
    first_sig = p["sigma_gap"].first_valid_index()
    assert first_sig is not None
    assert int(p.loc[max(0, first_sig - P.sigma_gap_window_days):first_sig - 1, "gap_reaction_err"].notna().sum()) >= P.sigma_gap_min_samples
    assert p.loc[:first_sig - 1, "gap_reaction_err_z"].isna().all()
    ok = p[p["gap_reaction_err_z"].notna()]
    assert np.allclose(ok["gap_reaction_err_z"].astype(float), ok["gap_reaction_err"].astype(float) / ok["sigma_gap"].astype(float))
    assert (p["sigma_gap"].dropna() >= P.sigma_gap_floor).all()
    # 캘리브레이션(합성): std(err_z) ≈ 1
    assert 0.7 < ok["gap_reaction_err_z"].std(ddof=1) < 1.3


def test_reused_session_gives_no_expected_gap():
    sox, ohlcv, days = make_world(n=200)
    hol = days[150]
    sox2 = sox[sox["date"] != hol]                    # 미국 휴장 → 국내 days[151] 은 days[149] 세션 재사용
    p = _panel(sox2, ohlcv).set_index("date")
    assert p.loc[days[151], "sox_align_status"] == "reused" and pd.isna(p.loc[days[151], "sox_ret_prev"])
    assert pd.isna(p.loc[days[151], "expected_gap"]) and pd.isna(p.loc[days[151], "gap_reaction_err_z"])
    assert p.loc[days[151], "expected_gap_source"] is None or pd.isna(p.loc[days[151], "expected_gap_source"])
    # gap_hold·CLV 는 SOX 와 무관하게 정의된다
    assert pd.notna(p.loc[days[151], "close_acceptance"])


# ---------------------------------------------------------------------------
# 룩어헤드
# ---------------------------------------------------------------------------

def test_lookahead_future_ohlcv_change_leaves_past_unchanged():
    sox, ohlcv, days = make_world(n=300)
    base = _panel(sox, ohlcv)
    cut = 220
    mod = ohlcv.copy()
    m = pd.to_datetime(mod["date"]).dt.date > days[cut]
    mod.loc[m, "close"] = mod.loc[m, "close"] * 1.3
    mod.loc[m, "open"] = mod.loc[m, "open"] * 0.95
    mod.loc[m, "high"] = mod.loc[m, "high"] * 1.4
    after = _panel(sox, mod)
    _same_prefix(base, after, cut + 1)
    assert not base.iloc[cut + 1:]["gap_hold_z"].equals(after.iloc[cut + 1:]["gap_hold_z"])


def test_lookahead_sox_same_day_and_future_change_leaves_row_t_unchanged():
    sox, ohlcv, days = make_world(n=300)
    base = _panel(sox, ohlcv)
    t = 200
    mod = sox.copy()
    m = pd.to_datetime(mod["date"]).dt.date >= days[t]                 # d ≥ t (t일 밤 세션 포함) 변조
    mod.loc[m, "ret_pct"] = mod.loc[m, "ret_pct"] + 4.0
    after = _panel(mod, ohlcv)
    _same_prefix(base, after, t + 1)
    assert after.loc[t + 1, "sox_ret_prev"] == pytest.approx(base.loc[t + 1, "sox_ret_prev"] + 4.0)


# ---------------------------------------------------------------------------
# 상수·스키마·분리
# ---------------------------------------------------------------------------

def test_constants_match_config():
    c = CFG["gap3g"]["constants"]
    assert (c["min_gap_abs_pct"], tuple(c["gap_hold_clip"]), c["z_window_days"], c["z_min_samples"], c["z_clip_abs"]) == (
        P.min_gap_abs_pct, P.gap_hold_clip, P.z_window_days, P.z_min_samples, P.z_clip_abs)
    assert (c["beta_gap_window_days"], c["beta_gap_min_samples"], tuple(c["beta_gap_clip"]), c["min_expected_gap_abs_pct"]) == (
        P.beta_gap_window_days, P.beta_gap_min_samples, P.beta_gap_clip, P.min_expected_gap_abs_pct)
    assert (c["sigma_gap_window_days"], c["sigma_gap_min_samples"], c["sigma_gap_floor"], c["max_stale_calendar_days"]) == (
        P.sigma_gap_window_days, P.sigma_gap_min_samples, P.sigma_gap_floor, P.max_stale_calendar_days)
    assert G.load_params() == P
    assert CFG["gap3g"]["time_axis"] == G.TIME_AXIS and CFG["gap3g"]["t0_mode"] == G.T0_MODE
    assert tuple(CFG["gap3g"]["expected_gap_sources"]) == G.EXPECTED_GAP_SOURCES
    # β·정렬 상수는 grade_c 와 동일 (§1: 등급C 재료 재추정)
    gp = gradec.GradeCParams()
    assert (P.beta_gap_window_days, P.beta_gap_min_samples, P.beta_gap_clip, P.max_stale_calendar_days) == (
        gp.beta_window_days, gp.beta_min_samples, gp.beta_clip, gp.max_stale_calendar_days)


def test_schema_roundtrip_and_no_zero_fill(tmp_path):
    sox, ohlcv, days = make_world(n=150)
    p = _panel(sox, ohlcv)
    path = tmp_path / "gap3g.parquet"
    G.write_gold(p, path)
    r = G.read_gold(path)
    assert list(r.columns) == [f.name for f in G.GOLD_GAP3G_PANEL] and len(r) == len(p)
    # 표본 부족 구간의 None 이 0 으로 바뀌지 않는다
    assert r["gap_hold_z"].iloc[:P.z_min_samples].isna().all()
    assert r["beta_gap"].iloc[:P.beta_gap_min_samples].isna().all()
    assert (r["price_adjusted"] == True).all()  # noqa: E712


def test_separate_from_gradec_gate_r1_panel():
    """A-1R 계열: 소급 Gate R1 gradec_panel(open→close) 경로·엔진과 분리."""
    assert G.GOLD_GAP3G_PANEL_PATH != gradec.GOLD_GRADEC_PANEL_PATH
    assert G.ENGINE_VER != gradec.ENGINE_VER and G.EVENT_TYPE != gradec.EVENT_TYPE
