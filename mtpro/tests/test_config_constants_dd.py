"""D-D (2026-08-17 승인): config 승격 상수 = 모듈 사전 등록값. 어느 한쪽만 바꾸면 실패한다 (조용한 수정 방지)."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
import yaml
from mtpro.components import flow, breadth, gradec

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))

def test_flow_constants():
    c = CFG["flow"]["constants"]
    assert (c["mean_tv_days"], c["beta_window_days"], c["beta_min_obs"]) == (flow.MEAN_TV_DAYS, flow.BETA_WINDOW_DAYS, flow.BETA_MIN_OBS)
    assert (c["resid_z_window_days"], c["resid_z_min_obs"]) == (flow.RESID_Z_WINDOW_DAYS, flow.RESID_Z_MIN_OBS)
    assert (c["trend_days"], c["trend_ref_window_days"], c["trend_ref_min_obs"], c["beta_extreme_abs"]) == (
        flow.TREND_DAYS, flow.TREND_REF_WINDOW_DAYS, flow.TREND_REF_MIN_OBS, flow.BETA_EXTREME_ABS)

def test_breadth_constants_and_tier_overflow():
    c = CFG["breadth"]["constants"]
    assert (c["ma_short_days"], c["ma_long_days"], c["high_low_window_days"]) == (breadth.MA_SHORT_DAYS, breadth.MA_LONG_DAYS, breadth.HIGH_LOW_WINDOW_DAYS)
    assert (c["impulse_recent_days"], c["impulse_prior_days"], c["impulse_z_window_days"], c["impulse_z_min_samples"]) == (
        breadth.IMPULSE_RECENT_DAYS, breadth.IMPULSE_PRIOR_DAYS, breadth.IMPULSE_Z_WINDOW_DAYS, breadth.IMPULSE_Z_MIN_SAMPLES)
    assert c["leadership_large_only"] == breadth.LEADERSHIP_LARGE_ONLY and c["leadership_broad"] == breadth.LEADERSHIP_BROAD
    # D-C: 초과 순위(201)는 순위 기준 마지막 분위(small)
    tiers = {k: tuple(v) for k, v in CFG["breadth"]["tiers"].items()}
    assert breadth._tier_of(201, tiers) == "small" and breadth._tier_of(200, tiers) == "small" and breadth._tier_of(150, tiers) == "mid"
    assert breadth._tier_of(None, tiers) is None

def test_gradec_constants():
    c = CFG["grade_c"]["constants"]; p = gradec.GradeCParams()
    assert (c["beta_min_samples"], tuple(c["beta_clip"]), c["expected_std_floor"], c["expected_std_min_samples"]) == (
        p.beta_min_samples, p.beta_clip, p.expected_std_floor, p.expected_std_min_samples)
    assert (c["asym_window_days"], c["asym_min_n"], c["asym_halflife"], tuple(c["gb_beta_clip"]), c["gb_beta_min_n"], c["max_stale_calendar_days"]) == (
        p.asym_window_days, p.asym_min_n, p.asym_halflife, p.gb_beta_clip, p.gb_beta_min_n, p.max_stale_calendar_days)
    assert CFG["grade_c"]["reaction_basis"] == p.reaction_basis == "open_to_close"
    assert (CFG["grade_c"]["beta_window_days"], CFG["grade_c"]["min_justified_abs_pct"], CFG["grade_c"]["err_z_window_days"]) == (
        p.beta_window_days, p.min_justified_abs_pct, p.err_z_window_days)
