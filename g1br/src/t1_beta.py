# T1 — β_mkt 진단과 선택 (WORKORDER week3 §1 / J1)
# 4안: (i) 롤링 120 / (ii) 대변동 밤(|SPX|≥3%) 제외 롤링 / (iii) Huber 강건 / (iv) 고정 1.2
# 선택 규칙: 결합 FairGap OOS translation_error 최소안 (최종 확정은 T4 — 여기서는 예비 표 + 진단).
# 라벨: AdjEx 적용 갭(gap_*_adj) — 스펙 G1B v0.3 §3.4 "라벨·FairGap 동일 적용".
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW, _ols, idio_ladder, walkforward

WINDOW = 120
BIG = 0.03


def beta_variants(base: pd.DataFrame, gap_col: str) -> pd.DataFrame:
    import statsmodels.api as sm
    y_all = base[gap_col].values.astype(float)
    x_all = base["gap_idx"].values.astype(float)
    spx = base["r_spx"].values.astype(float)
    n = len(base)
    out = {"b_roll": np.full(n, np.nan), "b_exbig": np.full(n, np.nan), "b_huber": np.full(n, np.nan)}
    for t in range(WINDOW, n):
        yw, xw, sw = y_all[t - WINDOW:t], x_all[t - WINDOW:t], spx[t - WINDOW:t]
        m = ~(np.isnan(yw) | np.isnan(xw))
        if m.sum() < 80:
            continue
        b = _ols(yw, xw.reshape(-1, 1))
        if b is not None:
            out["b_roll"][t] = b[1]
        mx = m & ~(np.abs(sw) >= BIG)
        if mx.sum() >= 60:
            b2 = _ols(np.where(mx, yw, np.nan), np.where(mx, xw, np.nan).reshape(-1, 1))
            if b2 is not None:
                out["b_exbig"][t] = b2[1]
        try:
            X = sm.add_constant(xw[m])
            rlm = sm.RLM(yw[m], X, M=sm.robust.norms.HuberT()).fit()
            out["b_huber"][t] = float(rlm.params[1])
        except Exception:
            pass
    df = pd.DataFrame(out, index=base.index)
    df["b_fixed"] = 1.2
    return df


def halfyear_table(base: pd.DataFrame, betas: pd.DataFrame) -> dict:
    tbl = {}
    half = base["krx_date"].str.slice(0, 4) + np.where(base["krx_date"].str.slice(5, 7) <= "06", "H1", "H2")
    for h in sorted(half.unique()):
        sel = betas[half == h]
        if sel["b_roll"].notna().sum() < 20:
            continue
        tbl[h] = {c: round(float(sel[c].mean()), 3) for c in ["b_roll", "b_exbig", "b_huber"]}
    return tbl


def extreme_night_contribution(base: pd.DataFrame, gap_col: str) -> dict:
    """β 급등이 소수 극단 밤 기여인지 — 마지막 윈도에서 |SPX| 상위 5밤 제거 시 β 변화."""
    tail = base.iloc[-WINDOW:]
    y = tail[gap_col].values.astype(float)
    x = tail["gap_idx"].values.astype(float)
    b_full = _ols(y, x.reshape(-1, 1))
    order = np.argsort(-np.abs(tail["r_spx"].fillna(0).values))
    keep = np.ones(len(tail), bool)
    keep[order[:5]] = False
    b_drop = _ols(np.where(keep, y, np.nan), np.where(keep, x, np.nan).reshape(-1, 1))
    return {"β(최근 윈도)": round(float(b_full[1]), 3),
            "β(|SPX| 상위 5밤 제거)": round(float(b_drop[1]), 3) if b_drop is not None else None}


def preliminary_oos(base: pd.DataFrame, sym: str, gap_col: str, betas: pd.DataFrame) -> dict:
    """β 4안별 결합 OOS 예비 표 — I1a(전 기간)·I2b(fx 구간) 두 갈래."""
    res = {}
    s1_cols = idio_ladder(sym)["S1"]
    for bname in ["b_roll", "b_exbig", "b_huber", "b_fixed"]:
        bv = betas[bname]
        work = base.copy()
        work["idio_v"] = work[gap_col] - bv * work["gap_idx"]
        pred_idio = walkforward(work, "idio_v", s1_cols, window=WINDOW)
        row = {}
        for branch in ["I1a", "I2b"]:
            fair = bv * base[f"pred_idx_{branch}"] + pred_idio
            j = pd.concat([base[gap_col].rename("y"), fair.rename("p"), base["krx_date"]], axis=1).dropna()
            j = j[j["krx_date"] >= "2024-01-01"]
            err = (j["y"] - j["p"]).abs() * 100
            row[branch] = {"n": len(j), "mae": round(float(err.mean()), 4), "med": round(float(err.median()), 4)}
        res[bname] = row
    return res


def main() -> None:
    base = pd.read_parquet(RAW / "ladder_results.parquet")
    out = {}
    store = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        betas = beta_variants(base, gap_col)
        store[sym] = betas
        out[sym] = {
            "최근값": {c: round(float(betas[c].dropna().iloc[-1]), 3) for c in betas.columns},
            "반기별 평균": halfyear_table(base, betas),
            "극단 밤 기여": extreme_night_contribution(base, gap_col),
            "예비 OOS (β안 × 갈래)": preliminary_oos(base, sym, gap_col, betas),
        }
        for c in betas.columns:
            base[f"{c}_{sym}"] = betas[c]
    base.to_parquet(RAW / "beta_variants.parquet", index=False)
    # 차트
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
        xd = pd.to_datetime(base["krx_date"])
        for ax, sym, nm in [(axes[0], "hx", "SK hynix"), (axes[1], "ss", "Samsung")]:
            for c, lb in [("b_roll", "(i) roll120"), ("b_exbig", "(ii) ex-bigmove"), ("b_huber", "(iii) Huber"), ("b_fixed", "(iv) fixed 1.2")]:
                ax.plot(xd, store[sym][c], label=lb, lw=1)
            ax.set_title(f"beta_mkt variants — {nm}")
            ax.legend(fontsize=8)
            ax.grid(alpha=0.3)
        fig.tight_layout()
        fig.savefig(Path(__file__).resolve().parents[1] / "reports" / "beta_mkt_variants.png", dpi=120)
        out["chart"] = "reports/beta_mkt_variants.png"
    except Exception as e:
        out["chart"] = f"차트 실패: {e}"
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
