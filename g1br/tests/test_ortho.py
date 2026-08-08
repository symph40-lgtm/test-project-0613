# T2 — 롤링 직교화 테스트 (WORKORDER week2 §2, 코드보다 먼저 작성)
import numpy as np
import pandas as pd
import pytest

from src.ortho import rolling_orthogonalize


def make(n=300, seed=7):
    rng = np.random.default_rng(seed)
    idx = [f"D{i:04d}" for i in range(n)]
    x = pd.Series(rng.normal(0, 1, n), index=idx)
    y = 0.8 * x + pd.Series(rng.normal(0, 0.5, n), index=idx)  # y = 0.8x + noise
    return x, y


# ① 룩어헤드 주입: 미래 데이터를 바꿔도 과거 시점 잔차는 불변이어야 한다
def test_no_lookahead():
    x, y = make()
    r1 = rolling_orthogonalize(y, x, window=120)
    y2 = y.copy()
    y2.iloc[250:] += 100.0  # 미래 구간 오염
    x2 = x.copy()
    x2.iloc[250:] -= 50.0
    r2 = rolling_orthogonalize(y2, x2, window=120)
    pd.testing.assert_series_equal(r1.iloc[:250], r2.iloc[:250])


# ② 롤링 초기 window 구간은 NaN
def test_initial_nan():
    x, y = make()
    r = rolling_orthogonalize(y, x, window=120)
    assert r.iloc[:120].isna().all()
    assert r.iloc[121:].notna().all()


# ③ 직교화 잔차는 설명변수와 표본내 상관 ≈ 0 (추정 윈도 내 성질 — 적합 함수 직접 검증)
def test_residual_orthogonality_in_window():
    x, y = make()
    from src.ortho import _fit_beta
    a, b = _fit_beta(y.iloc[:120].values, x.iloc[:120].values)
    resid = y.iloc[:120].values - a - b * x.iloc[:120].values
    corr = np.corrcoef(resid, x.iloc[:120].values)[0, 1]
    assert abs(corr) < 1e-10
    assert abs(b - 0.8) < 0.15  # 참계수 회복


# ④ 시점 t 잔차는 t−1까지의 계수로 산출 — 계수에 t 데이터가 없음을 확인
def test_out_of_sample_residual():
    x, y = make()
    r = rolling_orthogonalize(y, x, window=120)
    # t=200의 잔차를 손으로 재현: [80,200) 윈도로 적합 → t=200에 적용
    from src.ortho import _fit_beta
    a, b = _fit_beta(y.iloc[80:200].values, x.iloc[80:200].values)
    expected = y.iloc[200] - a - b * x.iloc[200]
    assert abs(r.iloc[200] - expected) < 1e-12


# ⑤ 결측 전파: 윈도 내 결측 과다 시 NaN
def test_nan_handling():
    x, y = make()
    y.iloc[100:180] = np.nan
    r = rolling_orthogonalize(y, x, window=120, min_obs=100)
    assert pd.isna(r.iloc[181])  # 직전 윈도 유효 표본 부족
