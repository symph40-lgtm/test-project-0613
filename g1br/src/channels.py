# T4 — 채널 회귀 사다리 (WORKORDER week2 §4 / 스펙 §3.2, I3 제외).
# T3(b4 판정)도 이 워크포워드 코어를 공유한다.
# 발주자 T1 판정 §3: I1 두 갈래 — I1a = Δy10 단독 / I1b = Δy2(ZT)+커브. fx_orth도 갈래별.
# 해석·튜닝 금지 — 수치 산출까지. 변수 채택 최종 확정은 3주차 OOS 총검증 (WORKORDER §8).
import math
from pathlib import Path

import numpy as np
import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data"


def _ols(y: np.ndarray, X: np.ndarray) -> np.ndarray | None:
    m = ~(np.isnan(y) | np.isnan(X).any(axis=1))
    if m.sum() < X.shape[1] + 20:
        return None
    Xm = np.column_stack([np.ones(m.sum()), X[m]])
    try:
        beta, *_ = np.linalg.lstsq(Xm, y[m], rcond=None)
        return beta
    except np.linalg.LinAlgError:
        return None


def walkforward(df: pd.DataFrame, ycol: str, xcols: list[str],
                window: int = 120, refit_every: int = 5) -> pd.Series:
    """주 1회(5거래밤) 재추정 시뮬레이션 — 시점 t 예측은 [t−window, t−1] 적합 계수로만."""
    y = df[ycol].values.astype(float)
    X = df[list(xcols)].values.astype(float)
    n = len(df)
    preds = np.full(n, np.nan)
    beta = None
    for t in range(window, n):
        if (t - window) % refit_every == 0 or beta is None:
            beta = _ols(y[t - window:t], X[t - window:t])
        if beta is None or np.isnan(X[t]).any():
            continue
        preds[t] = beta[0] + X[t] @ beta[1:]
    return pd.Series(preds, index=df.index)


def oos_metrics(actual: pd.Series, pred: pd.Series, eval_mask: pd.Series) -> dict:
    j = pd.concat([actual.rename("a"), pred.rename("p")], axis=1)[eval_mask].dropna()
    if len(j) < 30:
        return {"n": len(j), "mae_pct": math.nan, "med_pct": math.nan, "sign_hit": math.nan}
    err = (j["a"] - j["p"]).abs() * 100
    big = j[j["a"].abs() * 100 >= 0.3]
    sign = float((np.sign(big["a"]) == np.sign(big["p"])).mean()) if len(big) >= 20 else math.nan
    return {
        "n": len(j), "mae_pct": round(float(err.mean()), 4), "med_pct": round(float(err.median()), 4),
        "p90_pct": round(float(err.quantile(0.9)), 4),
        "sign_hit": round(sign, 3) if not math.isnan(sign) else math.nan,
        "resid": (j["a"] - j["p"]),
    }


def insample_r2_nw(df: pd.DataFrame, ycol: str, xcols: list[str]) -> dict:
    """전 표본 기술 통계 — OLS R² + Newey-West(5랙) t값 (보고용, 채택 근거 아님)."""
    import statsmodels.api as sm
    j = df[[ycol] + list(xcols)].dropna()
    if len(j) < 60:
        return {"r2": math.nan}
    X = sm.add_constant(j[list(xcols)])
    m = sm.OLS(j[ycol], X).fit(cov_type="HAC", cov_kwds={"maxlags": 5})
    return {"r2": round(float(m.rsquared), 4),
            "coef": {c: round(float(m.params[c]), 4) for c in xcols},
            "t_nw": {c: round(float(m.tvalues[c]), 2) for c in xcols}}


# ── 사다리 정의 ──
IDX_LADDER: dict[str, list[str]] = {
    "I0": ["r_spx"],
    "I1a": ["r_spx", "d_y10_bp"],
    "I1b": ["r_spx", "d_y2_bp", "curve_bp"],
    "I2a": ["r_spx", "d_y10_bp", "fx_orth_a"],
    "I2b": ["r_spx", "d_y2_bp", "curve_bp", "fx_orth_b"],
}


