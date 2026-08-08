# T2 — 채널 기여 재진단 (WORKORDER week3 §2 / J1)
# ① 절제 재표현: B2(β·I0) → +지수회귀(β·I1a) → +고유(S1) 단계별 OOS 오차 (동일 라벨·동일 밤)
# ② 앵커: 원시 종목갭 ~ r_SOXX 단독 (분해·직교화 없음) — 반도체 신호 총량
# ③ β 4안별 고유 채널 R² — "β 교정 시 고유 기여 회복" 가설 직접 검정
# 라벨: gap_*_adj. 절제의 β = Huber(T1 예비 우위안 — 최종 확정은 T4).
import io
import json
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW, idio_ladder, walkforward


def main() -> None:
    base = pd.read_parquet(RAW / "beta_variants.parquet")
    out = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        bv = base[f"b_huber_{sym}"]
        s1_cols = idio_ladder(sym)["S1"]
        work = base.copy()
        work["idio_v"] = work[gap_col] - bv * work["gap_idx"]
        pred_idio = walkforward(work, "idio_v", s1_cols, window=120)
        steps = {
            "B2 (β·I0 지수매핑)": bv * base["pred_idx_I0"],
            "+지수회귀 (β·I1a)": bv * base["pred_idx_I1a"],
            "+고유 S1 (결합)": bv * base["pred_idx_I1a"] + pred_idio,
        }
        # 동일 밤 비교 — 세 예측 모두 유효한 밤만
        valid = pd.concat([base[gap_col]] + list(steps.values()), axis=1).dropna().index
        abl = {}
        prev_mae = None
        for name, pred in steps.items():
            err = ((base.loc[valid, gap_col] - pred.loc[valid]).abs() * 100)
            mae = round(float(err.mean()), 4)
            abl[name] = {"n": len(valid), "mae": mae, "med": round(float(err.median()), 4),
                         "Δmae": None if prev_mae is None else round(mae - prev_mae, 4)}
            prev_mae = mae
        # 앵커 회귀
        j = base[[gap_col, "r_soxx"]].dropna()
        anchor = sm.OLS(j[gap_col], sm.add_constant(j["r_soxx"])).fit()
        # β 4안별 고유 R² (S1 인샘플)
        idio_r2 = {}
        for bn in ["b_roll", "b_exbig", "b_huber", "b_fixed"]:
            lab = base[gap_col] - base[f"{bn}_{sym}"] * base["gap_idx"]
            jj = pd.concat([lab.rename("y")] + [base[c] for c in s1_cols], axis=1).dropna()
            m = sm.OLS(jj["y"], sm.add_constant(jj[s1_cols])).fit()
            idio_r2[bn] = round(float(m.rsquared), 4)
        out[sym] = {
            "절제(동일 밤)": abl,
            "앵커 gap~SOXX": {"R2": round(float(anchor.rsquared), 4),
                            "beta": round(float(anchor.params["r_soxx"]), 3), "n": int(anchor.nobs)},
            "β안별 고유 S1 R²": idio_r2,
        }
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
