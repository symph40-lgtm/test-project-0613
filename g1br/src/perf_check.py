# 사용자 요청 (2026-08-09): G1B 챔피언 오프라인 성능 — 전체 vs 최근 2개월. 챔피언(I0+S1·Huber)과
# 베이스라인 B1·B2 대조, 레짐 분해. G1A v0.3은 피처가 실시간 전용이라 역사 측정 불가 (보고서 명기).
import io
import json
import sys

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from src.channels import RAW

base = pd.read_parquet(RAW / "total_validation.parquet")
out = {}
for sym, gap_col, nm in [("hx", "gap_hx_adj", "SK하이닉스"), ("ss", "gap_ss_adj", "삼성전자")]:
    fair = base[[c for c in base.columns if c.startswith(f"fair_{sym}_I0")][0]]
    b1 = base[f"pred_B1_{sym}"]
    b2 = base[f"pred_B2_{sym}"]
    res = {}
    for label, mask in [
        ("전체(평가 2024-01~)", base["krx_date"] >= "2024-01-01"),
        ("최근 2개월", base["krx_date"] >= "2026-06-09"),
    ]:
        row = {}
        for pname, pred in [("챔피언(I0+S1)", fair), ("B1(SOXX단독)", b1), ("B2(SPX매핑)", b2)]:
            j = pd.concat([base[gap_col].rename("y"), pred.rename("p"), base["regime"]], axis=1)[mask].dropna()
            if len(j) < 15:
                row[pname] = {"n": len(j)}
                continue
            e = (j["y"] - j["p"]).abs() * 100
            big = j[j["y"].abs() * 100 >= 0.3]
            row[pname] = {
                "n": len(j), "med%": round(float(e.median()), 3), "mae%": round(float(e.mean()), 3),
                "부호적중(|갭|≥0.3%)": round(float((np.sign(big["y"]) == np.sign(big["p"])).mean()), 3) if len(big) >= 10 else None,
            }
        # 무예측 기준(갭 자체 크기) — 오차의 스케일 감각
        g = (base[gap_col][mask].dropna().abs() * 100)
        row["참고: 평균|실제갭|"] = round(float(g.mean()), 3)
        res[label] = row
    out[nm] = res
print(json.dumps(out, ensure_ascii=False, indent=1))
