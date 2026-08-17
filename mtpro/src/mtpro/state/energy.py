"""Energy — primitive 3-family 결합 (계획서 §3.5 + §12.2 contribution cap 알고리즘, T5-5).

    Energy_t = round(100·tanh(Σ_f c_f)),  c_f = w'_f·s_f,  w = R .40 / PA .35 / P .25 (가용 family 로 재정규화), min 2 family (아니면 None)
    cap: 절대 기여 share ≤ 0.6 — §12.2 1~6 그대로 (아래 apply_cap). tanh·클립·min 규칙은 core.errata.energy(A-6) 와 정합
    (errata.energy 는 컴포넌트별 tanh 후 가중합; family 결합은 §12.2-6 "tanh(Σc)" 이므로 별도 함수 — 재정규화·None 제외·round 규칙은 동일).
    energy_confidence = Σ w_f·conf_f / Σ w_f (가용 family, [0,1]).
    상위 상태(Good Acceptance/Bad Resilience)·Divergence 는 **인자로 존재하지 않는다**(§5·§6 자기참조 차단 — 테스트로 고정).

challenger (shadow, champion 교체 불가): E-ORTH(Gram–Schmidt 잔차화 R→P→PA, 과거 120 세션 OLS) · E-EQ(균등 가중) · E-NOCAP(cap 없음).
"""
from __future__ import annotations

import math
from typing import Any, Mapping, Optional, Sequence

import numpy as np

from mtpro.components.rolling import is_finite
from mtpro.core.errata import _clip_int, _is_missing
from mtpro.state.families import FAMILIES, Z_MIN_SAMPLES, Z_WINDOW_DAYS

# ---- 사전 등록 상수 (config energy_family 블록과 일치 테스트) ----------------------------------------------------
FAMILY_WEIGHTS: dict[str, float] = {"R": 0.40, "PA": 0.35, "P": 0.25}
MIN_FAMILIES: int = 2
CAP_SHARE: float = 0.6
CAP_FACTOR: float = 1.5                  # share 를 정확히 0.6 으로 만드는 배수 = 0.6/(1−0.6)
CAP_EPS: float = 1e-9                    # 다른 family 기여 합 < eps → cap 미정의
ENERGY_CHALLENGERS: tuple[str, ...] = ("E-ORTH", "E-EQ", "E-NOCAP")
ORTH_ORDER: tuple[str, ...] = ("R", "P", "PA")   # E-ORTH 잔차화 순서
EQ_WEIGHTS: dict[str, float] = {"R": 1.0 / 3.0, "PA": 1.0 / 3.0, "P": 1.0 / 3.0}


class EnergyInputError(ValueError):
    pass


def _sign(x: float) -> float:
    return 1.0 if x > 0 else (-1.0 if x < 0 else 0.0)


def apply_cap(
    contribs: Mapping[str, float],
    *,
    cap_share: float = CAP_SHARE,
    cap_factor: float = CAP_FACTOR,
    eps: float = CAP_EPS,
) -> dict[str, Any]:
    """§12.2 3~5 (+4b): 기여 dict → cap 후 기여·share·플래그.

    3. share_f = |c_f| / Σ|c|
    4. max share > 0.6: c_f ← sign·1.5·Σ_{g≠f}|c_g|, 초과분(|c_원|−|c_cap|)을 나머지에 |c_g| 가중비례 재배분 1회 (c_g ← c_g·(1+excess/Σ_others))
    4b. 재검사 1회: share > 0.6 인 family 를 sign·1.5·Σ_others 로 cap, 잔여 버림. 이후 반복 없음.
    5. Σ_{g≠f}|c_g| < eps → cap 미적용, cap_undefined=True.

    Returns: {"contribs": {f: c}, "shares": {f: share|None}, "cap_applied": bool, "cap_family": str|None,
              "cap_undefined": bool, "recap_family": str|None, "excess_discarded": float}
    """
    c = {k: float(v) for k, v in contribs.items()}
    if any(_is_missing(v) for v in c.values()):
        raise EnergyInputError("contributions must be finite")
    out: dict[str, Any] = {"cap_applied": False, "cap_family": None, "cap_undefined": False, "recap_family": None,
                           "excess_discarded": 0.0}

    def _shares(cc: dict[str, float]) -> dict[str, Optional[float]]:
        tot = sum(abs(v) for v in cc.values())
        if tot < eps:
            return {k: None for k in cc}
        return {k: abs(v) / tot for k, v in cc.items()}

    sh = _shares(c)
    if all(v is None for v in sh.values()):
        out.update({"contribs": c, "shares": sh})
        return out
    fmax = max(c, key=lambda k: abs(c[k]))
    if sh[fmax] is not None and sh[fmax] > cap_share:
        others = sum(abs(v) for k, v in c.items() if k != fmax)
        if others < eps:
            out["cap_undefined"] = True
            out.update({"contribs": c, "shares": sh})
            return out
        new = _sign(c[fmax]) * cap_factor * others
        excess = abs(c[fmax]) - abs(new)
        c[fmax] = new
        for k in c:
            if k != fmax:
                c[k] = c[k] * (1.0 + excess / others)
        out["cap_applied"] = True
        out["cap_family"] = fmax
        # 4b 재검사 1회
        sh2 = _shares(c)
        f2 = max(c, key=lambda k: abs(c[k]))
        if sh2[f2] is not None and sh2[f2] > cap_share:
            others2 = sum(abs(v) for k, v in c.items() if k != f2)
            if others2 < eps:
                out["cap_undefined"] = True
            else:
                new2 = _sign(c[f2]) * cap_factor * others2
                out["excess_discarded"] = abs(c[f2]) - abs(new2)
                c[f2] = new2
                out["recap_family"] = f2
    out.update({"contribs": c, "shares": _shares(c)})
    return out


