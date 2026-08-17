"""A-1 검출 테스트 — expected_std 가 사실상 상수(≈0.5)라서 std(ERR_z) ∈ [0.7,1.3] 검증이 무의미했던 결함.

수정 방향: expected_std = 이벤트 유형별 회귀 잔차의 rolling std (하한 floor 만 상수).
검출 조건: (1) 유형별 std 가 실제로 다르다 (2) 상수 0.5 가 아니다
          (3) 잘못된 std(상수/타 유형)를 쓰면 검증이 **실패**하고, 올바른 rolling std 를 쓰면 통과한다.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from mtpro.core.errata import err_z_std_check, expected_std_rolling


def _residuals(scale: float, n: int = 40, seed: int = 0) -> list[float]:
    rng = np.random.default_rng(seed)
    return [float(x) for x in rng.normal(0.0, scale, n)]


@pytest.fixture
def residuals_by_type() -> dict[str, list[float]]:
    # 저분산 유형(CPI: σ≈0.3) vs 고분산 유형(earnings: σ≈3.0)
    return {"CPI": _residuals(0.3, seed=1), "earnings": _residuals(3.0, seed=2)}


def test_std_differs_by_event_type_and_is_not_constant(residuals_by_type):
    s_cpi = expected_std_rolling(residuals_by_type, "CPI")
    s_earn = expected_std_rolling(residuals_by_type, "earnings")
    assert s_cpi is not None and s_earn is not None
    assert s_cpi != s_earn
    assert s_earn > 3 * s_cpi  # 고분산 유형은 뚜렷이 커야 한다
    assert not math.isclose(s_cpi, 0.5, abs_tol=0.05)
    assert not math.isclose(s_earn, 0.5, abs_tol=0.05)


def test_uses_rolling_window_only():
    # 앞 30개는 큰 분산, 뒤 20개는 작은 분산 → window=20 이면 작은 쪽만 반영
    hist = _residuals(5.0, n=30, seed=3) + _residuals(0.2, n=20, seed=4)
    s = expected_std_rolling({"X": hist}, "X", window=20)
    assert s is not None
    assert s < 0.5  # 5.0 스케일이 섞였다면 이럴 수 없다


def test_floor_is_only_constant():
    tiny = [0.001, -0.001, 0.0005, -0.0005]
    assert expected_std_rolling({"X": tiny}, "X", floor=0.1) == pytest.approx(0.1)


def test_insufficient_samples_returns_none():
    assert expected_std_rolling({"X": [0.1, 0.2]}, "X") is None
    assert expected_std_rolling({"X": []}, "X") is None
    assert expected_std_rolling({}, "X") is None


def test_err_z_validation_can_actually_fail(residuals_by_type):
    """핵심 검출: 상수 0.5 를 쓰면 고분산 유형에서 std(ERR_z) 검증이 실패해야 한다.

    원 사양은 expected_std≈0.5 상수 → 어떤 유형이든 검증 통과/실패가 데이터와 무관.
    수정 후에는 (a) 상수 사용 시 실패, (b) 유형별 rolling std 사용 시 통과 를 모두 보인다.
    """
    errs = residuals_by_type["earnings"]  # 실제 - 기대 (err_pct), σ≈3.0

    # (a) 결함 재현: 상수 0.5 → err_z std ≈ 6 → 검증 실패
    z_const = [e / 0.5 for e in errs]
    assert err_z_std_check(z_const) is False

    # (a') 타 유형(CPI)의 std 를 잘못 적용해도 실패
    s_wrong = expected_std_rolling(residuals_by_type, "CPI")
    z_wrong = [e / s_wrong for e in errs]
    assert err_z_std_check(z_wrong) is False

    # (b) 올바른 유형의 rolling std → 통과
    s_right = expected_std_rolling(residuals_by_type, "earnings", window=len(errs))
    z_right = [e / s_right for e in errs]
    assert err_z_std_check(z_right) is True


def test_err_z_std_check_bounds():
    rng = np.random.default_rng(7)
    ok = list(rng.normal(0, 1.0, 200))
    too_wide = list(rng.normal(0, 2.0, 200))
    too_narrow = list(rng.normal(0, 0.3, 200))
    assert err_z_std_check(ok) is True
    assert err_z_std_check(too_wide) is False
    assert err_z_std_check(too_narrow) is False
    assert err_z_std_check([0.1, 0.2]) is None  # 표본 부족은 판정 보류(None), True/False 아님
