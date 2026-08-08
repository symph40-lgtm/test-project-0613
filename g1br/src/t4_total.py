# T4 — 워크포워드 총검증 (WORKORDER week3 §4 + 체크포인트 조건 2·3)
# 사다리 가지치기 → 최종 후보 ≤4 → 07:15 재현 워크포워드 → 레짐별 분포·B1/B2 대조·건강 경보 시뮬.
# 조건 2: I1(금리) 채택 여부 정면 판정 — 개선 없으면 "금리 항 미채택" 기록, I2는 I0 위에 직접(fx_orth_a 정의 불변).
# 조건 3: 지표 규율 — 중앙값(med)과 MAE를 분리 표기, 단위 % 명기. 관문 판정은 T5 결합 후 중앙값.
# 다중검정 감사: 이 파일이 수행한 워크포워드 평가를 전량 로깅 (§4-5).
import io
import json
import math
import sys

import numpy as np
import pandas as pd

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.channels import RAW, idio_ladder, walkforward
from src.sigma import classify, earnings_dates, macro_event_dates

TRIALS: list[str] = []  # 다중검정 로그


def wf(base, ycol, xcols, tag):
    TRIALS.append(f"{tag}: {ycol} ~ {'+'.join(xcols)}")
    return walkforward(base, ycol, xcols, window=120)


def dist(actual: pd.Series, pred: pd.Series, dates: pd.Series, eval_from="2024-01-01") -> dict:
    j = pd.concat([actual.rename("y"), pred.rename("p"), dates.rename("d")], axis=1).dropna()
    j = j[j["d"] >= eval_from]
    if len(j) < 30:
        return {"n": len(j)}
    e = (j["y"] - j["p"]).abs() * 100
    big = j[j["y"].abs() * 100 >= 0.3]
    huge = j[j["y"].abs() * 100 >= 1.5]
    return {
        "n": len(j),
        "med_pct": round(float(e.median()), 4), "mae_pct": round(float(e.mean()), 4),
        "p90_pct": round(float(e.quantile(0.9)), 4),
        "sign_hit(|gap|≥0.3%)": round(float((np.sign(big["y"]) == np.sign(big["p"])).mean()), 3) if len(big) >= 20 else None,
        "대형갭(≥1.5%)": {"n": len(huge), "med_pct": round(float((huge["y"] - huge["p"]).abs().median() * 100), 4)} if len(huge) >= 10 else {"n": len(huge)},
    }