def combine_families(
    scores: Mapping[str, Optional[float]],
    confs: Mapping[str, Optional[float]],
    *,
    weights: Mapping[str, float] = FAMILY_WEIGHTS,
    min_families: int = MIN_FAMILIES,
    cap: bool = True,
) -> dict[str, Any]:
    """§3.5·§12.2: family 점수 → Energy.

    Args:
        scores: {family: s_f|None} (s_f ∈ [−3,3] — families.family_score 출력)
        confs:  {family: conf|None}
        weights: 사전 등록 가중 (E-EQ 는 EQ_WEIGHTS)
        cap: False → E-NOCAP
    Returns:
        {"energy": int|None, "energy_confidence": float|None, "families_used": [..], "weights_used": {..}, "contribs": {..},
         "shares": {..}, "cap_applied", "cap_family", "cap_undefined", "sum_c": float|None}
    """
    unknown = [k for k in scores if k not in weights]
    if unknown:
        raise EnergyInputError(f"families without registered weight: {unknown}")
    for k, w in weights.items():
        if _is_missing(w) or w <= 0:
            raise EnergyInputError(f"weight for {k!r} must be positive finite")
    avail = [f for f in FAMILIES if f in scores and not _is_missing(scores.get(f))]
    base = {"energy": None, "energy_confidence": None, "families_used": avail, "weights_used": {}, "contribs": {},
            "shares": {f: None for f in FAMILIES}, "cap_applied": False, "cap_family": None, "cap_undefined": False, "sum_c": None}
    if len(avail) < min_families:
        return base
    wsum = sum(weights[f] for f in avail)
    w_used = {f: weights[f] / wsum for f in avail}
    contribs = {f: w_used[f] * float(scores[f]) for f in avail}  # type: ignore[arg-type]
    if cap:
        capped = apply_cap(contribs)
        contribs = capped["contribs"]
        shares = capped["shares"]
        cap_applied, cap_family, cap_undefined = capped["cap_applied"], capped["cap_family"], capped["cap_undefined"]
    else:
        tot = sum(abs(v) for v in contribs.values())
        shares = {f: (abs(v) / tot if tot >= CAP_EPS else None) for f, v in contribs.items()}
        cap_applied, cap_family, cap_undefined = False, None, False
    sum_c = float(sum(contribs.values()))
    conf_vals = [(f, confs.get(f)) for f in avail]
    econf = None
    if all(not _is_missing(v) for _, v in conf_vals):
        econf = float(sum(w_used[f] * float(v) for f, v in conf_vals))  # type: ignore[arg-type]
    return {
        "energy": _clip_int(100.0 * math.tanh(sum_c)),
        "energy_confidence": econf,
        "families_used": avail,
        "weights_used": w_used,
        "contribs": contribs,
        "shares": {f: shares.get(f) for f in FAMILIES},
        "cap_applied": cap_applied, "cap_family": cap_family, "cap_undefined": cap_undefined,
        "sum_c": sum_c,
    }


# ---------------------------------------------------------------------------
# challenger E-ORTH: Gram–Schmidt 잔차화 (R → P → PA), 과거 120 세션 OLS(t−1까지, 표본<60 None)
# ---------------------------------------------------------------------------

def orthogonalize_scores(
    series: Mapping[str, Sequence[Optional[float]]],
    *,
    order: Sequence[str] = ORTH_ORDER,
    window: int = Z_WINDOW_DAYS,
    min_samples: int = Z_MIN_SAMPLES,
) -> dict[str, list[Optional[float]]]:
    """family 점수 시계열(세션 정렬)을 순서대로 앞선 family(잔차화된 값)에 대해 과거 창 OLS 로 잔차화.

    R' = R ; P' = P − b_PR·R (b 는 [t−window, t−1] 표본, 절편 포함) ; PA' = PA − b1·R − b2·P' (다변량 OLS).
    표본 부족 → None. 결측 None 유지. 값은 [−3,3] 밖으로 나갈 수 있어 최종 ±3 클립.
    """
    keys = list(order)
    n = len(series[keys[0]])
    out: dict[str, list[Optional[float]]] = {keys[0]: [float(v) if is_finite(v) else None for v in series[keys[0]]]}
    for j in range(1, len(keys)):
        y = series[keys[j]]
        preds = [out[k] for k in keys[:j]]
        res: list[Optional[float]] = [None] * n
        for i in range(n):
            if not is_finite(y[i]) or any(p[i] is None for p in preds):
                continue
            lo = max(0, i - window)
            rows = [k for k in range(lo, i) if is_finite(y[k]) and all(p[k] is not None for p in preds)]
            if len(rows) < min_samples:
                continue
            X = np.column_stack([np.ones(len(rows))] + [np.asarray([p[k] for k in rows], dtype=float) for p in preds])
            yy = np.asarray([float(y[k]) for k in rows], dtype=float)
            try:
                beta, *_ = np.linalg.lstsq(X, yy, rcond=None)
            except np.linalg.LinAlgError:
                continue
            xt = np.asarray([1.0] + [float(p[i]) for p in preds])  # type: ignore[arg-type]
            r = float(y[i]) - float(xt @ beta)
            res[i] = float(min(3.0, max(-3.0, r)))
        out[keys[j]] = res
    return out


__all__ = ["FAMILY_WEIGHTS", "MIN_FAMILIES", "CAP_SHARE", "CAP_FACTOR", "CAP_EPS", "ENERGY_CHALLENGERS", "EQ_WEIGHTS", "ORTH_ORDER",
           "apply_cap", "combine_families", "orthogonalize_scores"]
