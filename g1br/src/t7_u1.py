# T7 — u1(야간선물 내재갭) 편입 재검증 (발주 8/14 ② — 별도 브랜치·본판정 무접촉)
#
# 사전 등록 가설 (발주 ③, 데이터 확보 전 등록): "u1 편입으로 TE 중앙값 개선, 개선은 대형 갭·이벤트 밤 집중"
#
# 방법 — 3주차 T5와 동일 규약 (방법 변경 없음 = 튜닝 편향 차단):
#   · u1 전문가 = 단변량 워크포워드 캘리브레이션 (window=120, 주 1회 재추정) — gx·gdr과 동일
#   · 가중 재역산 = {reg, gx, (gdr), u1} 볼록결합 0.1 격자, 레짐별(normal/event)
#   · 2단 분할 = u1 예측 존재 밤(U)을 반으로 갈라 전반 탐색 → 후반 동결 평가
#   · 대조 = 같은 U 분할에서 u1 제외 격자(기존 구성)의 동결 성적 — 동일 밤 집합 비교
#   · 대형 갭 분해 = |실제 갭| ≥ 2% 밤의 med 개선 별도 표기
#
# 주의: u1은 2025-06-10부터만 존재 → 워크포워드 예열 120밤 후 예측 개시 (~2025-12).
#       U가 작으므로(예상 ~170밤) 결과는 '예비 판정' — 관문 통과 여부와 무관하게 수치 그대로 보고.
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
from src.t5_weights import fetch_nq_hourly, gx_series  # 동일 gx 정의 재사용


def main() -> None:
    base = pd.read_parquet(RAW / "total_validation.parquet")
    u1 = pd.read_parquet(RAW / "nightfut_u1.parquet")[["label_date", "u1_pct", "night_volume"]]
    u1 = u1.rename(columns={"label_date": "krx_date"})
    u1["u1"] = u1["u1_pct"] / 100.0
    base = base.merge(u1[["krx_date", "u1"]], on="krx_date", how="left")
    base["gx"] = gx_series(base)

    out = {}
    for sym, gap_col in [("hx", "gap_hx_adj"), ("ss", "gap_ss_adj")]:
        # 챔피언 갈래 = I0+S1 (pack_v1.0) — T5와 동일 탐색 규칙으로 회귀 컬럼 찾기
        cand = [c for c in base.columns if c.startswith(f"fair_{sym}_") and "I2" not in c]
        if not cand:
            continue
        reg = base[cand[0]]
        obs_pred = {"gx": walkforward(base, gap_col, ["gx"], window=120)}
        if sym == "ss":
            obs_pred["gdr"] = walkforward(base, gap_col, ["r_gdr"], window=120)
        u1_pred = walkforward(base, gap_col, ["u1"], window=120)
        obs_pred_u1 = {**obs_pred, "u1": u1_pred}

        # U = u1 예측·회귀·실측 모두 존재하는 밤
        U = base.index[u1_pred.notna() & reg.notna() & base[gap_col].notna()]
        half = len(U) // 2
        tr_idx, te_idx = U[:half], U[half:]

        def search(preds: dict) -> dict:
            names = ["reg"] + list(preds.keys())
            grid = [w for w in product(np.arange(0, 1.01, 0.1), repeat=len(names)) if abs(sum(w) - 1) < 1e-9]

            def med_err(w, idx):
                if len(idx) == 0:
                    return math.inf
                p = w[0] * reg.loc[idx]
                for wi, nm in zip(w[1:], preds):
                    p = p + wi * preds[nm].loc[idx]
                e = (base.loc[idx, gap_col] - p).abs() * 100
                return float(e.median()) if e.notna().sum() >= 15 else math.inf

            best = {}
            for regime in ["normal", "event"]:
                idx_tr = tr_idx[base.loc[tr_idx, "regime"] == regime]
                w_best = min(grid, key=lambda w: med_err(w, idx_tr))
                idx_te = te_idx[base.loc[te_idx, "regime"] == regime]
                best[regime] = {
                    "w": {nm: round(float(wi), 1) for nm, wi in zip(names, w_best)},
                    "탐색 med%": round(med_err(w_best, idx_tr), 4),
                    "동결 med%": round(med_err(w_best, idx_te), 4),
                    "n_tr/te": [int(len(idx_tr)), int(len(idx_te))],
                }

            # 동결 결합 오차 시리즈 (레짐별 가중 적용)
            errs = []
            for regime in ["normal", "event"]:
                sel = te_idx[base.loc[te_idx, "regime"] == regime]
                w = list(best[regime]["w"].values())
                p = w[0] * reg.loc[sel]
                for wi, nm in zip(w[1:], preds):
                    p = p + wi * preds[nm].loc[sel]
                errs.append((base.loc[sel, gap_col] - p).abs() * 100)
            e = pd.concat(errs).dropna()
            bigmask = base.loc[e.index, gap_col].abs() * 100 >= 2.0
            evtmask = base.loc[e.index, "regime"] == "event"
            return {
                "레짐별": best,
                "동결 전체": {"n": len(e), "med%": round(float(e.median()), 4), "mae%": round(float(e.mean()), 4)},
                "동결 대형갭(|갭|≥2%)": {"n": int(bigmask.sum()), "med%": round(float(e[bigmask].median()), 4) if bigmask.sum() >= 8 else None},
                "동결 이벤트밤": {"n": int(evtmask.sum()), "med%": round(float(e[evtmask].median()), 4) if evtmask.sum() >= 8 else None},
                "_err": e,
            }

        with_u1 = search(obs_pred_u1)
        without = search(obs_pred)  # 같은 U 분할 — u1만 제외
        e1, e0 = with_u1.pop("_err"), without.pop("_err")
        joint = pd.concat([e1.rename("u1"), e0.rename("base")], axis=1).dropna()
        out[sym] = {
            "U 밤수": len(U), "U 범위": [str(base.loc[U[0], "krx_date"]), str(base.loc[U[-1], "krx_date"])],
            "u1 편입": with_u1, "기존 구성(동일 밤)": without,
            "판정": {
                "동결 med 개선(%p)": round(float(e0.median() - e1.median()), 4),
                "밤별 u1 우세 비율": round(float((joint["u1"] < joint["base"]).mean()), 3) if len(joint) else None,
            },
        }

    # u1 단독 진단 — 지수 내재갭으로서의 성질 (참고용)
    u1s = base[["krx_date", "u1"]].dropna()
    out["u1 단독"] = {"n": len(u1s), "범위": [u1s.krx_date.min(), u1s.krx_date.max()],
                      "abs med%": round(float((u1s.u1.abs() * 100).median()), 3)}

    with open(RAW.parent / "reports" / "t7_u1.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, default=str)
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
