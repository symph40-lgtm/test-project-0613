"""T5-5 family 점수·conf·freshness·EWMA (계획서 §3.1~3.3)."""
import pytest

from mtpro.state import families as FA


def test_family_score_clips_and_min_avail():
    r = FA.family_score({"err_signed_ewma": 5.0, "beta_asym_z": None, "transmission_asym_z": -1.0}, "R")
    assert r["clipped"]["err_signed_ewma"] == 3.0 and r["score"] == pytest.approx(1.0) and r["n_avail"] == 2
    assert r["components_used"] == ["err_signed_ewma", "transmission_asym_z"]
    # R 최소 1
    assert FA.family_score({"err_signed_ewma": None, "beta_asym_z": None, "transmission_asym_z": 0.5}, "R")["score"] == 0.5
    # PA 최소 2 (shock_absorption 예약 None)
    pa = FA.family_score({"shock_absorption_z": None, "gap_hold_z": 1.0, "close_acceptance_z": None, "psa_z": None}, "PA")
    assert pa["score"] is None and pa["n_avail"] == 1
    pa2 = FA.family_score({"shock_absorption_z": None, "gap_hold_z": 1.0, "close_acceptance_z": -1.0, "psa_z": None}, "PA")
    assert pa2["score"] == pytest.approx(0.0) and pa2["n_total"] == 4
    # P 최소 2
    assert FA.family_score({"flow_impact_residual_z": 1.0, "breadth_impulse_z": None, "semi_diffusion_z": None}, "P")["score"] is None
    with pytest.raises(FA.FamilyInputError):
        FA.family_score({"foo": 1.0}, "P")


def test_family_conf_and_freshness_rules():
    assert FA.family_conf(2, 4, None) == pytest.approx(0.5)
    assert FA.family_conf(2, 4, 0.5) == pytest.approx(0.25)
    assert FA.family_conf(0, 3, None) is None
    # 일별 컴포넌트 가용 → freshness 1
    fr, d = FA.family_freshness("PA", ["gap_hold_z", "psa_z"], {"psa_z": 30})
    assert fr == 1.0 and d == 0
    # 이벤트 기반만 가용 → 최근 관측 거리
    fr, d = FA.family_freshness("PA", ["psa_z"], {"psa_z": 10})
    assert fr == pytest.approx(0.5) and d == 10
    fr, d = FA.family_freshness("R", ["err_signed_ewma", "beta_asym_z"], {"err_signed_ewma": 20, "beta_asym_z": 20})
    assert fr == pytest.approx(0.25)
    assert FA.family_freshness("P", ["flow_impact_residual_z"], {}) == (1.0, 0)
    assert FA.family_freshness("R", [], {}) == (None, None)


def test_ewma_state_available_at_and_window():
    obs_pos = [0, 5, 10]
    obs_val = [1.0, 2.0, 3.0]
    s = FA.ewma_state(obs_pos, obs_val, 10)
    assert s["n_obs"] == 3 and s["dist_last"] == 0 and s["freshness"] == 1.0
    w0, w5, w10 = 0.5 ** (10 / 10), 0.5 ** (5 / 10), 1.0
    assert s["state"] == pytest.approx((w0 * 1 + w5 * 2 + w10 * 3) / (w0 + w5 + w10))
    # pos_t 이전 관측만 (미래 관측 미포함)
    s2 = FA.ewma_state(obs_pos, obs_val, 7)
    assert s2["n_obs"] == 2 and s2["dist_last"] == 2 and s2["freshness"] == pytest.approx(0.5 ** 0.2)
    # 창 밖(120 세션) 관측 제외
    s3 = FA.ewma_state([0], [1.0], 120)
    assert s3["state"] is None and s3["n_obs"] == 0
    s4 = FA.ewma_state([1], [1.0], 120)
    assert s4["state"] == 1.0
    assert FA.ewma_state([], [], 3)["state"] is None
