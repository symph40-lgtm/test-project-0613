"""A-2 검출 테스트 — regime 조건 전부 불충족 시 확률합 0 → `total or 0.01` 나눗셈으로 확률이 전부 0(합≠1)이던 결함.

수정 방향: fallback = 직전 regime 확률 유지 + confidence 감점 플래그, 직전 없으면 uniform(0.25) 명시.
검출 조건: 전 조건 미충족 입력에서 확률합 == 1.0, NaN 없음.
"""
from __future__ import annotations

import math

import pytest

from mtpro.core.errata import REGIMES, classify_regime

# 어떤 조건에도 걸리지 않는 입력: energy=0(winter<-20 X, spring>30 X, cooling>20 X), delta=0(thaw>15 X, cooling<-15 X)
NO_MATCH = dict(energy=0, delta=0, bad_resilience_z=0.0, breadth_impulse_z=0.0)


def _assert_valid_probs(probs: dict[str, float]) -> None:
    assert set(probs) == set(REGIMES)
    assert all(not math.isnan(v) for v in probs.values())
    assert all(0.0 <= v <= 1.0 for v in probs.values())
    assert math.isclose(sum(probs.values()), 1.0, rel_tol=0, abs_tol=1e-12)


def test_no_condition_met_without_prev_is_uniform():
    res = classify_regime(**NO_MATCH, prev_probs=None)
    _assert_valid_probs(res.probs)
    assert sum(res.probs.values()) == 1.0  # 0.25*4 는 부동소수에서도 정확히 1.0
    assert all(v == 0.25 for v in res.probs.values())
    assert res.fallback == "uniform"
    assert res.confidence_penalty > 0


def test_no_condition_met_with_prev_keeps_prev_and_flags_penalty():
    prev = {"winter": 0.6, "thaw": 0.3, "spring": 0.1, "cooling": 0.0}
    res = classify_regime(**NO_MATCH, prev_probs=prev)
    _assert_valid_probs(res.probs)
    assert res.probs == pytest.approx(prev)
    assert res.fallback == "prev_regime"
    assert res.confidence_penalty > 0


def test_condition_met_normal_path_no_penalty():
    res = classify_regime(energy=-40, delta=0, bad_resilience_z=-0.5, breadth_impulse_z=0.0, prev_probs=None)
    _assert_valid_probs(res.probs)
    assert res.probs["winter"] == 1.0
    assert res.fallback == "none"
    assert res.confidence_penalty == 0


def test_multiple_conditions_normalize_to_one():
    # spring(0.5) + cooling(0.4): energy>30, breadth>0, delta<-15
    res = classify_regime(energy=40, delta=-20, bad_resilience_z=0.0, breadth_impulse_z=0.5, prev_probs=None)
    _assert_valid_probs(res.probs)
    assert res.probs["spring"] == pytest.approx(0.5 / 0.9)
    assert res.probs["cooling"] == pytest.approx(0.4 / 0.9)


def test_none_inputs_do_not_produce_nan():
    # 결측(None)은 조건 미충족으로 취급 → fallback, NaN 금지
    res = classify_regime(energy=None, delta=None, bad_resilience_z=None, breadth_impulse_z=None, prev_probs=None)
    _assert_valid_probs(res.probs)
    assert res.fallback == "uniform"


def test_no_sticky_bonus_in_classification():
    """sticky 가점은 A-3(전환 임계)로 이관 — 분류 단계에서 prev 가 점수를 올려선 안 된다."""
    prev = {"winter": 1.0, "thaw": 0.0, "spring": 0.0, "cooling": 0.0}
    res = classify_regime(energy=40, delta=0, bad_resilience_z=0.0, breadth_impulse_z=0.5, prev_probs=prev)
    assert res.probs["spring"] == 1.0
    assert res.probs["winter"] == 0.0


def test_invalid_prev_probs_rejected():
    with pytest.raises(ValueError):
        classify_regime(**NO_MATCH, prev_probs={"winter": 0.0, "thaw": 0.0, "spring": 0.0, "cooling": 0.0})
    with pytest.raises(ValueError):
        classify_regime(**NO_MATCH, prev_probs={"winter": float("nan"), "thaw": 0.5, "spring": 0.5, "cooling": 0.0})
