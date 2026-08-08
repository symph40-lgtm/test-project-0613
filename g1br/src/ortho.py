# T2 — 롤링 직교화 (WORKORDER week2 §2 / 스펙 G1B-R v0.2 §3.1)
# 순서 고정: fx→Δy2, SOXX→SPX, TSM→SOXX, peer→SOXX. 전기간 일괄 직교화 금지 —
# 시점 t의 잔차는 [t−window, t−1] 데이터로 적합한 계수를 t에 적용해 산출한다 (구조적 아웃오브샘플).
# 발주자 T1 판정 §3: fx 직교화는 갈래별 정합 — I1a용 fx_orth_a(→Δy10), I1b용 fx_orth_b(→Δy2).
import math

import numpy as np
import pandas as pd


def _fit_beta(y: np.ndarray, x: np.ndarray) -> tuple[float, float]:
    """단순 OLS y = a + b·x (결측 제거 후). 반환 (a, b)."""
    m = ~(np.isnan(y) | np.isnan(x))
    ym, xm = y[m], x[m]
    if len(ym) < 2:
        return math.nan, math.nan
    xb, yb = xm.mean(), ym.mean()
    vx = ((xm - xb) ** 2).sum()
    if vx == 0:
        return yb, 0.0
    b = ((xm - xb) * (ym - yb)).sum() / vx
    return yb - b * xb, b


def rolling_orthogonalize(y: pd.Series, x: pd.Series, window: int = 120, min_obs: int = 80) -> pd.Series:
    """resid_t = y_t − (a+b·x_t), (a,b)는 [t−window, t−1] 적합. 유효 표본 < min_obs → NaN."""
    idx = y.index
    x = x.reindex(idx)
    yv, xv = y.values.astype(float), x.values.astype(float)
    out = np.full(len(idx), np.nan)
    for t in range(window, len(idx)):
        yw, xw = yv[t - window:t], xv[t - window:t]
        m = ~(np.isnan(yw) | np.isnan(xw))
        if m.sum() < min_obs or np.isnan(yv[t]) or np.isnan(xv[t]):
            continue
        a, b = _fit_beta(yw, xw)
        if math.isnan(b):
            continue
        out[t] = yv[t] - a - b * xv[t]
    return pd.Series(out, index=idx)


# ── night_panel 위에 직교화 컬럼 일괄 생성 ──
def add_ortho_columns(panel: pd.DataFrame, window: int = 120) -> pd.DataFrame:
    """기본 회귀 대상 밤만으로 시계열을 구성해 직교화 (multi_session·휴장 밤은 NaN 유지)."""
    base = panel[~panel["excluded"]].copy()
    order = base.index  # 시간순 전제 (krx_date 오름차순)

    def col(name: str) -> pd.Series:
        return base[name]

    pairs = [
        # (출력, y, x) — 스펙 §3.1 순서. fx = d_fx_night (b4 확정, T3 판정). 갈래별 직교화 (발주자 T1 판정 §3)
        ("fx_orth_a", "d_fx_night", "d_y10_bp"),
        ("fx_orth_b", "d_fx_night", "d_y2_bp"),
        ("soxx_ex", "r_soxx", "r_spx"),
        ("tsm_ex", "r_tsm", "r_soxx"),
        ("mu_ex", "r_mu", "r_soxx"),
        ("nvda_ex", "r_nvda", "r_soxx"),
    ]
    for out_name, yc, xc in pairs:
        base[out_name] = rolling_orthogonalize(col(yc), col(xc), window=window)

    # peer_orth: 하닉=MU 잔차 / 삼전=MU·NVDA 균등 (G1B-R v0.1 정의 승계 — v0.2·0.3 무개정 항목)
    base["peer_orth_hx"] = base["mu_ex"]
    base["peer_orth_ss"] = (base["mu_ex"] + base["nvda_ex"]) / 2

    merged = panel.copy()
    for c in ["fx_orth_a", "fx_orth_b", "soxx_ex", "tsm_ex", "peer_orth_hx", "peer_orth_ss"]:
        merged[c] = base[c].reindex(panel.index)
    return merged


if __name__ == "__main__":
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    from pathlib import Path
    RAW = Path(__file__).resolve().parents[1] / "data"
    panel = pd.read_parquet(RAW / "night_panel.parquet")
    out = add_ortho_columns(panel)
    cols = ["fx_orth_a", "fx_orth_b", "soxx_ex", "tsm_ex", "peer_orth_hx", "peer_orth_ss"]
    live = out[~out["excluded"]]
    for c in cols:
        s = live[c]
        print(f"  {c.ljust(14)} 유효 {s.notna().sum()}밤 · std {s.std():.4f}")
    out.to_parquet(RAW / "night_panel_ortho.parquet", index=False)
    print("저장: night_panel_ortho.parquet")
