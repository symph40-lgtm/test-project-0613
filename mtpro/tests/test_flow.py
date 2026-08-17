"""부품 4 Flow Impact 단위 테스트 (합성 데이터, 네트워크 없음).

- 룩어헤드: 미래 행을 변조해도 과거 값이 바뀌지 않는다 (불변 규칙 1, Gate R1 Lookahead violations = 0)
- 결측 None 유지 (0 대체 금지, 불변 규칙 3)
- 정규화 분모: 과거 20일 자기 포함 평균, 20개 미만이면 None
- β 표본 <60 → None, 회복 검증(진짜 선형 관계를 넣으면 β 회복·|β|>1 플래그)
- C-2: 수정/비수정 혼용 assert
- 스키마: 출력 컬럼 = GOLD_FLOW_PANEL
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import pytest

from mtpro.components import flow
from mtpro.ingest import store
from mtpro.schema import GOLD_FLOW_PANEL


def _synthetic(n: int = 400, seed: int = 7, beta_f: float = 0.02, beta_i: float = -0.01, noise: float = 0.01) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2023-01-02", periods=n).date
    tv = rng.uniform(4e11, 8e11, n)
    foreign = rng.normal(0, 5e10, n)
    inst = rng.normal(0, 4e10, n)
    mean_tv = pd.Series(tv).rolling(20, min_periods=20).mean().to_numpy()
    fn = foreign / mean_tv
    inn = inst / mean_tv
    ret = np.nan_to_num(beta_f * fn + beta_i * inn, nan=0.0) + rng.normal(0, noise, n)
    close = 100 * np.cumprod(1 + ret)
    return pd.DataFrame({"date": dates, "foreign": foreign, "institution": inst, "trading_value": tv, "close_adj": close})


def test_output_columns_match_schema():
    out = flow.compute_flow_scope(_synthetic(150), "005930")
    assert list(out.columns) == GOLD_FLOW_PANEL.names
    assert (out["scope"] == "005930").all() and (out["engine_ver"] == flow.ENGINE_VER).all()


def test_no_lookahead_future_rows_do_not_change_past():
    base = _synthetic(500)
    a = flow.compute_flow_scope(base, "X")
    tampered = base.copy()
    cut = 300
    rng = np.random.default_rng(99)
    tampered.loc[cut:, "foreign"] = rng.normal(0, 5e12, len(tampered) - cut)         # 미래 수급 폭증
    tampered.loc[cut:, "institution"] = -tampered.loc[cut:, "foreign"]
    tampered.loc[cut:, "trading_value"] *= 10
    tampered.loc[cut:, "close_adj"] *= np.linspace(1, 3, len(tampered) - cut)         # 미래 가격 3배
    b = flow.compute_flow_scope(tampered, "X")
    num = [c for c in GOLD_FLOW_PANEL.names if c not in ("date", "scope", "engine_ver", "beta_extreme_flag", "n_beta_obs")]
    pa_ = a.loc[:cut - 1, num].astype(float).to_numpy()
    pb_ = b.loc[:cut - 1, num].astype(float).to_numpy()
    assert np.array_equal(np.isnan(pa_), np.isnan(pb_))
    assert np.allclose(np.nan_to_num(pa_), np.nan_to_num(pb_), rtol=0, atol=0)
    assert (a.loc[:cut - 1, "n_beta_obs"].to_numpy() == b.loc[:cut - 1, "n_beta_obs"].to_numpy()).all()
    assert a.loc[:cut - 1, "beta_extreme_flag"].equals(b.loc[:cut - 1, "beta_extreme_flag"])
    # 대조: 미래 구간은 실제로 달라졌어야 테스트가 의미 있다
    assert not np.allclose(np.nan_to_num(a.loc[cut + 130:, "flow_impact_residual_z"].astype(float)),
                           np.nan_to_num(b.loc[cut + 130:, "flow_impact_residual_z"].astype(float)))


def test_missing_stays_none_not_zero():
    df = _synthetic(300)
    df.loc[150, "foreign"] = None
    df.loc[160, "trading_value"] = None
    df.loc[170, "close_adj"] = None
    out = flow.compute_flow_scope(df, "X")
    assert out.loc[150, "foreign_norm"] is None or pd.isna(out.loc[150, "foreign_norm"])
    assert pd.isna(out.loc[150, "expected_from_flow"]) and pd.isna(out.loc[150, "flow_impact_residual_z"])
    # trading_value 결측 → 그 날부터 20일간 mean20 None → norm None (0 아님)
    assert out.loc[160:179, "foreign_norm"].isna().all()
    assert not (out.loc[160:179, "foreign_norm"].fillna(1) == 0).any()
    # close 결측 → 그날·다음날 수익률 None → 잔차 z None
    assert pd.isna(out.loc[170, "flow_impact_residual_z"]) and pd.isna(out.loc[171, "flow_impact_residual_z"])
    # 처음 19일은 분모 없음 → None; 20일째부터 값
    assert out.loc[:18, "foreign_norm"].isna().all() and pd.notna(out.loc[19, "foreign_norm"])
    # β 표본 <60 → None (첫 유효 수익률 20일째 이후 60개 필요)
    assert out.loc[:77, "flow_beta_foreign"].isna().all()
    assert (out.loc[:77, "n_beta_obs"] < 60).all()


def test_norm_denominator_is_trailing_20_mean_including_today():
    df = _synthetic(60)
    out = flow.compute_flow_scope(df, "X")
    t = 30
    exp = df.loc[t, "foreign"] / df.loc[t - 19:t, "trading_value"].mean()
    assert out.loc[t, "foreign_norm"] == pytest.approx(exp, rel=1e-12)


def test_beta_recovery_and_extreme_flag():
    df = _synthetic(500, beta_f=1.5, beta_i=-0.3, noise=1e-4)
    out = flow.compute_flow_scope(df, "X")
    tail = out.tail(50)
    assert tail["flow_beta_foreign"].astype(float).mean() == pytest.approx(1.5, abs=0.05)
    assert tail["flow_beta_inst"].astype(float).mean() == pytest.approx(-0.3, abs=0.05)
    assert tail["beta_extreme_flag"].astype(bool).all()
    assert (tail["n_beta_obs"] == 120).all()
    ok = out.dropna(subset=["flow_beta_foreign"])
    assert ok["beta_extreme_flag"].notna().all()
    z = out["flow_impact_residual_z"].dropna().astype(float)
    assert 0.5 < z.std() < 1.5


def test_trend_z_uses_only_past_reference():
    df = _synthetic(300)
    out = flow.compute_flow_scope(df, "X")
    # 5일 기울기 첫 값 = idx 23 (norm 첫 값 19 + 4), 당일 제외 기준분포 60개(23..82) 필요 → z 첫 값 = idx 83
    assert out.loc[:82, "flow_trend_z"].isna().all() and pd.notna(out.loc[83, "flow_trend_z"])
    assert out["flow_trend_z"].notna().sum() > 150


def test_c2_mixed_adjustment_rejected_in_assembly():
    d = pd.bdate_range("2023-01-02", periods=30).date
    adj = pd.DataFrame({"date": d, "code": "005930", "close": 100.0, "price_adjusted": True})
    adj.loc[5, "price_adjusted"] = False                       # 혼용
    unadj = pd.DataFrame({"date": d, "code": "005930", "trading_value": 1e11, "price_adjusted": False})
    fl = pd.DataFrame({"date": d, "scope": "005930", "foreign": 1.0, "institution": 1.0})
    with pytest.raises(AssertionError):
        flow.assemble_scope_input(fl, unadj, adj, "005930", "005930", "005930")
    adj["price_adjusted"] = False                              # 수익률 원천이 비수정 → 거부
    with pytest.raises(AssertionError):
        flow.assemble_scope_input(fl, unadj, adj, "005930", "005930", "005930")
    adj["price_adjusted"] = True
    unadj["price_adjusted"] = True                             # 분모가 수정 원천 → 거부
    with pytest.raises(AssertionError):
        flow.assemble_scope_input(fl, unadj, adj, "005930", "005930", "005930")


def test_build_flow_panel_from_frames_and_write(tmp_path):
    n = 200
    d = pd.bdate_range("2023-01-02", periods=n).date
    rng = np.random.default_rng(1)
    adj = pd.concat([pd.DataFrame({"date": d, "code": c, "close": 100 * np.cumprod(1 + rng.normal(0, 0.01, n)), "price_adjusted": True})
                     for c in ("005930", "000660", "KOSPI200")])
    unadj = pd.concat([pd.DataFrame({"date": d, "code": c, "trading_value": rng.uniform(1e11, 2e11, n), "price_adjusted": False})
                       for c in ("005930", "000660", "KOSPI")])
    fl = pd.concat([pd.DataFrame({"date": d, "scope": c, "foreign": rng.normal(0, 1e10, n), "institution": rng.normal(0, 1e10, n)})
                    for c in ("005930", "000660", "KOSPI")])
    cfg = {"scopes": ["KOSPI200", "005930", "000660"], "flow": {"index_unit": "KOSPI_MARKET"}}
    out = tmp_path / "flow_panel.parquet"
    panel = flow.build_flow_panel(cfg, flow_df=fl, unadj_df=unadj, adj_df=adj, write=True, out_path=out, panel_start=d[0])
    # 기본 panel_start(2023-01-03) 는 그 이전 행을 잘라낸다
    assert len(flow.build_flow_panel(cfg, flow_df=fl, unadj_df=unadj, adj_df=adj, write=False)) == 3 * (n - 1)
    assert set(panel["scope"]) == {"KOSPI200", "005930", "000660"} and len(panel) == 3 * n
    import pyarrow.parquet as pq
    t = pq.read_table(out)
    assert store.schema_matches(t.schema, GOLD_FLOW_PANEL)
    assert t.num_rows == 3 * n
