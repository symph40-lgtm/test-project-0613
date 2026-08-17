"""T5-5 Energy family 결합·cap 알고리즘 (계획서 §3.5·§12.2)."""
import inspect
import math

import pytest

from mtpro.state import energy as EN


def test_cap_example_0_99_0_01_0_goes_to_4b_and_discards_residual():
    """§12.2 예: c=(0.99, 0.01, 0) → 1차 cap 후 2번 family 0.985(share .98) → 4b cap·잔여 폐기."""
    r = EN.apply_cap({"R": 0.99, "PA": 0.01, "P": 0.0})
    assert r["cap_applied"] and r["cap_family"] == "R"
    # 1차: R ← 1.5·0.01 = 0.015, excess 0.975 → PA ← 0.01·(1+0.975/0.01) = 0.985, P 0
    # 4b: PA share .985 > .6 → PA ← 1.5·(0.015+0) = 0.0225, 잔여 폐기
    assert r["recap_family"] == "PA"
    assert r["contribs"]["R"] == pytest.approx(0.015)
    assert r["contribs"]["PA"] == pytest.approx(0.0225)
    assert r["contribs"]["P"] == pytest.approx(0.0)
    assert r["excess_discarded"] == pytest.approx(0.985 - 0.0225)
    assert r["shares"]["PA"] == pytest.approx(0.6)
    assert not r["cap_undefined"]


def test_cap_single_pass_makes_share_exactly_0_6_and_redistributes_once():
    r = EN.apply_cap({"R": 0.8, "PA": 0.15, "P": 0.05})
    assert r["cap_applied"] and r["cap_family"] == "R" and r["recap_family"] is None
    # cap 값 = 1.5·Σ_others = 1.5·0.2 = 0.3 (재배분 전 share 정확히 0.6)
    assert r["contribs"]["R"] == pytest.approx(0.3)
    # 초과분 0.8 − 0.3 = 0.5 를 |c| 비례로 재배분: PA 0.15·(1+0.5/0.2)=0.525, P 0.05·3.5=0.175 → 절대 기여 합 보존
    assert r["contribs"]["PA"] == pytest.approx(0.525) and r["contribs"]["P"] == pytest.approx(0.175)
    assert sum(abs(v) for v in r["contribs"].values()) == pytest.approx(1.0)
    assert r["shares"]["R"] == pytest.approx(0.3)   # 재배분 후 share (출력 필드 = 최종 share)


def test_cap_keeps_sign_and_uses_absolute_share():
    r = EN.apply_cap({"R": -0.9, "PA": 0.05, "P": 0.05})
    # cap 값 = −1.5·0.1 = −0.15 (부호 유지), 초과 0.75 재배분 → PA=P=0.425 → 최종 share R .15 (재cap 없음)
    assert r["contribs"]["R"] == pytest.approx(-0.15) and r["shares"]["R"] == pytest.approx(0.15)
    assert r["contribs"]["PA"] == pytest.approx(0.425) and r["recap_family"] is None


def test_cap_undefined_when_other_families_zero():
    r = EN.apply_cap({"R": 0.5, "PA": 0.0})
    assert r["cap_undefined"] and not r["cap_applied"] and r["contribs"]["R"] == 0.5


def test_no_cap_when_share_at_or_below_0_6():
    r = EN.apply_cap({"R": 0.6, "PA": 0.4})
    assert not r["cap_applied"] and r["contribs"] == {"R": 0.6, "PA": 0.4}


def test_two_families_always_checks_larger_side():
    r = EN.combine_families({"R": 2.0, "PA": 0.1, "P": None}, {"R": 1, "PA": 1, "P": None})
    assert r["families_used"] == ["R", "PA"] and r["cap_applied"] and r["cap_family"] == "R"
    # 재배분 후 PA 가 .6 초과 → 4b 재cap → 최종 share PA .6 / R .4 (2 family 극단 케이스, 잔여 폐기)
    assert r["shares"]["PA"] == pytest.approx(0.6) and r["shares"]["R"] == pytest.approx(0.4) and r["shares"]["P"] is None
    assert max(v for v in r["shares"].values() if v is not None) <= 0.6 + 1e-12


