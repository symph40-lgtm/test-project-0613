"""primitive 3-family — Reaction / Price Acceptance / Participation (계획서 §3.1~§3.3, T5-5).

상류 gold 패널(읽기 전용)에서 컴포넌트를 모아 family 점수·conf 를 만든다. 컴포넌트 계산은 재구현하지 않는다.

공통(§3): 각 컴포넌트 클립 ±3 → family score s_f = 가용 컴포넌트 단순 평균(범위 [−3, 3]) → 최소 가용 R 1 / PA 2 / P 2 미달 → None.
family_conf = n_avail/n_total × freshness. 이벤트 기반 값의 일별 상태화 = available_at ≤ t 관측의 EWMA(반감기 10 세션).

Reaction (§3.1, 스코프별)
  err_signed_ewma      : Gap Reaction ERR(gap3g_panel.gap_reaction_err_z, A-1R) 재료일 관측의 EWMA(hl 10). **부호 규약(해석 기록 ①)**:
                         gap3g 의 err_z 는 수익률 공간 잔차 (gap − expected_gap)/σ 이므로 호재일 + = 기대보다 더 오름, 악재일 + = 기대보다
                         덜 내림(버팀) — 둘 다 "우호". 계획서 §3.1 의 "ERR_z × sign(surprise)" 는 ERR_z 를 재료 방향 공간(+ = 재료 방향으로
                         더 강하게 반응)으로 둘 때 같은 값이 된다. 여기서는 표의 부호 규정 "양 = 우호" 를 기준으로 수익률 공간 잔차를
                         그대로 쓴다(재료 방향 공간 값 = err_z × sign 은 `err_surprise_space` 열로 병기). 등급C: sign = sign(sox_ret_prev).
                         등급A 행(expected_gap_source=gradeA, T5-6)은 같은 열을 그대로 쓴다.
  beta_asym_z          : GoodBeta − BadBeta 의 z. GoodBeta/BadBeta = 최근 20 세션(t 포함) good(sox>0)/bad(sox<0) 재료일에서
                         gap_pct ≈ β·expected_gap (원점 통과 OLS, gradec.slope_through_origin 재사용), 클립 [0.3, 2.0], 표본<3 None
                         (등급C 상수 asym_window_days·gb_beta_min_n·gb_beta_clip 재사용 — 갭 기준 재추정, gradec_panel(open→close) 불사용).
  transmission_asym_z  : transmission_panel(role=component: 005930·000660). KOSPI200 은 config transmission.scopes_diagnostic → 진단 전용,
                         family 입력 아님(해석 기록 ②).
  freshness_R          : 가용 컴포넌트 중 가장 최근 관측 거리 d 세션 → 0.5^(d/10) (해석 기록 ③: §5 "가장 최근 관측 기준" 규약을 family 에도
                         적용 — 일별 컴포넌트(transmission 등)는 거리 0 → 가용하면 1, 이벤트 기반(ERR·beta_asym — 재료일 관측)만 가용하면 그
                         최근 재료일 거리. §3.3 "Participation freshness 1" 은 이 규칙의 결과. 대안 해석(이벤트 기반 컴포넌트만으로 freshness /
                         컴포넌트별 freshness 평균)은 보고서에 병기 — 발주자 확인 사항)

Price Acceptance (§3.2)
  shock_absorption_z   : 부품 3 장중(T5-6) — 컬럼 예약, None
  gap_hold_z           : gap3g_panel.gap_hold_z (일별 원값 — |gap|<0.3% 일 None)
  close_acceptance_z   : gap3g_panel.close_acceptance_z (일별 원값)
  psa_z                : components.psa.psa_state_at(final ∧ available_at ≤ t) 의 psa_state (EWMA hl 10)
  freshness_PA         : 위 규칙(가장 최근 관측) — gap_hold_z/CLV 가용이면 1, psa 만 가용이면 psa 관측 거리 기준

Participation (§3.3, freshness 1)
  flow_impact_residual_z (flow_panel, 스코프별) · breadth_impulse_z (breadth_panel, 시장 공통) · semi_diffusion_z (semi_diffusion_panel, 시장 공통)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Optional, Sequence

import numpy as np
import pandas as pd

from mtpro.components.gradec import slope_through_origin
from mtpro.components.psa import psa_state_at
from mtpro.components.rolling import clip, is_finite, past_z

ENGINE_VER = "mt_state-0.1"

# ---- 사전 등록 상수 (config energy_family 블록과 일치 테스트) ----------------------------------------------------
FAMILIES: tuple[str, ...] = ("R", "PA", "P")
FAMILY_COMPONENTS: dict[str, tuple[str, ...]] = {
    "R": ("err_signed_ewma", "beta_asym_z", "transmission_asym_z"),
    "PA": ("shock_absorption_z", "gap_hold_z", "close_acceptance_z", "psa_z"),
    "P": ("flow_impact_residual_z", "breadth_impulse_z", "semi_diffusion_z"),
}
FAMILY_MIN_AVAIL: dict[str, int] = {"R": 1, "PA": 2, "P": 2}
EVENT_BASED_COMPONENTS: dict[str, tuple[str, ...]] = {          # freshness 를 지배하는(이벤트 기반) 컴포넌트
    "R": ("err_signed_ewma", "beta_asym_z"),
    "PA": ("shock_absorption_z", "psa_z"),
    "P": (),
}
Z_CLIP_ABS: float = 3.0
Z_WINDOW_DAYS: int = 120
Z_MIN_SAMPLES: int = 60
EWMA_HALFLIFE_SESSIONS: float = 10.0
FRESHNESS_HALFLIFE_SESSIONS: float = 10.0
OBS_WINDOW_SESSIONS: int = 120           # EWMA 관측 창(세션). 창 밖 관측 가중 ≤ 0.5^12 — 사실상 0 (해석 기록 ④)
BETA_ASYM_WINDOW_SESSIONS: int = 20      # = grade_c.asym_window_days
BETA_ASYM_MIN_N: int = 3                 # = grade_c.gb_beta_min_n
BETA_ASYM_CLIP: tuple[float, float] = (0.3, 2.0)   # = grade_c.gb_beta_clip
TRANSMISSION_COMPONENT_SCOPES: tuple[str, ...] = ("005930", "000660")   # = transmission.scopes_component


class FamilyInputError(ValueError):
    """loud-failure: 입력 결손·스키마 위반은 조용히 넘어가지 않는다."""


# ---------------------------------------------------------------------------
# 공통 도우미
# ---------------------------------------------------------------------------

def _f(v: Any) -> Optional[float]:
    return float(v) if is_finite(v) else None


def clip_z(v: Optional[float], clip_abs: float = Z_CLIP_ABS) -> Optional[float]:
    return clip(v, -clip_abs, clip_abs)


def ewma_state(
    obs_pos: Sequence[int],
    obs_val: Sequence[float],
    pos_t: int,
    *,
    halflife: float = EWMA_HALFLIFE_SESSIONS,
    window: int = OBS_WINDOW_SESSIONS,
) -> dict[str, Any]:
    """세션 인덱스 pos_t 시점 상태: available 세션 pos ≤ pos_t (창: pos > pos_t − window) 관측의 EWMA(가중 0.5^(dist/halflife)).

    Returns: {"state": float|None, "n_obs": int, "dist_last": int|None, "freshness": float|None}
    """
    if halflife <= 0:
        raise ValueError("halflife must be > 0")
    keep = [(p, v) for p, v in zip(obs_pos, obs_val) if p <= pos_t and p > pos_t - window and is_finite(v)]
    if not keep:
        return {"state": None, "n_obs": 0, "dist_last": None, "freshness": None}
    d = np.asarray([pos_t - p for p, _ in keep], dtype=float)
    z = np.asarray([v for _, v in keep], dtype=float)
    w = np.power(0.5, d / halflife)
    dist_last = int(d.min())
    return {"state": float(np.sum(w * z) / np.sum(w)), "n_obs": int(len(z)), "dist_last": dist_last,
            "freshness": float(0.5 ** (dist_last / FRESHNESS_HALFLIFE_SESSIONS))}


def freshness_from_dist(dist: Optional[int], halflife: float = FRESHNESS_HALFLIFE_SESSIONS) -> Optional[float]:
    return None if dist is None else float(0.5 ** (max(0, int(dist)) / halflife))


def family_score(
    comps: dict[str, Optional[float]],
    family: str,
    *,
    clip_abs: float = Z_CLIP_ABS,
) -> dict[str, Any]:
    """family 점수 = 가용 컴포넌트 클립 z 단순 평균, 최소 가용 미달 → None.

    Returns: {"score", "n_avail", "n_total", "components_used": [names], "clipped": {name: clipped z}}
    """
    if family not in FAMILY_COMPONENTS:
        raise FamilyInputError(f"unknown family {family!r}")
    names = FAMILY_COMPONENTS[family]
    unknown = [k for k in comps if k not in names]
    if unknown:
        raise FamilyInputError(f"family {family}: unknown components {unknown}")
    clipped = {k: clip_z(comps.get(k), clip_abs) for k in names}
    used = [k for k in names if clipped[k] is not None]
    n_avail = len(used)
    score = float(np.mean([clipped[k] for k in used])) if n_avail >= FAMILY_MIN_AVAIL[family] and n_avail > 0 else None
    return {"score": score, "n_avail": n_avail, "n_total": len(names), "components_used": used, "clipped": clipped}


def family_conf(n_avail: int, n_total: int, freshness: Optional[float]) -> Optional[float]:
    """family_conf = n_avail/n_total × freshness (freshness None → 1: 이벤트 기반 컴포넌트 없음). n_avail 0 → None."""
    if n_avail <= 0:
        return None
    fr = 1.0 if freshness is None else float(freshness)
    return float(n_avail) / float(n_total) * fr


def family_freshness(family: str, comps_used: Sequence[str], comp_dist: dict[str, Optional[int]]) -> tuple[Optional[float], Optional[int]]:
    """family freshness = 가용 컴포넌트 중 **가장 최근 관측** 거리 d(세션) → 0.5^(d/10) (§5 "가장 최근 관측 기준" 과 동일 규약, 해석 기록 ③).

    일별 컴포넌트(transmission·gap_hold·CLV·flow·breadth·semi)의 관측 거리 = 0 → 그 컴포넌트가 가용하면 freshness 1
    (§3.3 Participation "freshness 1" 은 이 규칙의 결과). 이벤트 기반 컴포넌트(ERR·beta_asym·psa·shock)만 가용하면 그 최근 관측 거리.
    가용 컴포넌트 없음 → (None, None).
    """
    if not comps_used:
        return None, None
    dists: list[int] = []
    for k in comps_used:
        if k in EVENT_BASED_COMPONENTS[family]:
            d = comp_dist.get(k)
            if d is not None:
                dists.append(int(d))
        else:
            dists.append(0)
    if not dists:
        return None, None
    d = int(min(dists))
    return freshness_from_dist(d), d


# ---------------------------------------------------------------------------
# 입력 정리
# ---------------------------------------------------------------------------

def scope_rows(panel: pd.DataFrame, scope: str, cols: Sequence[str]) -> pd.DataFrame:
    """scope 행만 (date 정렬·중복 제거), date 는 datetime.date."""
    if "scope" not in panel.columns:
        raise FamilyInputError("panel has no 'scope' column")
    d = panel[panel["scope"].astype(str) == str(scope)].copy()
    if d.empty:
        raise FamilyInputError(f"no rows for scope {scope!r}")
    d["date"] = pd.to_datetime(d["date"]).dt.date
    d = d.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    missing = [c for c in cols if c not in d.columns]
    if missing:
        raise FamilyInputError(f"panel missing columns {missing}")
    return d[["date", *cols]]


def market_rows(panel: pd.DataFrame, cols: Sequence[str]) -> pd.DataFrame:
    d = panel.copy()
    d["date"] = pd.to_datetime(d["date"]).dt.date
    d = d.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    missing = [c for c in cols if c not in d.columns]
    if missing:
        raise FamilyInputError(f"market panel missing columns {missing}")
    return d[["date", *cols]]


# ---------------------------------------------------------------------------
# Reaction family
# ---------------------------------------------------------------------------

REACTION_COLUMNS: tuple[str, ...] = (
    "date", "scope", "expected_gap", "expected_gap_source", "gap_reaction_err_z", "err_obs", "err_sign", "err_surprise_space",
    "err_signed_ewma", "err_n_obs", "err_dist_last",
    "good_beta", "bad_beta", "good_beta_n", "bad_beta_n", "beta_asym", "beta_asym_z",
    "transmission_asym_z", "family_score_R", "family_conf_R", "freshness_R", "n_avail_R", "components_R",
)


def build_reaction(
    g3: pd.DataFrame,
    trans: Optional[pd.DataFrame],
    scope: str,
) -> pd.DataFrame:
    """scope 하나의 Reaction family 일별 패널. g3 = gap3g scope 행(scope_rows), trans = transmission scope 행 또는 None."""
    n = len(g3)
    dates = list(g3["date"])
    errz = [_f(v) for v in g3["gap_reaction_err_z"]]
    sox = [_f(v) for v in g3["sox_ret_prev"]]
    gap = [_f(v) for v in g3["gap_pct"]]
    exp = [_f(v) for v in g3["expected_gap"]]
    src = list(g3["expected_gap_source"]) if "expected_gap_source" in g3.columns else [None] * n
    grade = list(g3["grade"]) if "grade" in g3.columns else ["C"] * n

    # 재료 부호: 등급C = sign(sox_ret_prev). 등급A 행은 T5-6 이 surprise_sign 열을 채우면 그것을 쓴다(없으면 expected_gap 부호로 폴백 — 등급C 와 동일 규칙).
    surprise_sign = [_f(v) for v in g3["surprise_sign"]] if "surprise_sign" in g3.columns else [None] * n
    sign: list[Optional[float]] = [None] * n
    for i in range(n):
        s = None
        if str(grade[i]) == "A" and surprise_sign[i] is not None:
            s = surprise_sign[i]
        elif sox[i] is not None:
            s = sox[i]
        elif exp[i] is not None:
            s = exp[i]
        if s is not None and s != 0:
            sign[i] = 1.0 if s > 0 else -1.0

    obs = [clip_z(errz[i]) if (errz[i] is not None and sign[i] is not None) else None for i in range(n)]
    obs_pos = [i for i in range(n) if obs[i] is not None]
    obs_val = [obs[i] for i in obs_pos]
    err_sur = [obs[i] * sign[i] if obs[i] is not None else None for i in range(n)]

    err_ewma: list[Optional[float]] = [None] * n
    err_n: list[int] = [0] * n
    err_dist: list[Optional[int]] = [None] * n
    for i in range(n):
        st = ewma_state(obs_pos, obs_val, i)
        err_ewma[i], err_n[i], err_dist[i] = st["state"], st["n_obs"], st["dist_last"]

    # GoodBeta / BadBeta (갭 기준, 최근 20 세션 t 포함, 원점 통과 OLS gap ≈ β·expected_gap)
    lo_g, hi_g = BETA_ASYM_CLIP
    gb: list[Optional[float]] = [None] * n
    bb: list[Optional[float]] = [None] * n
    gbn: list[int] = [0] * n
    bbn: list[int] = [0] * n
    asym: list[Optional[float]] = [None] * n
    for i in range(n):
        w0 = max(0, i - BETA_ASYM_WINDOW_SESSIONS + 1)
        for lab, store, cnt in (("good", gb, gbn), ("bad", bb, bbn)):
            ks = [k for k in range(w0, i + 1)
                  if obs[k] is not None and gap[k] is not None and exp[k] is not None and sign[k] == (1.0 if lab == "good" else -1.0)]
            cnt[i] = len(ks)
            if len(ks) >= BETA_ASYM_MIN_N:
                store[i] = clip(slope_through_origin([exp[k] for k in ks], [gap[k] for k in ks]), lo_g, hi_g)
        if gb[i] is not None and bb[i] is not None:
            asym[i] = gb[i] - bb[i]
    asym_z = [past_z(asym, i, Z_WINDOW_DAYS, Z_MIN_SAMPLES, Z_CLIP_ABS) for i in range(n)]

    # transmission (component 스코프만)
    tr_z: list[Optional[float]] = [None] * n
    if trans is not None and scope in TRANSMISSION_COMPONENT_SCOPES:
        m = dict(zip(trans["date"], trans["transmission_asym_z"]))
        tr_z = [_f(m.get(d)) for d in dates]

    score: list[Optional[float]] = [None] * n
    conf: list[Optional[float]] = [None] * n
    fresh: list[Optional[float]] = [None] * n
    navail: list[int] = [0] * n
    used: list[list[str]] = [[] for _ in range(n)]
    for i in range(n):
        fs = family_score({"err_signed_ewma": err_ewma[i], "beta_asym_z": asym_z[i], "transmission_asym_z": tr_z[i]}, "R")
        score[i], navail[i], used[i] = fs["score"], fs["n_avail"], fs["components_used"]
        fr, _ = family_freshness("R", used[i], {"err_signed_ewma": err_dist[i], "beta_asym_z": err_dist[i]})
        fresh[i] = fr
        conf[i] = family_conf(navail[i], fs["n_total"], fr)

    return pd.DataFrame({
        "date": dates, "scope": scope,
        "expected_gap": exp, "expected_gap_source": src, "gap_reaction_err_z": errz, "err_obs": obs, "err_sign": sign,
        "err_surprise_space": err_sur, "err_signed_ewma": err_ewma, "err_n_obs": err_n, "err_dist_last": err_dist,
        "good_beta": gb, "bad_beta": bb, "good_beta_n": gbn, "bad_beta_n": bbn, "beta_asym": asym, "beta_asym_z": asym_z,
        "transmission_asym_z": tr_z,
        "family_score_R": score, "family_conf_R": conf, "freshness_R": fresh, "n_avail_R": navail, "components_R": used,
    })


# ---------------------------------------------------------------------------
# Price Acceptance family
# ---------------------------------------------------------------------------

PRICE_ACCEPT_COLUMNS: tuple[str, ...] = (
    "date", "scope", "shock_absorption_z", "gap_pct", "gap_hold", "gap_hold_z", "close_acceptance_z",
    "psa_z", "psa_n_obs", "psa_dist_last", "psa_last_available_at",
    "family_score_PA", "family_conf_PA", "freshness_PA", "n_avail_PA", "components_PA",
)


def build_price_accept(g3: pd.DataFrame, psa_events: Optional[pd.DataFrame], scope: str) -> pd.DataFrame:
    n = len(g3)
    dates: list[date] = list(g3["date"])
    hold_z = [_f(v) for v in g3["gap_hold_z"]]
    clv_z = [_f(v) for v in g3["close_acceptance_z"]]
    gap = [_f(v) for v in g3["gap_pct"]]
    hold = [_f(v) for v in g3["gap_hold"]]

    psa_z: list[Optional[float]] = [None] * n
    psa_n: list[int] = [0] * n
    psa_dist: list[Optional[int]] = [None] * n
    psa_last: list[Optional[date]] = [None] * n
    if psa_events is not None and len(psa_events):
        ev = psa_events[psa_events["scope"].astype(str) == scope]
        if len(ev):
            sess = list(dates)
            sess_arr = np.array(sess, dtype="datetime64[D]")
            for i, d in enumerate(dates):
                st = psa_state_at(ev, d, scope, sessions=sess, halflife=EWMA_HALFLIFE_SESSIONS)
                psa_z[i] = st["psa_state"]
                psa_n[i] = int(st["n_obs"])
                if st["last_available_at"] is not None:
                    psa_last[i] = st["last_available_at"]
                    pos_obs = int(np.searchsorted(sess_arr, np.datetime64(st["last_available_at"]), side="right")) - 1
                    psa_dist[i] = max(0, i - pos_obs)

    score: list[Optional[float]] = [None] * n
    conf: list[Optional[float]] = [None] * n
    fresh: list[Optional[float]] = [None] * n
    navail: list[int] = [0] * n
    used: list[list[str]] = [[] for _ in range(n)]
    for i in range(n):
        fs = family_score({"shock_absorption_z": None, "gap_hold_z": hold_z[i], "close_acceptance_z": clv_z[i], "psa_z": psa_z[i]}, "PA")
        score[i], navail[i], used[i] = fs["score"], fs["n_avail"], fs["components_used"]
        fr, _ = family_freshness("PA", used[i], {"psa_z": psa_dist[i]})
        fresh[i] = fr
        conf[i] = family_conf(navail[i], fs["n_total"], fr)

    return pd.DataFrame({
        "date": dates, "scope": scope, "shock_absorption_z": [None] * n,
        "gap_pct": gap, "gap_hold": hold, "gap_hold_z": hold_z, "close_acceptance_z": clv_z,
        "psa_z": psa_z, "psa_n_obs": psa_n, "psa_dist_last": psa_dist, "psa_last_available_at": psa_last,
        "family_score_PA": score, "family_conf_PA": conf, "freshness_PA": fresh, "n_avail_PA": navail, "components_PA": used,
    })


# ---------------------------------------------------------------------------
# Participation family
# ---------------------------------------------------------------------------

PARTICIPATION_COLUMNS: tuple[str, ...] = (
    "date", "scope", "flow_impact_residual_z", "breadth_impulse_z", "semi_diffusion_z",
    "family_score_P", "family_conf_P", "freshness_P", "n_avail_P", "components_P",
)


def build_participation(dates: Sequence[date], flow: pd.DataFrame, breadth: pd.DataFrame, semi: pd.DataFrame, scope: str) -> pd.DataFrame:
    fm = dict(zip(flow["date"], flow["flow_impact_residual_z"]))
    bm = dict(zip(breadth["date"], breadth["breadth_impulse_z"]))
    sm = dict(zip(semi["date"], semi["semi_diffusion_z"]))
    n = len(dates)
    fz = [_f(fm.get(d)) for d in dates]
    bz = [_f(bm.get(d)) for d in dates]
    sz = [_f(sm.get(d)) for d in dates]
    score: list[Optional[float]] = [None] * n
    conf: list[Optional[float]] = [None] * n
    navail: list[int] = [0] * n
    used: list[list[str]] = [[] for _ in range(n)]
    for i in range(n):
        fs = family_score({"flow_impact_residual_z": fz[i], "breadth_impulse_z": bz[i], "semi_diffusion_z": sz[i]}, "P")
        score[i], navail[i], used[i] = fs["score"], fs["n_avail"], fs["components_used"]
        conf[i] = family_conf(navail[i], fs["n_total"], None)
    return pd.DataFrame({
        "date": list(dates), "scope": scope, "flow_impact_residual_z": fz, "breadth_impulse_z": bz, "semi_diffusion_z": sz,
        "family_score_P": score, "family_conf_P": conf, "freshness_P": [1.0 if navail[i] > 0 else None for i in range(n)],
        "n_avail_P": navail, "components_P": used,
    })
