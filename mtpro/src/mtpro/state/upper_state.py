"""상위 상태 — Good Acceptance / Bad Resilience (계획서 §5, 출력 전용 · Energy 입력 아님, T5-5).

증거 6종(스코프별, EWMA hl 10 세션, available_at ≤ t, 관측 창 120 세션):
    Good Acceptance                              | Bad Resilience
    good_err   : ERR_z(good 재료일)              | bad_err   : ERR_z(bad 재료일) — 버팀 = +
    good_beta  : z(GoodBeta − 1)                 | bad_beta  : z(1 − BadBeta)
    good_shock : shock_absorption_z(good) [예약]  | bad_shock : shock_absorption_z(bad) [예약, T5-6]
    good_gap   : gap_hold_z(양의 갭)             | bad_gap   : gap_hold_z(음의 갭 되돌림)
    good_psa   : psa_z(양 충격, final)           | bad_psa   : psa_z(음 충격, final)
    good_flow  : flow_impact_residual_z(good 재료일) | bad_flow : flow_impact_residual_z(bad 재료일)

  score = round(100·tanh(mean(가용 증거 상태))), 가용 < 2 → None + status "insufficient" (state_confidence 는 그래도 산출 — 계획서 §5 예시
  "증거 1개(ERR)만 +80 → conf ≤ 17" 을 그대로 재현하기 위함, 해석 기록 ⑦).
  state_confidence = round(100 × (n_avail/6) × (0.5 + 0.5·agreement) × freshness), agreement = 점수(평균)와 부호가 같은 증거 비율,
  freshness = 가장 최근 관측(세션 거리 d) 기준 0.5^(d/10). evidence_n = 창(120 세션) 안 원 관측 건수 합. available_evidence = 가용 증거 이름.

해석 기록:
  ⑤ ERR 부호: gap3g err_z 는 수익률 공간 잔차 → 악재일 + = 버팀. 계획서의 "−ERR_z of bad" 는 재료 방향 공간 ERR 표기 — 수익률 공간
     잔차를 그대로 쓴다(families.py 해석 기록 ① 과 동일 규약, errata.asymmetry/gradec 관례와 정합).
  ⑥ z(GoodBeta − 1): 표준 z 는 평균 중심화라 "−1" 이 소거된다 → 중립값 1 을 중심으로 과거 120 세션(t−1까지) GoodBeta 의 std 로 나눈
     값 (GoodBeta − 1)/std_past, 표본<60 None, 클립 ±3 (BadBeta 도 (1 − BadBeta)/std_past). 발주자 확인 사항.
  ⑧ 등급C 소급 구간의 "good/bad 이벤트일" = gap3g 재료일(err_z 유효) ∧ sign(sox_ret_prev) — 등급A 전진 구간은 surprise_z 부호(T5-6).
"""
from __future__ import annotations

import math
from datetime import date
from typing import Any, Optional, Sequence

import numpy as np
import pandas as pd

from mtpro.components.psa import psa_state_at
from mtpro.components.rolling import clip, is_finite, past_window
from mtpro.core.errata import _clip_int
from mtpro.state.families import (
    EWMA_HALFLIFE_SESSIONS, FRESHNESS_HALFLIFE_SESSIONS, OBS_WINDOW_SESSIONS, Z_CLIP_ABS, Z_MIN_SAMPLES, Z_WINDOW_DAYS,
    _f, clip_z, ewma_state, freshness_from_dist,
)

# ---- 사전 등록 상수 (config upper_state 블록과 일치 테스트) ------------------------------------------------------
GOOD_EVIDENCE: tuple[str, ...] = ("good_err", "good_beta", "good_shock", "good_gap", "good_psa", "good_flow")
BAD_EVIDENCE: tuple[str, ...] = ("bad_err", "bad_beta", "bad_shock", "bad_gap", "bad_psa", "bad_flow")
N_EVIDENCE: int = 6
MIN_EVIDENCE: int = 2
RESERVED_EVIDENCE: tuple[str, ...] = ("good_shock", "bad_shock")   # 부품 3 장중 (T5-6) — None 예약
BETA_NEUTRAL: float = 1.0

STATUS_OK = "ok"
STATUS_INSUFFICIENT = "insufficient"