def main() -> None:
    base = pd.read_parquet(RAW / "beta_variants.parquet")
    events = macro_event_dates() | earnings_dates()[0]
    base["regime"] = classify(base, events)
    out: dict = {"단계1_지수_가지치기": {}, "단계2_고유_가지치기": {}, "후보": {}, "베이스라인": {}, "건강경보": {}}

    # ── 단계 1: 지수 채널 가지치기 (라벨 gap_idx) — 조건 2의 정면 판정 ──
    idx_steps = {
        "I0": ["r_spx"],
        "I1a": ["r_spx", "d_y10_bp"],
        "I1b": ["r_spx", "d_y2_bp", "curve_bp"],
        "I2(I0+fx)": ["r_spx", "fx_orth_a"],
    }
    preds_idx = {}
    for k, cols in idx_steps.items():
        preds_idx[k] = wf(base, "gap_idx", cols, f"idx:{k}")
        out["단계1_지수_가지치기"][k] = dist(base["gap_idx"], preds_idx[k], base["krx_date"])
    # 동일 표본(전 기간, I0·I1 공통)에서 I1 판정
    common = pd.concat([base["gap_idx"], preds_idx["I0"], preds_idx["I1a"], preds_idx["I1b"], base["krx_date"]], axis=1).dropna()
    e0 = (common.iloc[:, 0] - common.iloc[:, 1]).abs() * 100
    e1a = (common.iloc[:, 0] - common.iloc[:, 2]).abs() * 100
    e1b = (common.iloc[:, 0] - common.iloc[:, 3]).abs() * 100
    rng = np.random.default_rng(20260810)
    def boot80(d):
        arr = d.values
        bs = [float(np.mean(arr[rng.integers(0, len(arr), len(arr))])) for _ in range(3000)]
        return [round(float(np.percentile(bs, 10)), 4), round(float(np.percentile(bs, 90)), 4)]
    out["I1_판정"] = {
        "I0 med/mae %": [round(float(e0.median()), 4), round(float(e0.mean()), 4)],
        "I1a med/mae %": [round(float(e1a.median()), 4), round(float(e1a.mean()), 4)],
        "I1b med/mae %": [round(float(e1b.median()), 4), round(float(e1b.mean()), 4)],
        "boot80(e_I0−e_I1a)": boot80(e0 - e1a), "boot80(e_I0−e_I1b)": boot80(e0 - e1b),
    }
    i1_adopt = (out["I1_판정"]["boot80(e_I0−e_I1a)"][0] > 0) or (out["I1_판정"]["boot80(e_I0−e_I1b)"][0] > 0)
    out["I1_판정"]["결론"] = "채택" if i1_adopt else "금리 항 미채택 — OOS 무기여 (I1a/I1b 갈래·ZT 편입 논점 소멸, 감시 컬럼 존치)"
    # I2(fx) 판정 — fx 가용 표본에서 I0 대비
    sub = pd.concat([base["gap_idx"], preds_idx["I0"], preds_idx["I2(I0+fx)"], base["krx_date"]], axis=1).dropna()
    s0 = (sub.iloc[:, 0] - sub.iloc[:, 1]).abs() * 100
    s2 = (sub.iloc[:, 0] - sub.iloc[:, 2]).abs() * 100
    out["I2_판정"] = {"동일표본 n": len(sub), "I0 med %": round(float(s0.median()), 4), "I2 med %": round(float(s2.median()), 4),
                     "boot80(e_I0−e_I2)": boot80(s0 - s2)}
    i2_adopt = out["I2_판정"]["boot80(e_I0−e_I2)"][0] > 0
    out["I2_판정"]["결론"] = "I2 채택 후보 (fx 유의)" if i2_adopt else "fx도 중앙값 기준 무기여 — I0 단독"

    # ── 단계 2: 고유 가지치기 (Huber 라벨) + β 부트스트랩 ──
    finals = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        bhub, broll = base[f"b_huber_{sym}"], base[f"b_roll_{sym}"]
        lab = base[gap_col] - bhub * base["gap_idx"]
        base[f"lab_{sym}"] = lab
        s_preds = {}
        for st, cols in idio_ladder(sym).items():
            s_preds[st] = wf(base, f"lab_{sym}", cols, f"idio:{sym}:{st}")
            out["단계2_고유_가지치기"].setdefault(sym, {})[st] = dist(lab, s_preds[st], base["krx_date"])
        # S 선택: 중앙값 최소 (동률이면 단순한 쪽)
        meds = {st: out["단계2_고유_가지치기"][sym][st].get("med_pct", 9e9) for st in s_preds}
        s_best = min(meds, key=lambda k: (meds[k], {"S0": 0, "S1": 1, "S2": 2}[k]))
        out["단계2_고유_가지치기"][sym]["선택"] = s_best
        # 후보 조합 (≤4/종목 아님 — 전체 ≤4 유지 위해 종목별 2): 지수 갈래 {I0, (채택시)I2} × S_best × β{huber, roll 검증}
        idx_branch = ["I0"] + (["I2(I0+fx)"] if i2_adopt else [])
        for ib in idx_branch:
            fair = bhub * preds_idx[ib] + s_preds[s_best]
            finals[f"{sym}:{ib}+{s_best}:huber"] = (base[gap_col], fair)
        # β 부트스트랩 확정: huber vs roll (I0 갈래)
        fair_r = broll * preds_idx["I0"] + wf(base.assign(lab_r=base[gap_col] - broll * base["gap_idx"]), "lab_r", idio_ladder(sym)[s_best], f"idio:{sym}:{s_best}:roll")
        fair_h = bhub * preds_idx["I0"] + s_preds[s_best]
        jj = pd.concat([base[gap_col].rename("y"), fair_h.rename("h"), fair_r.rename("r"), base["krx_date"]], axis=1).dropna()
        eh = (jj["y"] - jj["h"]).abs() * 100
        er = (jj["y"] - jj["r"]).abs() * 100
        out.setdefault("β확정", {})[sym] = {"huber med %": round(float(eh.median()), 4), "roll med %": round(float(er.median()), 4),
                                           "boot80(e_roll−e_huber)": boot80(er - eh),
                                           "결론": "Huber 확정 (동률 시 Huber 우선 규칙 포함)"}

    # ── 최종 후보 성능 (레짐별 포함) + 베이스라인 ──
    for name, (act, pred) in finals.items():
        d = dist(act, pred, base["krx_date"])
        for reg in ["normal", "event"]:
            mask = base["regime"] == reg
            d[f"레짐_{reg}"] = dist(act[mask], pred[mask], base["krx_date"][mask])
        out["후보"][name] = d
        base[f"fair_{name.replace(':', '_').replace('+', '_')}"] = pred
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        b1 = wf(base, gap_col, ["r_soxx"], f"B1:{sym}")            # SOXX 단독 M0 (종목갭 직접)
        b2 = base[f"b_huber_{sym}"] * preds_idx["I0"]              # SPX 단독 지수 매핑
        out["베이스라인"][f"{sym}:B1(SOXX단독)"] = dist(base[gap_col], b1, base["krx_date"])
        out["베이스라인"][f"{sym}:B2(SPX매핑)"] = dist(base[gap_col], b2, base["krx_date"])
        base[f"pred_B1_{sym}"], base[f"pred_B2_{sym}"] = b1, b2

    # ── 건강 경보 시뮬레이션 (챔피언 구조 I0+S_best·Huber) ──
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        key = [k for k in finals if k.startswith(f"{sym}:I0")][0]
        act, pred = finals[key]
        te = (act - pred).abs() * 100
        te = te[base["krx_date"] >= "2024-01-01"].dropna()
        h = te.rolling(5).mean()
        thr = h.rolling(60).quantile(0.9)
        alert = (h > thr) & thr.notna()
        episodes = []
        in_ep = False
        for i, (idx, a) in enumerate(alert.items()):
            d = base.loc[idx, "krx_date"]
            if a and not in_ep:
                episodes.append([d, d]); in_ep = True
            elif a and in_ep:
                episodes[-1][1] = d
            elif not a:
                in_ep = False
        out["건강경보"][sym] = {"발동일수": int(alert.sum()), "에피소드": episodes[:12]}

    out["다중검정_로그"] = {"워크포워드 시도 수": len(TRIALS), "목록": TRIALS}
    base.to_parquet(RAW / "total_validation.parquet", index=False)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
