# T1 — 금리 소스 검증 (WORKORDER week2 §1 / D1 조건부 승인의 확정 절차)
# ^TNX와 2YY=F는 단위 체계가 다르다:
#   ^TNX  = 10년물 수익률 × 10 인 지수 (46.17 = 4.617%) → Δbp = Δ지수 × 10
#   2YY=F = 2년물 수익률 선물, 가격이 곧 수익률 % (4.15 = 4.15%) → Δbp = Δ가격 × 100
#   FRED DGS2/DGS10 = 수익률 % → Δbp = Δ × 100
# 절단 정합 (night_panel 주석용):
#   ^TNX 일봉 = CBOE 지수, 미 현물 세션 마감(16:00 ET ≈ 05/06시 KST) 확정 → 07:15 KST 가용
#   2YY=F 일봉 = CME 글로벡스 거래일 마감(17:00 ET = 06/07시 KST) 직전 체결 기준 → 07:15 KST 가용(동절기 07:00 마감 — 15분 여유)
from pathlib import Path

import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"

TNX_INDEX_TO_BP = 10.0    # ^TNX 지수 1포인트 = 10bp
PCT_TO_BP = 100.0         # 수익률 % 1포인트 = 100bp


def load_close(name: str) -> pd.Series:
    df = pd.read_parquet(RAW / (name + ".parquet"))
    return df.set_index("data_date")["close"].sort_index()


def daily_bp_change(series: pd.Series, factor: float) -> pd.Series:
    """일변화를 bp로 — 결측일(휴장)은 직전 관측 대비가 아니라 NaN (다중일 누적은 align 소관)."""
    return series.diff() * factor


def yahoo_rate_bp() -> dict[str, pd.Series]:
    return {
        "y10": daily_bp_change(load_close("yf__i_TNX"), TNX_INDEX_TO_BP),
        "y2": daily_bp_change(load_close("yf_2YY_eq_F"), PCT_TO_BP),
    }


def fred_rate_bp() -> dict[str, pd.Series]:
    return {
        "y10": daily_bp_change(load_close("fred_DGS10").dropna(), PCT_TO_BP),
        "y2": daily_bp_change(load_close("fred_DGS2").dropna(), PCT_TO_BP),
    }


def cross_validate() -> dict:
    """야후 Δbp vs FRED Δbp — 공통 날짜에서 상관·계통 편차. 관문: 상관 ≥ 0.95 + 평균편차 |bias| < 1bp."""
    ya, fr = yahoo_rate_bp(), fred_rate_bp()
    out = {}
    for k in ["y10", "y2"]:
        j = pd.concat([ya[k].rename("ya"), fr[k].rename("fr")], axis=1).dropna()
        corr = float(j["ya"].corr(j["fr"]))
        bias = float((j["ya"] - j["fr"]).mean())
        mad = float((j["ya"] - j["fr"]).abs().median())
        out[k] = {"n": len(j), "corr": round(corr, 4), "mean_bias_bp": round(bias, 3),
                  "median_abs_diff_bp": round(mad, 2), "pass": corr >= 0.95 and abs(bias) < 1.0}
    return out


if __name__ == "__main__":
    import io, json, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    res = cross_validate()
    print(json.dumps(res, ensure_ascii=False, indent=1))
    ok = all(v["pass"] for v in res.values())
    print("판정:", "★통과 — 야후 소스 확정" if ok else "✗ 미달 — 중단·보고 (WORKORDER §1-3)")
    raise SystemExit(0 if ok else 1)