def test_min_two_families_else_none():
    r = EN.combine_families({"R": 1.0, "PA": None, "P": None}, {"R": 1, "PA": None, "P": None})
    assert r["energy"] is None and r["families_used"] == ["R"] and r["energy_confidence"] is None


def test_energy_formula_and_confidence_renormalized():
    r = EN.combine_families({"R": 0.5, "PA": 0.5, "P": 0.5}, {"R": 1.0, "PA": 0.5, "P": 0.0})
    # 균등 s → c 합 = 0.5, share 각 .40/.35/.25 (cap 없음)
    assert r["energy"] == round(100 * math.tanh(0.5)) and not r["cap_applied"]
    assert r["energy_confidence"] == pytest.approx(0.40 * 1.0 + 0.35 * 0.5)
    r2 = EN.combine_families({"R": 0.5, "PA": None, "P": 0.5}, {"R": 1.0, "PA": None, "P": 0.0})
    assert r2["weights_used"]["R"] == pytest.approx(0.40 / 0.65)
    assert r2["energy_confidence"] == pytest.approx(0.40 / 0.65)


def test_energy_signature_has_no_upper_state_or_divergence_argument():
    """§5·§6: 상위 상태·Divergence 는 Energy 입력이 아니다 — 시그니처로 고정."""
    params = set(inspect.signature(EN.combine_families).parameters)
    for forbidden in ("good_acceptance", "bad_resilience", "divergence", "upper_state", "regime"):
        assert not any(forbidden in p for p in params), params
    assert not any("divergence" in p or "regime" in p for p in inspect.signature(EN.apply_cap).parameters)


def test_challengers_eq_and_nocap():
    s = {"R": 3.0, "PA": 0.1, "P": 0.1}
    c = {"R": 1, "PA": 1, "P": 1}
    champ = EN.combine_families(s, c)
    eq = EN.combine_families(s, c, weights=EN.EQ_WEIGHTS)
    nocap = EN.combine_families(s, c, cap=False)
    assert champ["cap_applied"] and not nocap["cap_applied"]
    assert nocap["energy"] == round(100 * math.tanh(0.40 * 3 + 0.35 * 0.1 + 0.25 * 0.1))
    assert eq["weights_used"]["R"] == pytest.approx(1 / 3)


def test_orthogonalize_returns_none_until_min_samples_and_keeps_first():
    import numpy as np
    rng = np.random.default_rng(0)
    n = 400
    R = list(rng.normal(0, 1, n))
    P = [0.8 * r + e for r, e in zip(R, rng.normal(0, 0.5, n))]
    PA = [0.3 * r + 0.2 * p + e for r, p, e in zip(R, P, rng.normal(0, 0.3, n))]
    o = EN.orthogonalize_scores({"R": R, "P": P, "PA": PA})
    assert o["R"] == R
    assert all(v is None for v in o["P"][:EN.Z_MIN_SAMPLES]) and o["P"][EN.Z_MIN_SAMPLES] is not None
    # P' 는 R 과 거의 무상관 (잔차); 원 P 는 강상관
    pp = np.array(o["P"][200:]); rr = np.array(R[200:])
    assert abs(np.corrcoef(pp, rr)[0, 1]) < 0.15 < abs(np.corrcoef(np.array(P[200:]), rr)[0, 1])
    # 미래 변조 → 과거 불변
    P2 = list(P); P2[300:] = [9.0] * (n - 300)
    o2 = EN.orthogonalize_scores({"R": R, "P": P2, "PA": PA})
    assert o["P"][:300] == o2["P"][:300] and o["PA"][:300] == o2["PA"][:300]