def idio_ladder(symbol: str) -> dict[str, list[str]]:
    peer = "peer_orth_hx" if symbol == "hx" else "peer_orth_ss"
    return {"S0": ["soxx_ex"], "S1": ["soxx_ex", peer], "S2": ["soxx_ex", peer, "tsm_ex"]}


def load_base() -> pd.DataFrame:
    p = pd.read_parquet(RAW / "night_panel_ortho.parquet")
    base = p[~p["excluded"] & ~p["exclude_from_base_regression"]].copy().reset_index(drop=True)
    base["curve_bp"] = base["d_y10_bp"] - base["d_y2_bp"]
    return base


def rolling_beta_mkt(base: pd.DataFrame, gap_col: str, window: int = 120) -> pd.Series:
    """β_mkt 롤링 — 시점 t는 [t−window, t−1] 적합 (고유 라벨 생성용)."""
    y = base[gap_col].values.astype(float)
    x = base["gap_idx"].values.astype(float)
    out = np.full(len(base), np.nan)
    for t in range(window, len(base)):
        b = _ols(y[t - window:t], x[t - window:t].reshape(-1, 1))
        if b is not None:
            out[t] = b[1]
    return pd.Series(out, index=base.index)


def run_ladders(window: int = 120, eval_from: str = "2024-01-01") -> dict:
    base = load_base()
    ev = base["krx_date"] >= eval_from
    out: dict = {"window": window, "eval_from": eval_from, "idx": {}, "idio": {}, "combined": {}}

    # 지수 사다리
    for step, cols in IDX_LADDER.items():
        pred = walkforward(base, "gap_idx", cols, window=window)
        m = oos_metrics(base["gap_idx"], pred, ev)
        out["idx"][step] = {**{k: v for k, v in m.items() if k != "resid"}, "insample": insample_r2_nw(base, "gap_idx", cols)}
        base[f"pred_idx_{step}"] = pred

    # 고유 사다리 + 결합 (종목별)
    for sym, gap_col in [("hx", "gap_hx"), ("ss", "gap_ss")]:
        bmkt = rolling_beta_mkt(base, gap_col, window=window)
        base[f"bmkt_{sym}"] = bmkt
        base[f"idio_{sym}"] = base[gap_col] - bmkt * base["gap_idx"]
        out["idio"][sym] = {}
        for step, cols in idio_ladder(sym).items():
            pred = walkforward(base, f"idio_{sym}", cols, window=window)
            m = oos_metrics(base[f"idio_{sym}"], pred, ev)
            out["idio"][sym][step] = {**{k: v for k, v in m.items() if k != "resid"},
                                      "insample": insample_r2_nw(base.dropna(subset=[f"idio_{sym}"]), f"idio_{sym}", cols)}
            base[f"pred_idio_{sym}_{step}"] = pred
        # 결합: FairGap_hat = β_mkt·G_idx_hat(I2a·I2b) + G_idio_hat(S2)
        for iv in ["I2a", "I2b"]:
            fair = bmkt * base[f"pred_idx_{iv}"] + base[f"pred_idio_{sym}_S2"]
            m = oos_metrics(base[gap_col], fair, ev)
            out["combined"][f"{sym}_{iv}+S2"] = {k: v for k, v in m.items() if k != "resid"}
            base[f"fair_{sym}_{iv}"] = fair
    out["beta_mkt_last"] = {s: round(float(base[f"bmkt_{s}"].iloc[-1]), 3) for s in ["hx", "ss"]}
    return out, base


if __name__ == "__main__":
    import io, json, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    res, base = run_ladders()
    slim = {k: v for k, v in res.items() if k != "resid"}
    print(json.dumps(slim, ensure_ascii=False, indent=1, default=str))
    base.to_parquet(RAW / "ladder_results.parquet", index=False)
    print("저장: ladder_results.parquet")
