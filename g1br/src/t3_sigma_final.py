# T3 — σ_base 확정 (WORKORDER week3 §3 / J2·J3)
# J2: 긴 표본 — 챔피언 구조(I0+S1·Huber, 전 기간)의 결합 잔차로 추정. (I1은 T4에서 미채택 —
#     "I1a 기반"의 취지 = 전 기간 지수+고유 결합이므로 I0+S1이 그 승계임을 명시)
# J3: 대변동(|SPX|≥3%) 재정의 금지 — σ(대변동)=1.5×σ(이벤트) provisional. |SPX|≥2%는 보조 진단만.
import io
import json
import sys

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW


def main() -> None:
    base = pd.read_parquet(RAW / "total_validation.parquet")
    ev = base["krx_date"] >= "2024-01-01"
    out = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        fair_col = [c for c in base.columns if c.startswith(f"fair_{sym}_I0")][0]
        resid = ((base[gap_col] - base[fair_col]) * 100)[ev].dropna()
        reg = base.loc[resid.index, "regime"]
        spx = base.loc[resid.index, "r_spx"].abs()
        row = {}
        for regime in ["normal", "event"]:
            e = resid[reg == regime]
            std = float(e.std())
            row[regime] = {"n": len(e), "σ_base%": round(std, 3),
                           "커버1σ": round(float((e.abs() <= std).mean()), 3),
                           "커버2σ": round(float((e.abs() <= 2 * std).mean()), 3)}
        row["bigmove"] = {"n": int((reg == "bigmove").sum()), "σ_base%": round(1.5 * row["event"]["σ_base%"], 3),
                          "provisional": True, "rule": "1.5×σ(이벤트) — 미검증·60일 이관 (J3)"}
        row["이벤트/평상 비율"] = round(row["event"]["σ_base%"] / row["normal"]["σ_base%"], 2)
        # 보조 진단: |SPX|≥2% 밤의 잔차 σ (레짐 아님)
        e2 = resid[spx >= 0.02]
        row["보조진단 |SPX|≥2%"] = {"n": len(e2), "σ%": round(float(e2.std()), 3) if len(e2) >= 10 else None}
        # 커버리지 관문 (1σ 65~72% / 2σ ≥93%)
        g1 = 0.65 <= row["normal"]["커버1σ"] <= 0.72
        g2 = row["normal"]["커버2σ"] >= 0.93
        row["커버리지 관문(평상)"] = "통과" if (g1 and g2) else f"미달 (1σ {row['normal']['커버1σ']}·2σ {row['normal']['커버2σ']})"
        out[sym] = row
    with open(RAW.parent / "reports" / "t3_sigma.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
