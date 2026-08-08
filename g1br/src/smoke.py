# T4 — 배관 스모크 테스트 (WORKORDER §5). 모델링이 아니다.
# 회귀 2건만: I0 (KOSPI200 gap ~ r_SPX), S0 (하닉 고유 gap ~ soxx_ex).
# ⚠ soxx_ex·β_mkt는 전기간 일괄 추정 — **스모크 한정 허용** (본 구현은 롤링 120일, 2주차 ortho.py 소관).
#   전기간 직교화는 룩어헤드이므로 이 수치를 어떤 파라미터 결정에도 쓰지 않는다 (WORKORDER §7).
import io
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pathlib import Path
RAW = Path(__file__).resolve().parents[1] / "data"

panel = pd.read_parquet(RAW / "night_panel.parquet")
base = panel[~panel["excluded"] & ~panel["exclude_from_base_regression"]].copy()
base = base.dropna(subset=["gap_idx", "gap_hx", "r_spx", "r_soxx"])

# I0: 지수 사다리 최하단 — KOSPI200 gap ~ r_SPX
X = sm.add_constant(base["r_spx"])
i0 = sm.OLS(base["gap_idx"], X).fit()

# S0: 고유 사다리 최하단 — (하닉 gap − β_mkt·지수 gap) ~ soxx_ex
# β_mkt·soxx_ex 전기간 추정 (스모크 한정 — 상단 주석 참조)
beta_mkt = sm.OLS(base["gap_hx"], sm.add_constant(base["gap_idx"])).fit().params["gap_idx"]
soxx_ex = sm.OLS(base["r_soxx"], sm.add_constant(base["r_spx"])).fit().resid
idio = base["gap_hx"] - beta_mkt * base["gap_idx"]
s0 = sm.OLS(idio, sm.add_constant(soxx_ex)).fit()

print(f"표본: {len(base)}밤 ({base['krx_date'].min()} ~ {base['krx_date'].max()}) — 기본 회귀 대상(단일 세션 밤)만")
print(f"I0  gap_K200 ~ r_SPX      : R² {i0.rsquared:.3f} · b1 {i0.params['r_spx']:.3f} · n {int(i0.nobs)}")
print(f"S0  (gap_hx−β·gap_idx) ~ soxx_ex : R² {s0.rsquared:.3f} · c1 {s0.params.iloc[1]:.3f} · n {int(s0.nobs)} · β_mkt(전기간) {beta_mkt:.3f}")
print("※ 해석·튜닝 금지 (WORKORDER §5) — 사전 등록 예상과 '같은 우주인지'만 WEEK1_REPORT에 기재")
