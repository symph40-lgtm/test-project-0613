# T1 미달 진단 (일회성) — 2YY=F 상관 0.815의 원인 규명 + 대안 실측. WEEK2_REPORT 근거용.
import io
import json
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import pandas as pd
import yfinance as yf

from src.rates import fred_rate_bp, yahoo_rate_bp

ya, fr = yahoo_rate_bp(), fred_rate_bp()
out = {}
# ① 날짜 시프트 진단 — 정렬 문제라면 ±1일 시프트에서 상관이 크게 오른다
j0 = pd.concat([ya["y2"].rename("ya"), fr["y2"].rename("fr")], axis=1).dropna()
for lag in [-1, 0, 1]:
    s = pd.concat([ya["y2"].rename("ya"), fr["y2"].shift(lag).rename("fr")], axis=1).dropna()
    out[f"y2_shift{lag:+d}"] = round(float(s["ya"].corr(s["fr"])), 4)
# ② 구간 분해 — 초기 저유동 문제인지
for lb, frm in [("2023", "2023-01-01"), ("2024", "2024-01-01"), ("2025+", "2025-01-01"), ("2026+", "2026-01-01")]:
    s = j0[j0.index >= frm]
    out[f"y2_corr_{lb}"] = {"n": len(s), "corr": round(float(s["ya"].corr(s["fr"])), 4)}
# ③ 대안 ZT=F (2Y 노트 가격 선물, 고유동) — Δ수익률 ≈ −Δ가격 (상관은 스케일 무관)
zt = yf.Ticker("ZT=F").history(start="2023-01-01", auto_adjust=False)["Close"]
zt.index = [d.date().isoformat() for d in zt.index]
dzt = -zt.diff()
s = pd.concat([dzt.rename("zt"), fr["y2"].rename("fr")], axis=1).dropna()
out["ZT_vs_DGS2"] = {"n": len(s), "corr": round(float(s["zt"].corr(s["fr"])), 4)}
ss = s[s.index >= "2025-01-01"]
out["ZT_vs_DGS2_2025+"] = round(float(ss["zt"].corr(ss["fr"])), 4)
# ④ 참고: 2YY 노이즈 감각 — 야후 2Y vs 야후 10Y
s2 = pd.concat([ya["y2"].rename("a"), ya["y10"].rename("b")], axis=1).dropna()
out["y2_vs_y10_yahoo"] = round(float(s2["a"].corr(s2["b"])), 4)
print(json.dumps(out, ensure_ascii=False, indent=1))
