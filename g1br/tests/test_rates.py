# T1 — bp 변환 단위 테스트 (WORKORDER week2 §1-1)
import pandas as pd

from src.rates import PCT_TO_BP, TNX_INDEX_TO_BP, daily_bp_change


def test_tnx_index_to_bp():
    # ^TNX 46.17 → 46.60: 지수 +0.43 = 수익률 4.617%→4.660% = +4.3bp
    s = pd.Series([46.17, 46.60], index=["2026-08-06", "2026-08-07"])
    bp = daily_bp_change(s, TNX_INDEX_TO_BP)
    assert abs(bp.iloc[1] - 4.3) < 1e-9


def test_yield_futures_to_bp():
    # 2YY=F 4.15 → 4.17: +0.02%p = +2bp
    s = pd.Series([4.15, 4.17], index=["2026-08-06", "2026-08-07"])
    bp = daily_bp_change(s, PCT_TO_BP)
    assert abs(bp.iloc[1] - 2.0) < 1e-9


def test_fred_pct_to_bp():
    s = pd.Series([4.62, 4.53], index=["2026-08-05", "2026-08-06"])
    bp = daily_bp_change(s, PCT_TO_BP)
    assert abs(bp.iloc[1] - (-9.0)) < 1e-9


def test_first_obs_is_nan():
    s = pd.Series([4.15, 4.17], index=["2026-08-06", "2026-08-07"])
    assert pd.isna(daily_bp_change(s, PCT_TO_BP).iloc[0])
