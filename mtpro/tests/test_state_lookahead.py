"""T5-5 룩어헤드 없음 — 합성 gold 패널로 build_scope: 미래 행 변조 → 과거 불변, psa available_at 규칙, available_at=t, 스키마."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest

from mtpro.state import build as B
from mtpro.state import families as FA

N = 320
SCOPE = "005930"


def _dates(n=N):
    d0 = date(2023, 1, 2)
    out, d = [], d0
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _synth(seed=0):
    rng = np.random.default_rng(seed)
    dates = _dates()
    n = len(dates)
    close = 60000 * np.exp(np.cumsum(rng.normal(0, 0.015, n)))
    sox = rng.normal(0, 1.5, n)
    gap = 0.8 * sox + rng.normal(0, 0.8, n)
    exp_gap = 0.8 * sox
    material = np.abs(exp_gap) >= 0.3
    errz = np.where(material, (gap - exp_gap) / 0.8, np.nan)
    hold_z = rng.normal(0, 1, n)
    hold_z[np.abs(gap) < 0.3] = np.nan
    g3 = pd.DataFrame({
        "date": dates, "scope": SCOPE, "gap_pct": gap, "gap_hold": rng.uniform(-1, 2, n), "gap_hold_z": hold_z,
        "close_acceptance_z": rng.normal(0, 1, n), "sox_ret_prev": sox, "expected_gap": exp_gap, "expected_gap_source": "gradeC",
        "gap_reaction_err_z": errz, "grade": "C", "close": close,
    })
    g3.loc[:70, ["gap_reaction_err_z"]] = np.nan          # 초기 warmup (σ 없음)
    tr = pd.DataFrame({"date": dates, "scope": SCOPE, "transmission_asym_z": np.where(np.arange(n) > 100, rng.normal(0, 1, n), np.nan)})
    flow = pd.DataFrame({"date": dates, "scope": SCOPE, "flow_impact_residual_z": rng.normal(0, 1, n)})
    br = pd.DataFrame({"date": dates, "breadth_impulse_z": rng.normal(0, 1, n), "above_20d_ratio": rng.uniform(0.2, 0.8, n)})
    semi = pd.DataFrame({"date": dates, "semi_diffusion_z": rng.normal(0, 1, n)})
    # PSA: 충격 몇 개, final/pending, available_at = shock+5 세션
    shocks = [30, 90, 150, 210, 260, 300]
    rows = []
    for k, i in enumerate(shocks):
        st = "final" if i + 5 < n else "pending"
        rows.append({"shock_id": f"{SCOPE}:{dates[i]}", "scope": SCOPE, "shock_date": dates[i], "direction": 1 if k % 2 == 0 else -1,
                     "k_sigma": 3.0, "trigger": "ret", "status": st, "available_at": dates[min(i + 5, n - 1)] if st == "final" else None,
                     "level_hold": 0.5, "rebreak": False, "range_norm": 1.0, "vol_norm": 1.0, "psa_score": 0.4,
                     "psa_z": (0.8 if k % 2 == 0 else -0.6) if st == "final" else None, "overlap_shock": False, "engine_ver": "psa-0.1"})
    psa = pd.DataFrame(rows)
    psa["direction"] = psa["direction"].astype("Int8")
    return g3, tr, flow, br, semi, psa


def _run(g3, tr, flow, br, semi, psa, **kw):
    return B.build_scope(SCOPE, g3, tr, flow, br, semi, psa, **kw)


def test_future_mutation_leaves_past_unchanged_and_available_at_is_t():
    g3, tr, flow, br, semi, psa = _synth()
    base = _run(g3, tr, flow, br, semi, psa)["mt_state"]
    cut = 250
    g3m, trm, flm, brm, smm, psam = [x.copy() for x in (g3, tr, flow, br, semi, psa)]
    for df, cols in ((g3m, ["gap_pct", "gap_hold_z", "close_acceptance_z", "gap_reaction_err_z", "sox_ret_prev", "expected_gap", "close"]),
                     (trm, ["transmission_asym_z"]), (flm, ["flow_impact_residual_z"]), (brm, ["breadth_impulse_z", "above_20d_ratio"]),
                     (smm, ["semi_diffusion_z"])):
        m = pd.to_datetime(df["date"]).dt.date >= base["date"].iloc[cut]
        for c in cols:
            df.loc[m, c] = 99.0 if c != "close" else 1e6
    # 미래 psa 관측 변조 (available_at ≥ cut)
    fut = pd.to_datetime(psam["available_at"]).dt.date >= base["date"].iloc[cut]
    psam.loc[fut, "psa_z"] = 3.0
    mut = _run(g3m, trm, flm, brm, smm, psam)["mt_state"]
    cmp_cols = [c for c in B.MT_STATE_COLUMNS if c not in ("engine_ver",)]
    a = base[cmp_cols].iloc[:cut].reset_index(drop=True)
    b = mut[cmp_cols].iloc[:cut].reset_index(drop=True)
    pd.testing.assert_frame_equal(a, b, check_dtype=False)
    assert (base["available_at"] == base["date"]).all()
    # 변조 구간은 실제로 달라야 한다(테스트 자체 유효성)
    assert not base["energy"].iloc[cut:].equals(mut["energy"].iloc[cut:])


def test_end_truncation_equals_full_run_prefix():
    g3, tr, flow, br, semi, psa = _synth(1)
    full = _run(g3, tr, flow, br, semi, psa)["mt_state"]
    end = full["date"].iloc[200]
    part = _run(g3, tr, flow, br, semi, psa, end=end)["mt_state"]
    cols = [c for c in B.MT_STATE_COLUMNS if c != "engine_ver"]
    pd.testing.assert_frame_equal(full[cols].iloc[:201].reset_index(drop=True), part[cols].reset_index(drop=True), check_dtype=False)


def test_psa_available_at_rule_pending_and_future_not_used():
    g3, tr, flow, br, semi, psa = _synth(2)
    res = _run(g3, tr, flow, br, semi, psa)
    pa = res["price_accept"]
    dates = list(pa["date"])
    first_av = min(d for d in pd.to_datetime(psa["available_at"].dropna()).dt.date)
    i_av = dates.index(first_av)
    assert all(v is None or pd.isna(v) for v in pa["psa_z"].iloc[:i_av])      # available_at 전에는 미사용
    assert pa["psa_z"].iloc[i_av] is not None and not pd.isna(pa["psa_z"].iloc[i_av])
    # pending 충격(마지막)은 어떤 날에도 psa_n_obs 에 안 들어감
    n_final = int((psa["status"] == "final").sum())
    assert int(pa["psa_n_obs"].max()) <= n_final
    # 상위 상태: 방향별 psa 증거
    up = res["upper"]
    assert up["ev_good_psa"].notna().any() and up["ev_bad_psa"].notna().any()


def test_reaction_components_and_kospi200_transmission_excluded():
    g3, tr, flow, br, semi, psa = _synth(3)
    r = _run(g3, tr, flow, br, semi, psa)["reaction"]
    assert r["err_signed_ewma"].notna().sum() > 100 and r["transmission_asym_z"].notna().sum() > 100
    assert r["good_beta"].notna().any() and r["bad_beta"].notna().any()
    # ERR 부호: 수익률 공간 잔차 그대로(err_obs = clip(err_z)); err_surprise_space = err_obs × sign(sox)
    m = r["err_obs"].notna()
    assert np.allclose(r.loc[m, "err_obs"], np.clip(r.loc[m, "gap_reaction_err_z"], -3, 3))
    assert np.allclose(r.loc[m, "err_surprise_space"], r.loc[m, "err_obs"] * r.loc[m, "err_sign"])
    # KOSPI200: transmission 은 진단 전용 → family 입력 아님
    g3k = g3.assign(scope="KOSPI200"); trk = tr.assign(scope="KOSPI200"); flk = flow.assign(scope="KOSPI200"); psak = psa.assign(scope="KOSPI200")
    rk = B.build_scope("KOSPI200", g3k, trk, flk, br, semi, psak)["reaction"]
    assert rk["transmission_asym_z"].isna().all()
    assert not any("transmission_asym_z" in c for c in rk["components_R"])


def test_mt_state_schema_write_read_and_shares(tmp_path):
    g3, tr, flow, br, semi, psa = _synth(4)
    res = _run(g3, tr, flow, br, semi, psa)
    mt = res["mt_state"]
    p = B.write_mt_state(mt, tmp_path / "mt_state.parquet")
    back = pq.read_table(p).to_pandas()
    assert list(back.columns) == list(B.MT_STATE_COLUMNS) and len(back) == len(mt)
    e = back["energy"].dropna()
    assert len(e) > 0 and e.between(-100, 100).all()
    # families_used ≥ 2 인 행만 energy 정의
    fu = back["families_used"].map(len)
    assert (back.loc[fu < 2, "energy"].isna()).all() and (back.loc[fu >= 2, "energy"].notna()).all()
    # share 합 = 1 (energy 정의 행), cap_applied 행은 max share ≤ 0.6+ε
    sh = back.loc[back["energy"].notna(), ["family_share_R", "family_share_PA", "family_share_P"]].astype(float)
    assert np.allclose(sh.fillna(0).sum(axis=1), 1.0)
    capped = back["cap_applied"].astype(bool)
    assert (sh[capped.loc[sh.index]].fillna(0).max(axis=1) <= 0.6 + 1e-9).all()
    # 상위 상태 필드
    assert set(back["good_status"].dropna()) <= {"ok", "insufficient"}
    assert back.loc[back["good_status"] == "insufficient", "good_acceptance"].isna().all()
    # 텍스트: regime 있는 행은 텍스트 있음, "{Regime} 유지|전환 (p%)" 로 시작
    has = back["regime_label"].notna()
    assert back.loc[has, "text"].str.match(r"^(Winter|Thaw|Spring|Cooling) (유지|전환) \(\d+%\)").all()
    ch = B.write_challengers(res["challengers"], tmp_path / "ch")
    assert set(ch) == set(B.CHALLENGER_FILES)
    fam = B.write_family_panels(res, tmp_path)
    assert set(fam) == {"reaction", "price_accept", "participation", "upper"}


def test_config_constants_match_modules():
    B.assert_config_matches(B.load_config())
    cfg = B.load_config()
    assert cfg["energy_family"]["weights"] == {"R": 0.40, "PA": 0.35, "P": 0.25}
    assert cfg["energy_family"]["transmission_component_scopes"] == list(cfg["transmission"]["scopes_component"])
    assert cfg["energy_family"]["constants"]["beta_asym_window_sessions"] == cfg["grade_c"]["constants"]["asym_window_days"]
    assert cfg["energy_family"]["constants"]["beta_asym_min_n"] == cfg["grade_c"]["constants"]["gb_beta_min_n"]
    assert list(cfg["energy_family"]["constants"]["beta_asym_clip"]) == list(cfg["grade_c"]["constants"]["gb_beta_clip"])
    assert cfg["upper_state"]["ewma_halflife_sessions"] == cfg["psa"]["constants"]["ewma_halflife_days"] == FA.EWMA_HALFLIFE_SESSIONS
    with pytest.raises(B.MtStateInputError):
        bad = dict(cfg); bad["energy_family"] = dict(cfg["energy_family"], cap_share=0.7)
        B.assert_config_matches(bad)