def state_from_evidence(evidence: dict[str, dict[str, Any]], names: Sequence[str]) -> dict[str, Any]:
    """증거 상태 dict {name: {"state": float|None, "n_obs": int, "dist_last": int|None}} → 상위 상태.

    Returns: {"score": int|None, "status": str, "state_confidence": int|None, "evidence_n": int, "available_evidence": [..],
              "n_avail": int, "agreement": float|None, "freshness": float|None, "mean_z": float|None}
    """
    avail = [k for k in names if k in evidence and evidence[k].get("state") is not None and is_finite(evidence[k]["state"])]
    n_avail = len(avail)
    ev_n = int(sum(int(evidence[k].get("n_obs", 0)) for k in avail))
    if n_avail == 0:
        return {"score": None, "status": STATUS_INSUFFICIENT, "state_confidence": None, "evidence_n": 0, "available_evidence": [],
                "n_avail": 0, "agreement": None, "freshness": None, "mean_z": None}
    vals = np.asarray([float(evidence[k]["state"]) for k in avail], dtype=float)
    mean_z = float(vals.mean())
    sgn = 1.0 if mean_z > 0 else (-1.0 if mean_z < 0 else 0.0)
    agreement = float(np.mean([(1.0 if (1.0 if v > 0 else (-1.0 if v < 0 else 0.0)) == sgn else 0.0) for v in vals]))
    dists = [evidence[k].get("dist_last") for k in avail if evidence[k].get("dist_last") is not None]
    d = int(min(dists)) if dists else None
    fresh = freshness_from_dist(d) if d is not None else 1.0
    conf = _clip_int(100.0 * (n_avail / float(N_EVIDENCE)) * (0.5 + 0.5 * agreement) * fresh, 0, 100)
    if n_avail < MIN_EVIDENCE:
        score, status = None, STATUS_INSUFFICIENT
    else:
        score, status = _clip_int(100.0 * math.tanh(mean_z)), STATUS_OK
    return {"score": score, "status": status, "state_confidence": conf, "evidence_n": ev_n, "available_evidence": avail,
            "n_avail": n_avail, "agreement": agreement, "freshness": fresh, "mean_z": mean_z}


def beta_deviation_z(values: Sequence[Optional[float]], i: int, sign: float, *, neutral: float = BETA_NEUTRAL) -> Optional[float]:
    """sign·(β_t − neutral) / std(β_{t−120..t−1}) — 표본<60 None, 클립 ±3 (해석 기록 ⑥)."""
    x = values[i]
    if not is_finite(x):
        return None
    past = past_window(values, i, Z_WINDOW_DAYS)
    if len(past) < Z_MIN_SAMPLES:
        return None
    sd = float(np.std(np.asarray(past, dtype=float), ddof=1))
    if not np.isfinite(sd) or sd <= 0:
        return None
    return clip(sign * (float(x) - neutral) / sd, -Z_CLIP_ABS, Z_CLIP_ABS)


UPPER_COLUMNS: tuple[str, ...] = (
    "date", "scope",
    "good_acceptance", "good_status", "good_state_confidence", "good_evidence_n", "good_available_evidence", "good_agreement", "good_freshness",
    "bad_resilience", "bad_status", "bad_state_confidence", "bad_evidence_n", "bad_available_evidence", "bad_agreement", "bad_freshness",
    "ev_good_err", "ev_good_beta", "ev_good_gap", "ev_good_psa", "ev_good_flow",
    "ev_bad_err", "ev_bad_beta", "ev_bad_gap", "ev_bad_psa", "ev_bad_flow",
)


