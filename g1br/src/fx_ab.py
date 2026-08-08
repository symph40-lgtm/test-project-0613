# T3 — b4(Δfx) A/B 판정 (WORKORDER week2 §3 / D3)
#   A안: 전일 KRW=X 일봉 종가 기준 Δfx (07:15 시점 마지막 완성봉 = t−1봉. 전 기간, 정보 1일 지연)
#   B안: 60분봉 절단 — 전 KRX일 15:00 KST → 당일 07:00 KST 야간 변화 (2024-08 이후만)
# 판정: 중첩 표본에서 I2 사다리 OOS 오차 비교. B가 부트스트랩 80% 신뢰로 명확히 이길 때만 B, 아니면 A.
# 시간 상한 반나절 — Δfx는 직교화 후 한계 기여가 작은 변수, 과투자 금지 (발주 지시).
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import load_base, oos_metrics, walkforward
from src.ortho import rolling_orthogonalize

RAW = Path(__file__).resolve().parents[1] / "data"


def build_fx_variants(base: pd.DataFrame) -> pd.DataFrame:
    fx_d = pd.read_parquet(RAW / "raw" / "yf_KRW_eq_X.parquet").set_index("data_date")["close"].sort_index()
    # A안: 07:15에 가용한 마지막 완성 일봉 = 직전 런던일 봉 → 밤 t 기준 (t−1)/(t−2) 변화
    dates = fx_d.index.tolist()
    la = {}
    for i in range(2, len(dates)):
        la[dates[i]] = math.log(fx_d.iloc[i - 1] / fx_d.iloc[i - 2])
    laggy = pd.Series(la)
    # B안: 60분봉 — 전 KRX일 15:00 KST(06:00Z) → 당일 07:00 KST(전일 22:00Z)
    h = pd.read_parquet(RAW / "raw" / "yf_KRW_eq_X_60m.parquet")
    h["ts"] = pd.to_datetime(h["ts_utc"], utc=True)
    h = h.sort_values("ts").reset_index(drop=True)
    hts, hcl = h["ts"].values, h["close"].values

    def last_at(anchor: pd.Timestamp) -> float:
        pos = hts.searchsorted(np.datetime64(anchor)) - 1
        return float(hcl[pos]) if pos >= 0 else math.nan

    a_col, b_col = [], []
    for _, r in base.iterrows():
        ud = r["us_dates"].split(",") if isinstance(r["us_dates"], str) else list(r["us_dates"])
        a_col.append(laggy.get(ud[-1], math.nan) if ud else math.nan)
        p1 = last_at(pd.Timestamp(r["krx_prev_date"] + "T06:00:00Z"))
        p2 = last_at((pd.Timestamp(r["krx_date"] + "T22:00:00Z") - pd.Timedelta(days=1)))
        b_col.append(math.log(p2 / p1) if (p1 > 0 and p2 > 0) else math.nan)
    base = base.copy()
    base["fx_A"], base["fx_B"] = a_col, b_col
    base["fxA_orth"] = rolling_orthogonalize(base["fx_A"], base["d_y10_bp"], window=120)
    base["fxB_orth"] = rolling_orthogonalize(base["fx_B"], base["d_y10_bp"], window=120, min_obs=80)
    return base


def main() -> None:
    base = build_fx_variants(load_base())
    # I2 비교 (갈래 고정: I1a 기반 — fx 효과만 분리. 발주 §3 판정 대상은 fx 변형)
    predA = walkforward(base, "gap_idx", ["r_spx", "d_y10_bp", "fxA_orth"], window=120)
    predB = walkforward(base, "gap_idx", ["r_spx", "d_y10_bp", "fxB_orth"], window=120)
    pred0 = walkforward(base, "gap_idx", ["r_spx", "d_y10_bp"], window=120)  # 대조: fx 없음(I1a)
    both = pd.concat([base["gap_idx"].rename("y"), predA.rename("A"), predB.rename("B"), pred0.rename("O"),
                      base["krx_date"]], axis=1).dropna()
    errA = (both["y"] - both["A"]).abs().values * 100
    errB = (both["y"] - both["B"]).abs().values * 100
    errO = (both["y"] - both["O"]).abs().values * 100
    diff = errA - errB  # >0 = B 우위
    rng = np.random.default_rng(20260809)
    boots = [float(np.mean(diff[rng.integers(0, len(diff), len(diff))])) for _ in range(4000)]
    lo80, hi80 = np.percentile(boots, [10, 90])
    verdict = "B안 채택" if lo80 > 0 else "A안 채택 (긴 히스토리·단순성 우선)"
    out = {
        "overlap_n": len(both), "period": [both["krx_date"].min(), both["krx_date"].max()],
        "mae_A": round(float(errA.mean()), 4), "mae_B": round(float(errB.mean()), 4),
        "mae_no_fx": round(float(errO.mean()), 4),
        "diff_mean(A−B)": round(float(diff.mean()), 4),
        "boot80_CI": [round(float(lo80), 4), round(float(hi80), 4)],
        "verdict": verdict,
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
