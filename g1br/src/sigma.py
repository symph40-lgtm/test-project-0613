# T6 — σ_base 레짐별 추정 (WORKORDER week2 §6 / 스펙 §3.3)
# 잔차 원천: T4 결합 예측(fair_*_I2b)의 워크포워드 잔차 — 3주차 총검증의 전신(임시)임을 명시.
# 레짐 캘린더:
#   매크로: 레포 기존 lib/predict-daily/eventCalendar.ts에서 파싱 (FOMC·CPI·고용 — 공개 일정, 단일 원천 유지)
#   실적: MU·NVDA — yfinance get_earnings_dates (실패 시 부분 구성 보고)
#   PPI: 전용 공개 캘린더 소스 미확보 (조사 상한 내 — 부분 구성으로 보고, WORKORDER §6-1 허용 경로)
import io
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW = Path(__file__).resolve().parents[1] / "data"
TS_CAL = Path(__file__).resolve().parents[3] / "test project_0613" / "lib" / "predict-daily" / "eventCalendar.ts"
if not TS_CAL.exists():
    TS_CAL = Path(__file__).resolve().parents[2] / "lib" / "predict-daily" / "eventCalendar.ts"


def macro_event_dates() -> set[str]:
    txt = TS_CAL.read_text(encoding="utf-8")
    out = set()
    for arr in ["FOMC_DECISION_DATES", "CPI_RELEASE_DATES", "ES_RELEASE_DATES"]:
        m = re.search(arr + r"[^=]*=\s*\[(.*?)\];", txt, re.S)
        if m:
            out |= set(re.findall(r"\d{4}-\d{2}-\d{2}", m.group(1)))
    return {d for d in out if d >= "2023-01-01"}


def earnings_dates() -> tuple[set[str], str]:
    import yfinance as yf
    out, note = set(), "OK"
    for t in ["MU", "NVDA"]:
        try:
            df = yf.Ticker(t).get_earnings_dates(limit=40)
            if df is None or df.empty:
                note = f"{t} 실적일 조회 실패 — 부분 구성"
                continue
            for d in df.index:
                ds = d.date().isoformat()
                if "2023-01-01" <= ds <= "2026-12-31":
                    out.add(ds)
        except Exception as e:
            note = f"{t} 실적일 조회 예외({type(e).__name__}) — 부분 구성"
    return out, note


def classify(base: pd.DataFrame, events: set[str]) -> pd.Series:
    def one(r) -> str:
        ud = r["us_dates"].split(",") if isinstance(r["us_dates"], str) else list(r["us_dates"])
        if any(d in events for d in ud):
            return "event"
        if abs(r["r_spx"]) >= 0.03 if pd.notna(r["r_spx"]) else False:
            return "bigmove"
        return "normal"
    return base.apply(one, axis=1)


def sigma_ci(std: float, n: int) -> list[float]:
    """카이제곱 기반 σ 80% 신뢰구간 (표본 부족 병기용, 스펙 §3.3-4)."""
    from scipy import stats  # scipy 없으면 근사
    lo = std * math.sqrt((n - 1) / stats.chi2.ppf(0.9, n - 1))
    hi = std * math.sqrt((n - 1) / stats.chi2.ppf(0.1, n - 1))
    return [round(lo, 4), round(hi, 4)]


def main() -> None:
    base = pd.read_parquet(RAW / "ladder_results.parquet")
    macro = macro_event_dates()
    earn, earn_note = earnings_dates()
    events = macro | earn
    base["regime"] = classify(base, events)

    out: dict = {"레짐 캘린더": {"매크로(FOMC·CPI·고용)": len(macro), "실적(MU·NVDA)": len(earn), "실적 수집": earn_note,
                              "PPI": "전용 소스 미확보 — 부분 구성 (§6-1 보고 경로)"}}
    for sym, gap in [("hx", "gap_hx"), ("ss", "gap_ss")]:
        resid = (base[gap] - base[f"fair_{sym}_I2b"]) * 100
        r = pd.concat([resid.rename("e"), base["regime"], base["krx_date"]], axis=1).dropna()
        out[sym] = {}
        for reg in ["normal", "event", "bigmove"]:
            e = r[r["regime"] == reg]["e"]
            if len(e) < 10:
                out[sym][reg] = {"n": len(e), "σ_base": None}
                continue
            std = float(e.std())
            cover1 = float((e.abs() <= std).mean())
            cover2 = float((e.abs() <= 2 * std).mean())
            row = {"n": len(e), "σ_base_pct": round(std, 3),
                   "커버1σ": round(cover1, 3), "커버2σ": round(cover2, 3)}
            if reg == "event" and len(e) < 40:
                try:
                    row["σ_80CI"] = sigma_ci(std, len(e))
                except Exception:
                    row["σ_80CI"] = "scipy 없음 — 생략"
            out[sym][reg] = row
        ratio = (out[sym].get("event", {}).get("σ_base_pct") or math.nan) / (out[sym]["normal"]["σ_base_pct"] or math.nan)
        out[sym]["이벤트/평상 비율"] = round(ratio, 2) if not math.isnan(ratio) else None
    print(json.dumps(out, ensure_ascii=False, indent=1))
    # 패널에 레짐 저장 (3주차 총검증 입력)
    base[["krx_date", "regime"]].to_parquet(RAW / "regimes.parquet", index=False)
    print("저장: regimes.parquet")


if __name__ == "__main__":
    main()
