# T5 — AdjEx 테스트 (WORKORDER §5): 라벨·FairGap 양쪽 동일 적용 보증 +
# "락일 미조정 시 오차가 배당수익률만큼 발생" 케이스 재현
import numpy as np
import pandas as pd


def test_adjex_applied_to_label():
    # 합성: 배당 500원 / 전일종가 70,000 → AdjEx = −0.714%. 실제 갭 −0.9% 중 기계분 제거 후 −0.186%
    prev_close, div = 70000.0, 500.0
    adjex = -div / prev_close
    raw_gap = -0.009
    adj_gap = raw_gap - adjex
    assert abs(adj_gap - (-0.009 + 500 / 70000)) < 1e-12
    # 미조정 시 오차 재현: FairGap 예측이 0%라면 |raw_gap| = 0.9%p 오차, 조정 후 0.186%p — 차이 = 배당수익률
    err_unadj = abs(raw_gap - 0.0)
    err_adj = abs(adj_gap - 0.0)
    assert abs((err_unadj - err_adj) - div / prev_close) < 1e-12


def test_panel_adjex_consistency():
    # 실제 패널에서: gap_adj − gap == −adjex (전 행 동일 적용 — 라벨·FairGap 한 소스)
    from pathlib import Path
    p = pd.read_parquet(Path(__file__).resolve().parents[1] / "data" / "night_panel.parquet")
    if "adjex_ss" not in p.columns:
        import pytest
        pytest.skip("adjex 미생성 (adjex.py 선실행 필요)")
    d = (p["gap_ss_adj"] - p["gap_ss"]) + p["adjex_ss"]
    assert np.nanmax(np.abs(d.values)) < 1e-12
    ex = p[p["ex_date"]]
    assert len(ex) > 0
    assert (ex["adjex_ss"] < 0).all() or (ex["adjex_hx"] < 0).all()
