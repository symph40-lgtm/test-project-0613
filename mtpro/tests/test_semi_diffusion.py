"""T5-4 Semiconductor diffusion — 합성 데이터 테스트 (룩어헤드 · 결측 None · PIT 월별 종목군 · z 창 · leader_gap · C-2 · 상수-config 일치)."""
from __future__ import annotations

import pathlib
import sys
from datetime import date

import numpy as np
import pandas as pd
import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))   # `tests.test_breadth` 합성 생성기 재사용

from mtpro.components import breadth as B  # noqa: E402
from mtpro.components import semi_diffusion as SD  # noqa: E402
from mtpro.ingest import semi_group as SG  # noqa: E402
from tests.test_breadth import make_universe, ohlcv_from_close, _month_first  # noqa: E402

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
LEADERS = ["005930", "000660"]


def make_inputs(n_days: int = 420, seed: int = 11):
    """12종목 유니버스 중 6종목을 반도체 종목군으로. 리더 2종목은 코드만 실제 코드로 치환."""
    days, codes, close = make_universe(n_days=n_days, n_codes=12, seed=seed)
    close = close.rename(columns={codes[0]: LEADERS[0], codes[1]: LEADERS[1]})
    codes = list(close.columns)
    semi = [LEADERS[0], LEADERS[1], codes[2], codes[3], codes[4], codes[5]]
    firsts = _month_first(days)
    rows = []
    for a in firsts:
        for c in semi:
            rows.append({"month": f"{a.year:04d}-{a.month:02d}", "asof": a, "code": c, "name": None,
                         "source": "5044|5422", "in_k200": True, "survivorship_bias": False,
                         "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
    sg = pd.DataFrame(rows)
    ohlcv = ohlcv_from_close(close)
    # market_above20 = 전 종목(12) above20 비율 — breadth 함수로 산출
    cm = pd.DataFrame([{"month": f"{a.year:04d}-{a.month:02d}", "asof": a, "code": c, "mcap_rank": i + 1, "tier": None}
                       for a in firsts for i, c in enumerate(codes)])
    mkt = B.compute_breadth_panel(ohlcv, cm, output_start=None)
    market = pd.Series(mkt["above_20d_ratio"].values, index=mkt["date"].values, dtype=float)
    return days, codes, semi, close, ohlcv, sg, market


def test_constants_match_config():
    c = CFG["semi_diffusion"]["constants"]
    assert (c["spread_change_days"], c["z_window_days"], c["z_min_samples"]) == (SD.SPREAD_CHANGE_DAYS, SD.Z_WINDOW_DAYS, SD.Z_MIN_SAMPLES)
    assert tuple(str(x) for x in CFG["semi_diffusion"]["leaders"]) == SD.LEADERS
    assert [str(x) for x in CFG["semi_diffusion"]["source"]["index_codes"]] == list(SG.DEFAULT_INDEX_CODES)
    assert CFG["semi_diffusion"]["source"]["method"] == SG.SOURCE_METHOD
    assert CFG["semi_diffusion"]["source"]["survivorship_bias"] is False
    # §12.4 통일 규정: z 창 120 / 표본 60 = breadth impulse z 와 동일
    assert (SD.Z_WINDOW_DAYS, SD.Z_MIN_SAMPLES) == (B.IMPULSE_Z_WINDOW_DAYS, B.IMPULSE_Z_MIN_SAMPLES)


def test_panel_columns_and_spread_identity():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    p = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    assert list(p.columns) == SD.PANEL_COLUMNS
    assert len(p) == len(days)
    ok = p["diffusion_spread"].notna()
    assert ok.any()
    np.testing.assert_allclose(p.loc[ok, "diffusion_spread"], p.loc[ok, "semi_above20"] - p.loc[ok, "market_above20"])
    # semi_above20 = 종목군 above20 수동 계산 (첫 20일은 MA 결측 → None, n_semi 0 → None)
    ma20 = close.rolling(20, min_periods=20).mean()
    manual = (close[semi] > ma20[semi]).astype(float).where(ma20[semi].notna()).mean(axis=1)
    got = pd.Series(p["semi_above20"].values, index=p["date"].values)
    assert got.iloc[:19].isna().all()
    np.testing.assert_allclose(got.iloc[19:].values, manual.iloc[19:].values)
    assert (p["n_semi"].dropna().astype(int) == 6).iloc[19:].all()
    assert p["engine_ver"].iloc[0] == SD.ENGINE_VER


def test_z_window_past_only_and_min_samples():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    p = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    spread = pd.Series(p["diffusion_spread"].values, index=range(len(p)))
    d5 = spread - spread.shift(SD.SPREAD_CHANGE_DAYS)
    first_d5 = int(d5.first_valid_index())
    z = p["semi_diffusion_z"]
    # 첫 z = d5 유효 60개 확보 다음날 (당일 제외 → 60개는 t−1 까지)
    first_z = int(z.first_valid_index())
    assert first_z == first_d5 + SD.Z_MIN_SAMPLES
    # 수동 검산: t 의 z 는 d5[t−120..t−1] 로만
    t = first_z + 130
    hist = d5.iloc[t - SD.Z_WINDOW_DAYS:t]
    exp = (d5.iloc[t] - hist.mean()) / hist.std(ddof=1)
    assert abs(z.iloc[t] - exp) < 1e-12


def test_no_lookahead_future_price_perturbation():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    p0 = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    cut = 300
    close2 = close.copy()
    close2.iloc[cut:, :] *= np.exp(np.random.default_rng(1).normal(0, 0.1, size=close2.iloc[cut:, :].shape))
    ohlcv2 = ohlcv_from_close(close2)
    firsts = sorted(sg["asof"].unique())
    cm = pd.DataFrame([{"month": f"{a.year:04d}-{a.month:02d}", "asof": a, "code": c, "mcap_rank": i + 1, "tier": None}
                       for a in firsts for i, c in enumerate(codes)])
    mkt2 = B.compute_breadth_panel(ohlcv2, cm, output_start=None)
    market2 = pd.Series(mkt2["above_20d_ratio"].values, index=mkt2["date"].values, dtype=float)
    p1 = SD.compute_semi_diffusion_panel(ohlcv2, sg, market2, output_start=None)
    for col in ("semi_above20", "market_above20", "diffusion_spread", "semi_diffusion_z", "leader_gap", "semi_impulse"):
        a, b = p0[col].iloc[:cut].astype(float), p1[col].iloc[:cut].astype(float)
        assert ((a.isna() & b.isna()) | (np.abs(a - b) < 1e-12)).all(), col
    assert not np.allclose(p0["semi_above20"].iloc[cut + 25:].astype(float), p1["semi_above20"].iloc[cut + 25:].astype(float), equal_nan=True)


def test_pit_membership_snapshot_and_no_snapshot_none():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    # 종목군 목록이 두 번째 달부터만 존재 → 첫 달은 semi_asof None·값 None
    firsts = sorted(sg["asof"].unique())
    sg2 = sg[sg["asof"] >= firsts[1]].copy()
    p = SD.compute_semi_diffusion_panel(ohlcv, sg2, market, output_start=None)
    first_month = p["date"] < firsts[1]
    assert p.loc[first_month, "semi_asof"].isna().all()
    assert p.loc[first_month, ["semi_above20", "n_semi", "leader_gap", "diffusion_spread", "semi_diffusion_z"]].isna().all().all()
    # 월 중간 날짜의 semi_asof = 그 달 월초 (asof ≤ date 최근)
    mid = p[(p["date"] >= firsts[3]) & (p["date"] < firsts[4])]
    assert (mid["semi_asof"] == firsts[3]).all()
    # 어떤 달에 종목군이 리더 2개뿐 → rest 없음 → leader_gap None, semi_above20 은 2종목 평균
    sg3 = sg[~((sg["asof"] == firsts[5]) & (~sg["code"].isin(LEADERS)))].copy()
    p3 = SD.compute_semi_diffusion_panel(ohlcv, sg3, market, output_start=None)
    m5 = p3[(p3["date"] >= firsts[5]) & (p3["date"] < firsts[6])]
    assert m5["leader_gap"].isna().all()
    assert (m5["n_semi"].astype(int) == 2).all()


def test_leader_gap_manual():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    p = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    ma20 = close.rolling(20, min_periods=20).mean()
    a20 = (close > ma20).astype(float).where(ma20.notna())
    rest = [c for c in semi if c not in LEADERS]
    manual = a20[LEADERS].mean(axis=1) - a20[rest].mean(axis=1)
    got = pd.Series(p["leader_gap"].values, index=p["date"].values)
    np.testing.assert_allclose(got.iloc[19:].values, manual.iloc[19:].values)


def test_missing_prices_none_not_zero_and_market_missing_none():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    # 종목군 한 종목이 어느 구간 상장폐지(결측) → n_semi 5, 나머지로 평균 (0 대체 없음)
    close2 = close.copy()
    close2.loc[close2.index[200:260], semi[3]] = np.nan
    ohlcv2 = ohlcv_from_close(close2)
    p = SD.compute_semi_diffusion_panel(ohlcv2, sg, market, output_start=None)
    seg = p.iloc[220:260]
    assert (seg["n_semi"].astype(int) == 5).all()
    assert seg["semi_above20"].notna().all()
    # 종목군 전체 결측 → n_semi 0, semi_above20 None
    close3 = close.copy()
    close3.loc[close3.index[200:230], semi] = np.nan
    p3 = SD.compute_semi_diffusion_panel(ohlcv_from_close(close3), sg, market, output_start=None)
    seg3 = p3.iloc[200:230]
    assert (seg3["n_semi"].astype(int) == 0).all() and seg3["semi_above20"].isna().all() and seg3["diffusion_spread"].isna().all()
    # market_above20 결측 날 → spread None, semi_above20 은 유지
    market4 = market.copy(); market4.iloc[300:305] = np.nan
    p4 = SD.compute_semi_diffusion_panel(ohlcv, sg, market4, output_start=None)
    assert p4["diffusion_spread"].iloc[300:305].isna().all() and p4["semi_above20"].iloc[300:305].notna().all()
    assert p4["market_above20"].iloc[300:305].isna().all()


def test_c2_rejects_unadjusted_and_empty_group():
    days, codes, semi, close, ohlcv, sg, market = make_inputs(n_days=120)
    bad = ohlcv_from_close(close, adjusted=False)
    with pytest.raises(AssertionError):
        SD.compute_semi_diffusion_panel(bad, sg, market, output_start=None)
    with pytest.raises(SD.SemiDiffusionInputError):
        SD.compute_semi_diffusion_panel(ohlcv, sg.iloc[0:0], market, output_start=None)


def test_semi_impulse_same_definition_as_breadth():
    days, codes, semi, close, ohlcv, sg, market = make_inputs()
    p = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    exp = B.breadth_impulse(p["semi_above20"].astype(float))
    a, b = p["semi_impulse"].astype(float), exp
    assert ((a.isna() & b.isna()) | (np.abs(a - b) < 1e-12)).all()


def test_arrow_schema_roundtrip(tmp_path):
    import pyarrow.parquet as pq
    days, codes, semi, close, ohlcv, sg, market = make_inputs(n_days=150)
    p = SD.compute_semi_diffusion_panel(ohlcv, sg, market, output_start=None)
    tbl = SD.panel_to_arrow(p)
    assert tbl.schema.equals(SD.GOLD_SEMI_DIFFUSION_PANEL)
    pq.write_table(tbl, tmp_path / "x.parquet")
    back = pq.read_table(tmp_path / "x.parquet").to_pandas()
    assert back["semi_diffusion_z"].isna().sum() == p["semi_diffusion_z"].isna().sum()
    # silver 스키마 저장도 통과
    n = SG.write_semi_group(sg, tmp_path / "sg.parquet")
    assert n == len(sg)
    s = SG.summarize_semi_group(SG.read_semi_group(tmp_path / "sg.parquet"))
    assert s["survivorship_bias"] is False and s["n_per_month"]["max"] == 6
