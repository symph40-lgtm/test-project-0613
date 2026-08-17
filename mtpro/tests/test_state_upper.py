"""T5-5 상위 상태 Good Acceptance / Bad Resilience (계획서 §5)."""
import inspect
import math

import pytest

from mtpro.state import upper_state as US
from mtpro.state.families import Z_MIN_SAMPLES


def _ev(state, n_obs=1, dist=0):
    return {"state": state, "n_obs": n_obs, "dist_last": dist}


def test_single_evidence_err_plus_80_is_insufficient_but_conf_le_17():
    """§5 예: 증거 1개(ERR)만 +80 → conf ≈ 100×(1/6)×1×f ≤ 17, score None + insufficient."""
    ev = {"good_err": _ev(math.atanh(0.8), n_obs=3, dist=0)}
    r = US.state_from_evidence(ev, US.GOOD_EVIDENCE)
    assert r["score"] is None and r["status"] == "insufficient"
    assert r["state_confidence"] is not None and r["state_confidence"] <= 17
    assert r["available_evidence"] == ["good_err"] and r["evidence_n"] == 3
    # 관측이 오래되면 더 낮다
    r2 = US.state_from_evidence({"good_err": _ev(math.atanh(0.8), n_obs=3, dist=10)}, US.GOOD_EVIDENCE)
    assert r2["state_confidence"] <= r["state_confidence"] / 2 + 1


def test_four_agreeing_evidence_plus_80_conf_le_67():
    """§5 예: ERR+Shock+Gap+Flow 4개 일치 +80 → ≈ 100×(4/6)×1×f ≤ 67."""
    z = math.atanh(0.8)
    ev = {k: _ev(z, n_obs=2, dist=0) for k in ("good_err", "good_shock", "good_gap", "good_flow")}
    r = US.state_from_evidence(ev, US.GOOD_EVIDENCE)
    assert r["status"] == "ok" and r["score"] == 80
    assert r["state_confidence"] == 67 and r["evidence_n"] == 8
    assert r["available_evidence"] == ["good_err", "good_shock", "good_gap", "good_flow"]


def test_disagreement_lowers_confidence():
    ev = {"good_err": _ev(1.0), "good_gap": _ev(1.0), "good_flow": _ev(-0.5), "good_psa": _ev(-0.2)}
    r = US.state_from_evidence(ev, US.GOOD_EVIDENCE)
    assert r["status"] == "ok" and r["agreement"] == pytest.approx(0.5)
    assert r["state_confidence"] == round(100 * (4 / 6) * 0.75)


def test_none_evidence_excluded_and_reserved_shock_is_none():
    ev = {"good_err": _ev(0.5), "good_shock": _ev(None), "good_beta": _ev(float("nan"))}
    r = US.state_from_evidence(ev, US.GOOD_EVIDENCE)
    assert r["available_evidence"] == ["good_err"] and r["status"] == "insufficient"


def test_beta_deviation_z_centers_at_neutral_one():
    vals = [1.0 + 0.1 * ((i % 5) - 2) for i in range(Z_MIN_SAMPLES + 5)]   # std ≈ 0.14, 평균 1
    i = len(vals) - 1
    vals[i] = 1.28
    g = US.beta_deviation_z(vals, i, +1.0)
    b = US.beta_deviation_z(vals, i, -1.0)
    assert g is not None and g > 0 and b == pytest.approx(-g)
    assert US.beta_deviation_z(vals, Z_MIN_SAMPLES - 1, +1.0) is None   # 표본 부족


def test_upper_state_signature_is_not_an_energy_input():
    """상위 상태 모듈은 Energy 를 만들지 않고, Energy 함수는 상위 상태를 받지 않는다."""
    from mtpro.state import energy as EN
    assert "energy" not in {n.lower() for n in dir(US) if not n.startswith("_") and callable(getattr(US, n))}
    assert not any(k in inspect.signature(EN.combine_families).parameters for k in ("good_acceptance", "bad_resilience"))
