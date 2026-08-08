# T5 — AdjEx: 배당락·권리락 기계 조정 (WORKORDER week2 §5 / D5 / 스펙 G1B v0.3 §3.4)
# 두 갈래로 잡는다:
#   ① 가격조정 이벤트(분할·권리락): 수정주가/미수정주가 비율의 점프로 자동 검출 (KRX 계정 필요)
#   ② 현금배당(가격 미조정): 분기 기준일 관행으로 락일 후보 생성 + DPS/4 → AdjEx = −DPS_q/전일종가
#      락일 근사: 기준일 = 분기 말일 → 유효 기준세션 = 그 이전 마지막 거래일 → 락일 = 그 직전 거래일.
#      ⚠근사임을 명시 — 실증 검증(락일 후보의 평균 갭 vs 이론 배당수익률)으로 타당성 확인.
import datetime as dt
import io
import json
import math
import sys
from pathlib import Path

import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

RAW = Path(__file__).resolve().parents[1] / "data"


def fetch_unadjusted(code: str) -> pd.Series:
    from pykrx import stock
    df = stock.get_market_ohlcv("20230101", dt.date.today().isoformat().replace("-", ""), code, adjusted=False)
    return pd.Series(df["종가"].values, index=[d.date().isoformat() for d in df.index])


def detect_price_adjust_events(code: str) -> list[dict]:
    """수정/미수정 종가 비율 점프 = 분할·권리락 등 가격조정 이벤트."""
    adj = pd.read_parquet(RAW / "raw" / f"krx_{code}.parquet").set_index("data_date")["close"]
    raw = fetch_unadjusted(code)
    j = pd.concat([adj.rename("a"), raw.rename("r")], axis=1).dropna()
    factor = (j["a"] / j["r"]).round(6)
    jumps = factor.pct_change().abs()
    events = []
    for d in jumps[jumps > 0.005].index:
        events.append({"date": d, "factor_change": round(float(factor.loc[d] / factor.shift(1).loc[d]), 6)})
    return events


def dps_annual(code: str) -> float:
    from pykrx import stock
    ymd = dt.date.today().isoformat().replace("-", "")
    try:
        df = stock.get_market_fundamental((dt.date.today() - dt.timedelta(days=14)).isoformat().replace("-", ""), ymd, code)
        dps = float(df["DPS"].dropna().iloc[-1])
        return dps
    except Exception:
        return math.nan


def quarterly_ex_dates(sessions: list[str], start_year=2023) -> list[str]:
    """분기 말 기준일 관행의 락일 근사 — 분기 마지막 거래일의 직전 거래일."""
    out = []
    s = sorted(sessions)
    for y in range(start_year, int(s[-1][:4]) + 1):
        for q_end in [f"{y}-03-31", f"{y}-06-30", f"{y}-09-30", f"{y}-12-31"]:
            prior = [d for d in s if d <= q_end]
            if len(prior) >= 2 and (dt.date.fromisoformat(q_end) - dt.date.fromisoformat(prior[-1])).days <= 10:
                out.append(prior[-2])  # 기준세션 직전 거래일 = 락일 근사
    return out


def main() -> None:
    panel = pd.read_parquet(RAW / "night_panel.parquet")
    sessions = panel["krx_date"].tolist()
    out: dict = {}
    adjex_map: dict[tuple, float] = {}
    for code, gap_col in [("005930", "gap_ss"), ("000660", "gap_hx")]:
        price = pd.read_parquet(RAW / "raw" / f"krx_{code}.parquet").set_index("data_date")["close"]
        events = detect_price_adjust_events(code)
        dps = dps_annual(code)
        dps_q = dps / 4 if not math.isnan(dps) else math.nan
        ex_dates = quarterly_ex_dates(sessions)
        # 실증 검증: 락일 후보의 평균 갭 vs 그 외 — 이론상 −DPS_q/P 만큼 낮아야 함
        live = panel[~panel["excluded"]]
        on_ex = live[live["krx_date"].isin(ex_dates)][gap_col].dropna() * 100
        off_ex = live[~live["krx_date"].isin(ex_dates)][gap_col].dropna() * 100
        theo = []
        for d in ex_dates:
            prev = price[price.index < d]
            if len(prev) and not math.isnan(dps_q):
                theo.append(-dps_q / float(prev.iloc[-1]) * 100)
                adjex_map[(d, code)] = -dps_q / float(prev.iloc[-1])
        out[code] = {
            "가격조정_이벤트(분할·권리락)": events if events else "없음",
            "DPS_연간": dps, "DPS_분기": dps_q,
            "락일_후보": ex_dates,
            "실증": {
                "락일 평균갭%": round(float(on_ex.mean()), 3) if len(on_ex) else None,
                "락일 n": len(on_ex),
                "평상일 평균갭%": round(float(off_ex.mean()), 3),
                "이론 AdjEx% 평균": round(float(pd.Series(theo).mean()), 3) if theo else None,
            },
        }
    # 패널 반영: ex_date 플래그 + adjex 컬럼(종목별) + 조정 라벨
    panel["ex_date"] = panel["krx_date"].isin({d for (d, _) in adjex_map})
    for code, col in [("005930", "adjex_ss"), ("000660", "adjex_hx")]:
        panel[col] = [adjex_map.get((d, code), 0.0) for d in panel["krx_date"]]
    panel["gap_ss_adj"] = panel["gap_ss"] - panel["adjex_ss"]
    panel["gap_hx_adj"] = panel["gap_hx"] - panel["adjex_hx"]
    panel.to_parquet(RAW / "night_panel.parquet", index=False)
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
    print(f"패널 갱신: ex_date {int(panel['ex_date'].sum())}일 · adjex 적용 완료")


if __name__ == "__main__":
    main()
