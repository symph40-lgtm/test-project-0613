"""A-4 검출 테스트 — good/bad 표본 <2 일 때 asymmetry=0.0 을 반환해 "중립"과 "모름"을 구분 못 하던 결함.

수정 방향: 표본 부족 시 값 None + status "insufficient" (0.0 반환 금지). EWMA(반감기 15) 사용.
검출 조건: 표본 0 → None, 표본 1 → None, 표본 2 → 값.
"""
from __future__ import annotations

import math

import pytest

from mtpro.core.errata import asymmetry, ewma_mean


def test_zero_samples_returns_none_not_zero():
    res = asymmetry([], [])
    assert res["good_acceptance_z"] is None
    assert res["bad_resilience_z"] is None
    assert res["good_status"] == "insufficient"
    assert res["bad_status"] == "insufficient"
    assert res["good_n"] == 0 and res["bad_n"] == 0
    # 0.0 반환 금지 명시 검증 (None 은 0.0 과 다르다)
    assert not (isinstance(res["good_acceptance_z"], float) and res["good_acceptance_z"] == 0.0)


def test_one_sample_returns_none():
    res = asymmetry([1.2], [-0.4])
    assert res["good_acceptance_z"] is None and res["good_status"] == "insufficient"
    assert res["bad_resilience_z"] is None and res["bad_status"] == "insufficient"
    assert res["good_n"] == 1 and res["bad_n"] == 1


def test_two_samples_returns_value():
    res = asymmetry([1.0, 2.0], [-1.0, -3.0])
    assert isinstance(res["good_acceptance_z"], float)
    assert isinstance(res["bad_resilience_z"], float)
    assert res["good_status"] == "ok" and res["bad_status"] == "ok"
    assert not math.isnan(res["good_acceptance_z"])


def test_mixed_sufficiency_is_independent():
    res = asymmetry([1.0, 2.0, 3.0], [-0.5])
    assert res["good_status"] == "ok" and res["good_acceptance_z"] is not None
    assert res["bad_status"] == "insufficient" and res["bad_resilience_z"] is None


def test_ewma_halflife_15_weights_recent_more():
    # 최신값(마지막)이 더 큰 가중치: 반감기 15 → w = 0.5**(age/15)
    vals = [0.0, 0.0, 10.0]
    w = [0.5 ** (2 / 15), 0.5 ** (1 / 15), 1.0]
    expected = sum(v * wi for v, wi in zip(vals, w)) / sum(w)
    assert ewma_mean(vals, halflife=15) == pytest.approx(expected)
    assert ewma_mean(vals, halflife=15) > sum(vals) / 3  # 단순 평균보다 최신값 쪽으로 기움
    res = asymmetry(vals, [-1.0, -1.0], halflife=15)
    assert res["good_acceptance_z"] == pytest.approx(expected)
    assert res["bad_resilience_z"] == pytest.approx(-1.0)


def test_neutral_zero_is_distinguishable_from_unknown():
    # 표본이 충분한데 실제로 평균 0 → 0.0 (중립), 표본 부족 → None (모름)
    neutral = asymmetry([0.5, -0.5], [0.0, 0.0])
    assert neutral["good_acceptance_z"] is not None and neutral["good_status"] == "ok"
    assert neutral["bad_resilience_z"] == pytest.approx(0.0)  # 진짜 중립 0.0 은 값으로 남는다
    assert neutral["bad_status"] == "ok"
    unknown = asymmetry([], [])
    assert unknown["bad_resilience_z"] is None


def test_min_n_configurable():
    res = asymmetry([1.0, 2.0], [], min_n=3)
    assert res["good_status"] == "insufficient" and res["good_acceptance_z"] is None


def test_none_and_nan_samples_are_excluded():
    res = asymmetry([1.0, None, float("nan"), 2.0], [None])
    assert res["good_n"] == 2 and res["good_status"] == "ok"
    assert res["bad_n"] == 0 and res["bad_resilience_z"] is None
