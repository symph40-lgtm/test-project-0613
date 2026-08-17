"""A-6 검출 테스트 — Energy 컴포넌트에 None 처리가 없어 NaN 이 전파되던 결함 (+ Delta 미절단).

수정 방향(A-4 연동): None 컴포넌트 제외 → 가중치 재정규화 → 가용 컴포넌트 <3 이면 Energy 도 None.
검출 조건: 2개 None 입력에서 Energy 값 + available_components 필드 검증, 3개 None(가용 2)에서 None.
추가: delta_from_history 는 반드시 [-100,100] 으로 클립 (원 사양 결함: 미절단).
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from mtpro.core.errata import delta_from_history, energy

W = {"absorption": 0.25, "flow": 0.20, "breadth": 0.20, "good_accept": 0.17, "bad_resilience": 0.18}


def test_two_none_components_yield_value_and_available_list():
    comps = {"absorption": None, "flow": 1.0, "breadth": 0.5, "good_accept": None, "bad_resilience": -0.5}
    res = energy(comps, W, min_components=3)
    assert res["energy"] is not None
    assert isinstance(res["energy"], int)
    assert not (isinstance(res["energy"], float) and math.isnan(res["energy"]))
    assert res["available_components"] == ["flow", "breadth", "bad_resilience"]
    assert set(res["weights_used"]) == {"flow", "breadth", "bad_resilience"}
    assert sum(res["weights_used"].values()) == pytest.approx(1.0)
    # 재정규화 검증: flow 0.20/(0.20+0.20+0.18)
    assert res["weights_used"]["flow"] == pytest.approx(0.20 / 0.58)
    # 값 검증: tanh 가중합 ×100 정수
    expected = (math.tanh(1.0) * 0.20 + math.tanh(0.5) * 0.20 + math.tanh(-0.5) * 0.18) / 0.58 * 100
    assert res["energy"] == int(round(expected))
    assert -100 <= res["energy"] <= 100


def test_three_none_components_yield_none():
    comps = {"absorption": None, "flow": 1.0, "breadth": None, "good_accept": None, "bad_resilience": -0.5}
    res = energy(comps, W, min_components=3)
    assert res["energy"] is None
    assert res["available_components"] == ["flow", "bad_resilience"]
    assert res["weights_used"] == {}


def test_all_available_matches_original_weights():
    comps = {"absorption": 0.3, "flow": -0.2, "breadth": 0.1, "good_accept": 0.0, "bad_resilience": 0.4}
    res = energy(comps, W)
    assert res["weights_used"] == pytest.approx(W)
    assert res["available_components"] == list(W)
    assert res["energy"] is not None


def test_nan_component_treated_as_missing_not_propagated():
    comps = {"absorption": float("nan"), "flow": 1.0, "breadth": 0.5, "good_accept": 0.2, "bad_resilience": -0.5}
    res = energy(comps, W)
    assert res["energy"] is not None
    assert "absorption" not in res["available_components"]


def test_energy_clipped_to_pm100():
    comps = {k: 50.0 for k in W}  # tanh→1 → 100
    assert energy(comps, W)["energy"] == 100
    comps = {k: -50.0 for k in W}
    assert energy(comps, W)["energy"] == -100


def test_all_none_returns_none():
    res = energy({k: None for k in W}, W)
    assert res["energy"] is None and res["available_components"] == []


def test_component_without_weight_rejected():
    with pytest.raises(ValueError):
        energy({"absorption": 0.1, "flow": 0.2, "breadth": 0.3, "mystery": 0.4}, W)


# ---- delta_from_history ----------------------------------------------------

def test_delta_clipped_to_pm100_on_extreme_trend():
    # 오래 정체하다 마지막 5일 급등 → 원 사양 공식은 100 을 훨씬 넘김. 반드시 클립.
    hist = [0] * 55 + [0, 25, 50, 75, 100]
    d = delta_from_history(hist)
    assert d is not None and isinstance(d, int)
    assert d == 100
    d2 = delta_from_history([0] * 55 + [0, -25, -50, -75, -100])
    assert d2 == -100


def test_delta_sign_follows_recent_slope():
    rng = np.random.default_rng(0)
    base = [int(x) for x in rng.integers(-5, 6, 55)]
    up = delta_from_history(base + [0, 5, 10, 15, 20])
    down = delta_from_history(base + [20, 15, 10, 5, 0])
    assert up is not None and down is not None
    assert up > 0 > down


def test_delta_flat_history_is_zero_not_nan():
    d = delta_from_history([10] * 60)
    assert d == 0


def test_delta_insufficient_history_returns_none():
    assert delta_from_history([]) is None
    assert delta_from_history([1, 2, 3, 4]) is None  # recent 5 미달
    assert delta_from_history([1, 2, 3, 4, 5]) is None  # 이력 변화량 표본 부족


def test_delta_none_in_recent_window_returns_none():
    hist = [0] * 55 + [0, 5, None, 15, 20]
    assert delta_from_history(hist) is None


def test_delta_always_within_bounds_random():
    rng = np.random.default_rng(1)
    for _ in range(50):
        n = int(rng.integers(6, 80))
        hist = [int(x) for x in rng.integers(-100, 101, n)]
        d = delta_from_history(hist)
        assert d is None or -100 <= d <= 100
