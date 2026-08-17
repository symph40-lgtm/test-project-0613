"""과거 전용 롤링 통계 (T5-2 공용) — 계획서 §12.4 통일 규정.

    모든 "z(120일)" = **t−1까지의 과거 전용 창(당일 제외), 표본 < 60 → None**, 클립 ±3(§3 공통).

여기 함수는 리스트 인덱스 i 를 "당일 t"로 보고 ``values[i-window : i]`` (t 미포함) 만 본다. 결측(None/NaN)은 표본에서 제외하며
0 으로 대체하지 않는다. 창 안 유효 표본이 min_samples 미만이거나 std 가 0 이면 None.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np


def is_finite(v) -> bool:
    if v is None:
        return False
    try:
        return bool(np.isfinite(float(v)))
    except (TypeError, ValueError):
        return False


def past_window(values: Sequence[Optional[float]], i: int, window: int) -> list[float]:
    """values[max(0, i−window) : i] 의 유효값 (t−1까지 window 행, t 미포함)."""
    if window < 1:
        raise ValueError("window must be >= 1")
    lo = max(0, i - window)
    return [float(values[k]) for k in range(lo, i) if is_finite(values[k])]


def past_std(values: Sequence[Optional[float]], i: int, window: int, min_samples: int, floor: Optional[float] = None) -> Optional[float]:
    """과거 창 표본 std(ddof=1). 표본 < min_samples → None. floor 가 있으면 max(std, floor)."""
    past = past_window(values, i, window)
    if len(past) < max(min_samples, 2):
        return None
    sd = float(np.std(np.asarray(past, dtype=float), ddof=1))
    if not np.isfinite(sd):
        return None
    if floor is not None:
        sd = max(sd, float(floor))
    return sd


def past_z(values: Sequence[Optional[float]], i: int, window: int, min_samples: int, clip_abs: Optional[float] = 3.0) -> Optional[float]:
    """values[i] 를 values[i−window..i−1] 유효 표본의 평균·std 로 z. 당일 None / 표본 부족 / std 0 → None. clip_abs 로 ±클립."""
    x = values[i]
    if not is_finite(x):
        return None
    past = past_window(values, i, window)
    if len(past) < max(min_samples, 2):
        return None
    arr = np.asarray(past, dtype=float)
    sd = float(np.std(arr, ddof=1))
    if not np.isfinite(sd) or sd <= 0:
        return None
    z = (float(x) - float(arr.mean())) / sd
    if clip_abs is not None:
        z = float(min(clip_abs, max(-clip_abs, z)))
    return float(z)


def clip(v: Optional[float], lo: float, hi: float) -> Optional[float]:
    return None if not is_finite(v) else float(min(hi, max(lo, float(v))))
