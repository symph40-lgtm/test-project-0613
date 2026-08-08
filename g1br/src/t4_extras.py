# T4 보강 — ① 동일 표본 대조 (fx 가용 밤으로 제한해 I1 vs I2 공정 비교)
#          ② 윈도 민감도 {60, 120, 250} (I2·S2·결합만)
# 사다리 채택의 최종 확정은 3주차 — 여기서는 수치 보고만 (WORKORDER §8).
import io
import json
import sys

import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW, run_ladders


def same_sample_table() -> dict:
    base = pd.read_parquet(RAW / "ladder_results.parquet")
    out = {}
    for iv in ["I2a", "I2b"]:
        sub = base[base[f"pred_idx_{iv}"].notna() & (base["krx_date"] >= "2024-01-01")]
        row = {}
        for step in ["I0", "I1a", "I1b", iv]:
            e = (sub["gap_idx"] - sub[f"pred_idx_{step}"]).abs().dropna() * 100
            row[step] = {"n": len(e), "mae": round(float(e.mean()), 4), "med": round(float(e.median()), 4)}
        out[f"동일표본({iv} 가용 밤)"] = row
    return out


def main() -> None:
    print("== 동일 표본 대조 (fx 가용 구간 한정) ==")
    print(json.dumps(same_sample_table(), ensure_ascii=False, indent=1))
    print("\n== 윈도 민감도 (I2·S2·결합 MAE %) ==")
    sens = {}
    for w in [60, 120, 250]:
        res, _ = run_ladders(window=w)
        sens[w] = {
            "I2a": res["idx"]["I2a"]["mae_pct"], "I2b": res["idx"]["I2b"]["mae_pct"],
            "hx_S2": res["idio"]["hx"]["S2"]["mae_pct"], "ss_S2": res["idio"]["ss"]["S2"]["mae_pct"],
            "hx_comb": res["combined"]["hx_I2b+S2"]["mae_pct"], "ss_comb": res["combined"]["ss_I2b+S2"]["mae_pct"],
        }
    print(json.dumps(sens, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
