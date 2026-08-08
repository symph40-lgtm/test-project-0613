# T5 — 가중 역산 (WORKORDER week3 §5 / D4 범위: 관측부 = GDR + GX)
# 관측 예측원을 워크포워드 단변량 캘리브레이션으로 갭 단위화한 뒤, {회귀, GDR, GX} 볼록결합을
# 레짐별 0.1 격자 탐색. 2단 분할 필수: 전반부 탐색 → 후반부 동결 평가 (스펙 §3.4).
# GDR은 삼전만 (하닉 GDR 미확보 — AUDIT), GX = NQ=F 글로벡스 마감 후 변화 (60분봉, 2024-08+).
# 합격 관문 판정(조건 3): 결합 FairGap_R1의 후반부 동결 중앙값(%) ≤ 0.45.
import datetime as dt
import io
import json
import math
import sys
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW, walkforward

RAWD = RAW / "raw"


def fetch_nq_hourly() -> pd.DataFrame:
    import yfinance as yf
    path = RAWD / "yf_NQ_eq_F_60m.parquet"
    start = dt.date.today() - dt.timedelta(days=728)
    if path.exists():
        old = pd.read_parquet(path)
        start = max(start, (pd.Timestamp(old["ts_utc"].max()) - pd.Timedelta(days=5)).date())
    df = yf.Ticker("NQ=F").history(start=start.isoformat(), interval="60m")
    out = pd.DataFrame({"ts_utc": [d.tz_convert("UTC").isoformat() for d in df.index], "close": df["Close"].values})
    if path.exists():
        out = pd.concat([pd.read_parquet(path)[["ts_utc", "close"]], out], ignore_index=True) \
                .drop_duplicates(subset=["ts_utc"], keep="last").sort_values("ts_utc")
    out.to_parquet(path, index=False)
    return out


def gx_series(base: pd.DataFrame) -> pd.Series:
    h = fetch_nq_hourly()
    ts = pd.to_datetime(h["ts_utc"], utc=True).values
    cl = h["close"].values

    def at(anchor):
        p = ts.searchsorted(np.datetime64(anchor.tz_convert(None))) - 1
        return float(cl[p]) if p >= 0 else math.nan

    vals = []
    for _, r in base.iterrows():
        a2 = pd.Timestamp(r["krx_date"] + "T22:00:00Z") - pd.Timedelta(days=1)  # 07:00 KST 당일
        a1 = a2 - pd.Timedelta(hours=2)                                          # 미장 마감 부근 (근사, 계절 혼합 명시)
        p1, p2 = at(a1), at(a2)
        vals.append(math.log(p2 / p1) if (p1 > 0 and p2 > 0) else math.nan)
    return pd.Series(vals, index=base.index)


def main() -> None:
    base = pd.read_parquet(RAW / "total_validation.parquet")
    base["gx"] = gx_series(base)
    ev = base["krx_date"] >= "2024-01-01"
    out = {}
    packs = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        # 회귀부 = 갈래별 후보 (전기간 I0+S1 / fx구간 I2+S1) — 결합 관문은 두 갈래 모두 판정
        for branch, col in [("I0+S1", f"fair_{sym}_I0_S1_huber"), ("I2+S1", f"fair_{sym}_I2(I0+fx)_S1_huber")]:
            colname = [c for c in base.columns if c.replace(" ", "") == col.replace(" ", "")]
            if not colname:
                # 컬럼명 규칙 재구성 (t4에서 저장한 이름 탐색)
                cand = [c for c in base.columns if c.startswith(f"fair_{sym}_") and ("I2" in c) == ("I2" in branch)]
                if not cand:
                    continue
                colname = cand
            reg = base[colname[0]]
            obs_pred = {}
            obs_pred["gx"] = walkforward(base, gap_col, ["gx"], window=120)
            if sym == "ss":
                obs_pred["gdr"] = walkforward(base, gap_col, ["r_gdr"], window=120)
            # 2단 분할
            nights = base[ev & reg.notna()].index
            half = len(nights) // 2
            tr_idx, te_idx = nights[:half], nights[half:]
            names = ["reg"] + list(obs_pred.keys())
            grid = [w for w in product(np.arange(0, 1.01, 0.1), repeat=len(names)) if abs(sum(w) - 1) < 1e-9]
            best = {}
            for regime in ["normal", "event"]:
                rmask_tr = base.loc[tr_idx, "regime"] == regime
                idx_tr = tr_idx[rmask_tr]
                def med_err(w, idx):
                    p = w[0] * reg.loc[idx]
                    for wi, nm in zip(w[1:], obs_pred):
                        p = p + wi * obs_pred[nm].loc[idx]
                    e = (base.loc[idx, gap_col] - p).abs() * 100
                    return float(e.median()) if e.notna().sum() >= 15 else math.inf
                scored = sorted(grid, key=lambda w: med_err(w, idx_tr))
                w_best = scored[0]
                rmask_te = base.loc[te_idx, "regime"] == regime
                best[regime] = {
                    "w": {nm: round(float(wi), 1) for nm, wi in zip(names, w_best)},
                    "탐색(전반부) med%": round(med_err(w_best, idx_tr), 4),
                    "동결(후반부) med%": round(med_err(w_best, te_idx[rmask_te]), 4),
                    "n_tr/te": [int(rmask_tr.sum()), int(rmask_te.sum())],
                }
            # 관문: 전 레짐 후반부 동결 결합 (레짐별 가중 적용)
            def combined_err(idx):
                errs = []
                for regime in ["normal", "event"]:
                    sel = idx[base.loc[idx, "regime"] == regime]
                    w = list(best[regime]["w"].values())
                    p = w[0] * reg.loc[sel]
                    for wi, nm in zip(w[1:], obs_pred):
                        p = p + wi * obs_pred[nm].loc[sel]
                    errs.append((base.loc[sel, gap_col] - p).abs() * 100)
                e = pd.concat(errs).dropna()
                return {"n": len(e), "med%": round(float(e.median()), 4), "mae%": round(float(e.mean()), 4)}
            gate = combined_err(te_idx)
            gate["관문(med ≤0.45%)"] = "통과" if gate["med%"] <= 0.45 else "미달"
            out[f"{sym}:{branch}"] = {"레짐별": best, "후반부 동결 결합": gate}
            packs[f"{sym}:{branch}"] = best
    with open(RAW.parent / "reports" / "t5_weights.json", "w", encoding="utf-8") as f:
        json.dump({"결과": out}, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
