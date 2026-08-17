"""T3-D Energy-Lite 조립 — 합성 데이터 테스트.

룩어헤드 assert(미래 행 변경 → 과거 불변) · None 전파(가용 1개 → None, 2개 → 값·재정규화) · 가중 합 1 ·
config 가중과 모듈 상수 일치 · gradec_err 정의 · breadth 시장 공통 적용 · errata.energy/delta_from_history 재사용 검산 ·
mt_state 인터페이스 · arrow 저장 · 빌드 잡 엔드투엔드.
"""
from __future__ import annotations

import math
import pathlib
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from mtpro.components import energy_lite as EL  # noqa: E402
from mtpro.core.errata import delta_from_history, energy  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# 합성 데이터
# ---------------------------------------------------------------------------

def _trading_days(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _synth(n: int = 200, seed: int = 7, scopes=EL.SCOPES):
    rng = np.random.default_rng(seed)
    days = _trading_days(date(2024, 1, 2), n)
    flow_rows, gc_rows = [], []
    for sc in scopes:
        fz = rng.normal(size=n)
        ga = rng.normal(size=n)
        bz = rng.normal(size=n)
        for i, d in enumerate(days):
            flow_rows.append({"date": d, "scope": sc, "flow_impact_residual_z": fz[i],
                              "flow_trend_z": rng.normal(), "engine_ver": "flow-test"})
            gc_rows.append({"date": d, "scope": sc, "good_acceptance_z": ga[i], "bad_resilience_z": bz[i],
                            "good_beta": 1.0, "bad_beta": 0.8, "err_z": rng.normal(), "engine_ver": "gradec-test"})
    br = pd.DataFrame({"date": days, "breadth_impulse_z": rng.normal(size=n), "engine_ver": "breadth-test"})
    return pd.DataFrame(flow_rows), br, pd.DataFrame(gc_rows), days


# ---------------------------------------------------------------------------
# 사전 등록 상수 · config 일치
# ---------------------------------------------------------------------------

def test_weights_sum_to_one_and_positive():
    assert sum(EL.WEIGHTS.values()) == pytest.approx(1.0, abs=1e-9)
    assert all(w > 0 for w in EL.WEIGHTS.values())
    assert tuple(EL.WEIGHTS) == EL.COMPONENT_NAMES


def test_config_weights_match_module_constants():
    cfg = yaml.safe_load((ROOT / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    block = EL.assert_config_matches(cfg)
    assert {k: float(v) for k, v in block["weights"].items()} == pytest.approx(EL.WEIGHTS, abs=1e-12)
    assert int(block["min_components"]) == EL.MIN_COMPONENTS == 2
    assert int(block["z_window_days"]) == EL.Z_WINDOW_DAYS == 120
    assert tuple(block["scopes"]) == EL.SCOPES


def test_config_mismatch_is_loud():
    cfg = {"energy_lite": {"weights": {"flow": 0.5, "breadth": 0.25, "gradec_err": 0.25},
                           "min_components": 2, "z_window_days": 120, "scopes": list(EL.SCOPES)}}
    with pytest.raises(EL.EnergyLiteInputError):
        EL.assert_config_matches(cfg)
    cfg2 = {"energy_lite": {"weights": dict(EL.WEIGHTS), "min_components": 3, "z_window_days": 120,
                            "scopes": list(EL.SCOPES)}}
    with pytest.raises(EL.EnergyLiteInputError):
        EL.assert_config_matches(cfg2)


def test_z_window_matches_upstream_component_windows():
    """Lite 는 재표준화하지 않으므로 상류 z 창이 config z_window_days 와 같아야 한다."""
    from mtpro.components import breadth as B, flow as F
    assert F.RESID_Z_WINDOW_DAYS == EL.Z_WINDOW_DAYS
    assert B.IMPULSE_Z_WINDOW_DAYS == EL.Z_WINDOW_DAYS
    cfg = yaml.safe_load((ROOT / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    assert int(cfg["grade_c"]["err_z_window_days"]) == EL.Z_WINDOW_DAYS


# ---------------------------------------------------------------------------
# gradec_err 정의
# ---------------------------------------------------------------------------

def test_gradec_err_definition():
    assert EL.gradec_err_z(1.0, -0.5) == pytest.approx(0.25)
    assert EL.gradec_err_z(1.0, None) == pytest.approx(1.0)
    assert EL.gradec_err_z(None, -0.5) == pytest.approx(-0.5)
    assert EL.gradec_err_z(float("nan"), -0.5) == pytest.approx(-0.5)
    assert EL.gradec_err_z(None, None) is None
    assert EL.gradec_err_z(float("nan"), float("nan")) is None
    assert "both None -> None" in EL.GRADEC_ERR_DEFINITION


# ---------------------------------------------------------------------------
# None 전파 · 재정규화 (errata.energy 재사용, min_components=2 특례)
# ---------------------------------------------------------------------------

def test_one_component_yields_none_two_yield_value_renormalized():
    fl, br, gc, days = _synth(n=30)
    d0 = days[10]
    # 005930: d0 에 flow 만 가용 → None
    fl.loc[(fl["scope"] == "005930") & (fl["date"] == d0), "flow_impact_residual_z"] = 0.7
    br.loc[br["date"] == d0, "breadth_impulse_z"] = np.nan
    gc.loc[(gc["scope"] == "005930") & (gc["date"] == d0), ["good_acceptance_z", "bad_resilience_z"]] = np.nan
    # 000660: d0 에 flow + gradec 가용 (breadth 는 공통 결측) → 값, 가중 재정규화
    fl.loc[(fl["scope"] == "000660") & (fl["date"] == d0), "flow_impact_residual_z"] = 0.7
    gc.loc[(gc["scope"] == "000660") & (gc["date"] == d0), ["good_acceptance_z", "bad_resilience_z"]] = [1.0, -0.2]

    p = EL.compute_energy_lite_panel(fl, br, gc)
    r1 = p[(p["scope"] == "005930") & (p["date"] == d0)].iloc[0]
    assert pd.isna(r1["energy_lite"])
    assert r1["available_components"] == ["flow"]
    assert r1["n_components"] == 1

    r2 = p[(p["scope"] == "000660") & (p["date"] == d0)].iloc[0]
    assert not pd.isna(r2["energy_lite"])
    assert r2["available_components"] == ["flow", "gradec_err"]
    assert r2["n_components"] == 2
    w = EL.WEIGHTS
    wsum = w["flow"] + w["gradec_err"]
    expected = (math.tanh(0.7) * w["flow"] / wsum + math.tanh(0.4) * w["gradec_err"] / wsum) * 100
    assert int(r2["energy_lite"]) == int(round(expected))
    # errata.energy 와 동일 (재구현 아님)
    ref = energy({"flow": 0.7, "breadth": None, "gradec_err": 0.4}, w, min_components=2)
    assert int(r2["energy_lite"]) == ref["energy"]
    assert sum(ref["weights_used"].values()) == pytest.approx(1.0)

    # KOSPI200 은 d0 에 breadth 결측이라 2개 가용, 다른 날은 3개
    r3 = p[(p["scope"] == "KOSPI200") & (p["date"] == d0)].iloc[0]
    assert r3["n_components"] == 2
    assert (p[(p["scope"] == "KOSPI200") & (p["date"] != d0)]["n_components"] == 3).all()


def test_all_components_missing_yields_none_and_empty_list():
    fl, br, gc, days = _synth(n=20)
    d0 = days[5]
    fl.loc[fl["date"] == d0, "flow_impact_residual_z"] = np.nan
    br.loc[br["date"] == d0, "breadth_impulse_z"] = np.nan
    gc.loc[gc["date"] == d0, ["good_acceptance_z", "bad_resilience_z"]] = np.nan
    p = EL.compute_energy_lite_panel(fl, br, gc)
    rows = p[p["date"] == d0]
    assert rows["energy_lite"].isna().all()
    assert (rows["n_components"] == 0).all()
    assert all(v == [] for v in rows["available_components"])
    # 0 대체 없음: 컴포넌트 z 도 NaN 그대로
    assert rows[["flow_z", "breadth_z", "gradec_err_z"]].isna().all().all()


def test_energy_matches_errata_energy_rowwise_and_bounds():
    fl, br, gc, _ = _synth(n=60, seed=3)
    p = EL.compute_energy_lite_panel(fl, br, gc)
    for r in p.itertuples(index=False):
        ref = energy({"flow": None if pd.isna(r.flow_z) else float(r.flow_z),
                      "breadth": None if pd.isna(r.breadth_z) else float(r.breadth_z),
                      "gradec_err": None if pd.isna(r.gradec_err_z) else float(r.gradec_err_z)},
                     EL.WEIGHTS, min_components=EL.MIN_COMPONENTS)
        if ref["energy"] is None:
            assert pd.isna(r.energy_lite)
        else:
            assert int(r.energy_lite) == ref["energy"]
            assert -100 <= int(r.energy_lite) <= 100
        assert list(r.available_components) == ref["available_components"]


def test_breadth_market_wide_applied_to_every_scope():
    fl, br, gc, days = _synth(n=15)
    p = EL.compute_energy_lite_panel(fl, br, gc)
    for sc in EL.SCOPES:
        got = p[p["scope"] == sc].set_index("date")["breadth_z"]
        exp = br.set_index("date")["breadth_impulse_z"]
        pd.testing.assert_series_equal(got.loc[days], exp.loc[days], check_names=False)


def test_breadth_with_scope_column_is_rejected():
    fl, br, gc, _ = _synth(n=10)
    br2 = br.copy()
    br2["scope"] = "KOSPI200"
    with pytest.raises(EL.EnergyLiteInputError):
        EL.compute_energy_lite_panel(fl, br2, gc)


def test_duplicate_rows_are_rejected():
    fl, br, gc, _ = _synth(n=10)
    fl2 = pd.concat([fl, fl.iloc[[0]]], ignore_index=True)
    with pytest.raises(EL.EnergyLiteInputError):
        EL.compute_energy_lite_panel(fl2, br, gc)


# ---------------------------------------------------------------------------
# Delta (errata.delta_from_history 재사용, 과거만)
# ---------------------------------------------------------------------------

def test_delta_matches_delta_from_history_on_past_only():
    fl, br, gc, _ = _synth(n=120, seed=11)
    p = EL.compute_energy_lite_panel(fl, br, gc)
    for sc in EL.SCOPES:
        g = p[p["scope"] == sc].sort_values("date").reset_index(drop=True)
        hist = [None if pd.isna(v) else int(v) for v in g["energy_lite"]]
        for i in range(len(g)):
            ref = delta_from_history(hist[: i + 1], **EL.DELTA_PARAMS)
            got = g.loc[i, "delta_lite"]
            if ref is None:
                assert pd.isna(got)
            else:
                assert int(got) == ref
                assert -100 <= int(got) <= 100
    # 초반은 표본 부족으로 None (recent 5 + min_changes 5)
    first = p[p["scope"] == "KOSPI200"].sort_values("date").head(5)
    assert first["delta_lite"].isna().all()


def test_delta_none_when_recent_window_has_none_energy():
    fl, br, gc, days = _synth(n=80, seed=5)
    d0 = days[50]
    fl.loc[fl["date"] == d0, "flow_impact_residual_z"] = np.nan
    br.loc[br["date"] == d0, "breadth_impulse_z"] = np.nan
    gc.loc[gc["date"] == d0, ["good_acceptance_z", "bad_resilience_z"]] = np.nan
    p = EL.compute_energy_lite_panel(fl, br, gc)
    g = p[p["scope"] == "005930"].sort_values("date").reset_index(drop=True)
    i0 = int(g.index[g["date"] == d0][0])
    assert g.loc[i0 : i0 + 4, "delta_lite"].isna().all()       # d0 포함 최근 5창에 None → None
    assert not pd.isna(g.loc[i0 + 5, "delta_lite"])            # 창이 지나면 복귀


# ---------------------------------------------------------------------------
# 룩어헤드 assert
# ---------------------------------------------------------------------------

def test_lookahead_future_rows_change_does_not_alter_past():
    fl, br, gc, days = _synth(n=150, seed=21)
    base = EL.compute_energy_lite_panel(fl, br, gc)
    cutoff = days[100]

    fl2, br2, gc2 = fl.copy(), br.copy(), gc.copy()
    fl2.loc[fl2["date"] > cutoff, "flow_impact_residual_z"] *= -3.0
    br2.loc[br2["date"] > cutoff, "breadth_impulse_z"] = 5.0
    gc2.loc[gc2["date"] > cutoff, ["good_acceptance_z", "bad_resilience_z"]] = np.nan
    gc2.loc[gc2["date"] > cutoff, ["good_beta", "bad_beta"]] = 9.9
    alt = EL.compute_energy_lite_panel(fl2, br2, gc2)

    past_base = base[base["date"] <= cutoff].reset_index(drop=True)
    past_alt = alt[alt["date"] <= cutoff].reset_index(drop=True)
    pd.testing.assert_frame_equal(past_base, past_alt)
    # 미래는 실제로 달라졌음을 확인 (테스트가 무의미하지 않도록)
    fut_base = base[base["date"] > cutoff].reset_index(drop=True)
    fut_alt = alt[alt["date"] > cutoff].reset_index(drop=True)
    assert not fut_base["energy_lite"].equals(fut_alt["energy_lite"])

    # 미래 행 삭제 → 과거 불변
    fl3, br3, gc3 = (df[df["date"] <= cutoff] for df in (fl, br, gc))
    trunc = EL.compute_energy_lite_panel(fl3, br3, gc3).reset_index(drop=True)
    pd.testing.assert_frame_equal(past_base, trunc)


# ---------------------------------------------------------------------------
# 부품 8 인터페이스 · 저장
# ---------------------------------------------------------------------------

def test_mt_state_interface_fields_and_none_placeholders():
    fl, br, gc, _ = _synth(n=30)
    p = EL.compute_energy_lite_panel(fl, br, gc)
    recs = EL.mt_state_records(p)
    assert len(recs) == len(p)
    for r in recs[:10]:
        assert set(r) == set(EL.MT_STATE_FIELDS) | {"date", "scope"}
        assert r["regime_probs"] is None and r["confidence"] is None
        assert r["good_beta"] == pytest.approx(1.0) and r["bad_beta"] == pytest.approx(0.8)
        assert r["energy"] is None or isinstance(r["energy"], int)
    assert set(EL.MT_STATE_FORWARD_ONLY) == {"regime_probs", "confidence"}


def test_arrow_roundtrip_nulls_and_schema(tmp_path):
    fl, br, gc, days = _synth(n=40)
    d0 = days[3]
    fl.loc[fl["date"] == d0, "flow_impact_residual_z"] = np.nan
    br.loc[br["date"] == d0, "breadth_impulse_z"] = np.nan
    p = EL.compute_energy_lite_panel(fl, br, gc)
    out = EL.write_gold(p, tmp_path / "energy_lite_panel.parquet")
    tbl = pq.read_table(out)
    assert tbl.schema.names == EL.PANEL_COLUMNS
    assert tbl.schema.equals(EL.GOLD_ENERGY_LITE_PANEL)
    back = tbl.to_pandas()
    assert len(back) == len(p)
    row = back[(back["date"] == d0) & (back["scope"] == "KOSPI200")].iloc[0]
    assert pd.isna(row["energy_lite"]) and row["n_components"] == 1
    assert list(row["available_components"]) == ["gradec_err"]
    assert (back["engine_ver"] == EL.ENGINE_VER).all()


def test_build_job_end_to_end(tmp_path, monkeypatch):
    sys.path.insert(0, str(ROOT / "jobs"))
    import build_energy_lite as job  # noqa: E402

    fl, br, gc, _ = _synth(n=50)
    paths = {"flow": tmp_path / "flow_panel.parquet", "breadth": tmp_path / "breadth_panel.parquet",
             "gradec": tmp_path / "gradec_panel.parquet"}
    fl.to_parquet(paths["flow"], index=False)
    br.to_parquet(paths["breadth"], index=False)
    gc.to_parquet(paths["gradec"], index=False)
    monkeypatch.setattr(job, "INPUT_FILES", paths)
    out_path = tmp_path / "energy_lite_panel.parquet"
    # write_gold 의 기본 경로는 정의 시점에 묶이므로 함수 자체를 tmp 경로로 바꾼다
    monkeypatch.setattr(EL, "write_gold", lambda panel, path=out_path: (pq.write_table(EL.panel_to_arrow(panel), path), path)[1])
    monkeypatch.setattr(job.settings, "ensure_dirs", lambda: None)
    summary_path = tmp_path / "summary.json"
    rc = job.main(["--summary-json", str(summary_path)])
    assert rc == 0
    assert out_path.exists()
    assert summary_path.exists()
    back = pq.read_table(out_path).to_pandas()
    assert len(back) == 50 * len(EL.SCOPES)

    # 입력 결손 + 대기 0 → exit 3 (loud)
    monkeypatch.setattr(job, "INPUT_FILES", {**paths, "gradec": tmp_path / "nope.parquet"})
    assert job.main(["--wait-minutes", "0"]) == 3