def build_upper_state(
    reaction: pd.DataFrame,
    g3: pd.DataFrame,
    flow: pd.DataFrame,
    psa_events: Optional[pd.DataFrame],
    scope: str,
) -> pd.DataFrame:
    """scope 하나의 일별 상위 상태. reaction = families.build_reaction 출력(err_obs·err_sign·good_beta·bad_beta 사용),
    g3 = gap3g scope 행(gap_pct·gap_hold_z), flow = flow scope 행."""
    n = len(reaction)
    dates: list[date] = list(reaction["date"])
    if list(g3["date"]) != dates:
        raise ValueError("reaction/g3 date axes differ")
    obs = [_f(v) for v in reaction["err_obs"]]
    sign = [_f(v) for v in reaction["err_sign"]]
    gb = [_f(v) for v in reaction["good_beta"]]
    bb = [_f(v) for v in reaction["bad_beta"]]
    gap = [_f(v) for v in g3["gap_pct"]]
    hold_z = [_f(v) for v in g3["gap_hold_z"]]
    fm = dict(zip(flow["date"], flow["flow_impact_residual_z"]))
    fz = [_f(fm.get(d)) for d in dates]

    good_days = [i for i in range(n) if obs[i] is not None and sign[i] == 1.0]
    bad_days = [i for i in range(n) if obs[i] is not None and sign[i] == -1.0]

    # 관측 스트림 (pos, value)
    streams: dict[str, tuple[list[int], list[float]]] = {
        "good_err": (good_days, [obs[i] for i in good_days]),
        "bad_err": (bad_days, [obs[i] for i in bad_days]),
        "good_flow": ([i for i in good_days if fz[i] is not None], [clip_z(fz[i]) for i in good_days if fz[i] is not None]),
        "bad_flow": ([i for i in bad_days if fz[i] is not None], [clip_z(fz[i]) for i in bad_days if fz[i] is not None]),
    }
    gpos = [i for i in range(n) if hold_z[i] is not None and gap[i] is not None and gap[i] > 0]
    bpos = [i for i in range(n) if hold_z[i] is not None and gap[i] is not None and gap[i] < 0]
    streams["good_gap"] = (gpos, [clip_z(hold_z[i]) for i in gpos])
    streams["bad_gap"] = (bpos, [clip_z(hold_z[i]) for i in bpos])
    gbz = [beta_deviation_z(gb, i, +1.0) for i in range(n)]
    bbz = [beta_deviation_z(bb, i, -1.0) for i in range(n)]
    streams["good_beta"] = ([i for i in range(n) if gbz[i] is not None], [gbz[i] for i in range(n) if gbz[i] is not None])
    streams["bad_beta"] = ([i for i in range(n) if bbz[i] is not None], [bbz[i] for i in range(n) if bbz[i] is not None])

    # PSA: 방향별 final 만, psa_state_at 재사용 (available_at ≤ t)
    ev_pos = ev_neg = None
    sess_arr = np.array(dates, dtype="datetime64[D]")
    if psa_events is not None and len(psa_events):
        ev = psa_events[psa_events["scope"].astype(str) == scope]
        ev_pos = ev[ev["direction"] == 1]
        ev_neg = ev[ev["direction"] == -1]

    def _psa(evs: Optional[pd.DataFrame], i: int) -> dict[str, Any]:
        if evs is None or evs.empty:
            return {"state": None, "n_obs": 0, "dist_last": None}
        st = psa_state_at(evs, dates[i], scope, sessions=dates, halflife=EWMA_HALFLIFE_SESSIONS)
        if st["psa_state"] is None:
            return {"state": None, "n_obs": 0, "dist_last": None}
        pos_obs = int(np.searchsorted(sess_arr, np.datetime64(st["last_available_at"]), side="right")) - 1
        # evidence_n = 창(120 세션) 안 관측 수
        av = pd.to_datetime(evs.loc[(evs["status"] == "final") & evs["psa_z"].notna(), "available_at"]).dt.date
        pos_all = np.searchsorted(sess_arr, np.array(list(av), dtype="datetime64[D]"), side="right") - 1
        n_in = int(np.sum((pos_all <= i) & (pos_all > i - OBS_WINDOW_SESSIONS)))
        return {"state": clip_z(st["psa_state"]), "n_obs": n_in, "dist_last": max(0, i - pos_obs)}

    rows: list[dict[str, Any]] = []
    for i in range(n):
        ev_good: dict[str, dict[str, Any]] = {}
        ev_bad: dict[str, dict[str, Any]] = {}
        for k in ("good_err", "good_beta", "good_gap", "good_flow"):
            ev_good[k] = ewma_state(*streams[k], i)
        for k in ("bad_err", "bad_beta", "bad_gap", "bad_flow"):
            ev_bad[k] = ewma_state(*streams[k], i)
        ev_good["good_psa"] = _psa(ev_pos, i)
        ev_bad["bad_psa"] = _psa(ev_neg, i)
        ev_good["good_shock"] = {"state": None, "n_obs": 0, "dist_last": None}
        ev_bad["bad_shock"] = {"state": None, "n_obs": 0, "dist_last": None}
        g = state_from_evidence(ev_good, GOOD_EVIDENCE)
        b = state_from_evidence(ev_bad, BAD_EVIDENCE)
        rows.append({
            "date": dates[i], "scope": scope,
            "good_acceptance": g["score"], "good_status": g["status"], "good_state_confidence": g["state_confidence"],
            "good_evidence_n": g["evidence_n"], "good_available_evidence": g["available_evidence"], "good_agreement": g["agreement"],
            "good_freshness": g["freshness"],
            "bad_resilience": b["score"], "bad_status": b["status"], "bad_state_confidence": b["state_confidence"],
            "bad_evidence_n": b["evidence_n"], "bad_available_evidence": b["available_evidence"], "bad_agreement": b["agreement"],
            "bad_freshness": b["freshness"],
            "ev_good_err": ev_good["good_err"]["state"], "ev_good_beta": ev_good["good_beta"]["state"], "ev_good_gap": ev_good["good_gap"]["state"],
            "ev_good_psa": ev_good["good_psa"]["state"], "ev_good_flow": ev_good["good_flow"]["state"],
            "ev_bad_err": ev_bad["bad_err"]["state"], "ev_bad_beta": ev_bad["bad_beta"]["state"], "ev_bad_gap": ev_bad["bad_gap"]["state"],
            "ev_bad_psa": ev_bad["bad_psa"]["state"], "ev_bad_flow": ev_bad["bad_flow"]["state"],
        })
    return pd.DataFrame(rows, columns=list(UPPER_COLUMNS))
