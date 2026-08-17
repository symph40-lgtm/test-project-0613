"""출력 산식 champion — ΔMT · Price–MT Divergence · Regime · 텍스트 (계획서 §6, T5-5).

  ΔMT        = core.errata.delta_from_history(Energy 이력 [..t]) (AM-2: 최근 5일 OLS 기울기 → 이전 60일 일변화 분포 z(std 하한 1)×20, 클립 ±100)
  Divergence = z_slope20(Energy) − z_slope20(ln close): 20일 OLS 기울기(t−19..t, 결측 있으면 None) 를 자기 과거 120 거래일 기울기 분포
               (t−1까지, 표본<60 None) 로 z, 차이. 라벨: div ≥ +1 ∧ 가격 기울기 z < 0 → "positive" / div ≤ −1 ∧ 가격 z > 0 → "negative".
               **Regime·Energy 함수 시그니처에 div 인자 없음**(자기참조 차단 — 테스트로 고정).
  Regime     = core.errata.classify_regime(EMA20(Energy), ΔMT, Bad Resilience 상태값, breadth 레벨 z, prev_probs) (A-2 fallback)
               + core.errata.regime_transition(A-3: 마진 .15, 2일 연속). Good Acceptance 는 classify_regime 시그니처에 없어 미투입(해석 기록 ⑨).
               EMA20 = span 20 (α=2/21), Energy None 일은 건너뜀(ignore_na), 유효 관측 20 미만 None (해석 기록 ⑩).
               breadth 레벨 = breadth_panel.above_20d_ratio 의 z(t−1까지 120일, 표본<60 None, 클립 ±3) — "레벨" 원값은 [0,1] 이라 A-2 규칙의
               `breadth > 0` 판정이 무의미해지므로 z 로 통일(§12.4 z 규정, 해석 기록 ⑪ — 발주자 확인 사항).
  텍스트     = "{Regime} 유지 ({p:.0%})" (+ 전환일 "{Regime} 전환") ; 빠른 층 부호가 Regime 과 어긋나면 반드시 " / 그러나 {근거들} — {해석}".
               Regime 극성: winter·cooling = −, thaw·spring = +. 반대 신호(임계 사전 등록): Energy 부호 반대(≠0), ΔMT ∓15 초과,
               Good Acceptance ≥ +50 / ≤ −50, Bad Resilience ≥ +50 / ≤ −50, Divergence 라벨(positive/negative). 근거에 state_confidence 병기.

challenger (shadow): DMT-C1 = EMA3−EMA10(Energy), DMT-C2 = 3일 기울기(delta_from_history recent=3);
                     DIV-C1 = 10일 기울기, DIV-C2 = 레벨 z(E 20일 평균) − z(r20), DIV-C3 = z 창 60, DIV-C4 = z 창 252.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

import numpy as np

from mtpro.components.rolling import is_finite, past_window, past_z
from mtpro.core.errata import REGIMES, RegimeClassification, classify_regime, delta_from_history, regime_transition

# ---- 사전 등록 상수 (config outputs 블록과 일치 테스트) ----------------------------------------------------------
DELTA_PARAMS: dict[str, float | int] = {"recent": 5, "hist_window": 60, "scale": 20.0, "min_changes": 5}
DIV_SLOPE_DAYS: int = 20
DIV_Z_WINDOW_DAYS: int = 120
DIV_Z_MIN_SAMPLES: int = 60
DIV_LABEL_THRESHOLD: float = 1.0
REGIME_EMA_SPAN: int = 20
REGIME_EMA_MIN_OBS: int = 20
REGIME_MARGIN: float = 0.15
REGIME_REQUIRED_DAYS: int = 2
BREADTH_LEVEL_SOURCE: str = "breadth_panel.above_20d_ratio -> z(120, min 60, clip 3)"
TEXT_DELTA_THRESHOLD: float = 15.0
TEXT_STATE_THRESHOLD: float = 50.0
TEXT_DIV_THRESHOLD: float = DIV_LABEL_THRESHOLD
REGIME_POLARITY: dict[str, int] = {"winter": -1, "cooling": -1, "thaw": +1, "spring": +1}
REGIME_KO: dict[str, str] = {"winter": "Winter", "thaw": "Thaw", "spring": "Spring", "cooling": "Cooling"}
DMT_CHALLENGERS: tuple[str, ...] = ("DMT-C1", "DMT-C2")
DIV_CHALLENGERS: tuple[str, ...] = ("DIV-C1", "DIV-C2", "DIV-C3", "DIV-C4")
DIV_CHALLENGER_PARAMS: dict[str, dict[str, int | str]] = {
    "DIV-C1": {"slope_days": 10, "z_window": 120},
    "DIV-C2": {"kind": "level", "mean_days": 20, "z_window": 120},
    "DIV-C3": {"slope_days": 20, "z_window": 60},
    "DIV-C4": {"slope_days": 20, "z_window": 252},
}
DMT_C1_SPANS: tuple[int, int] = (3, 10)
DMT_C2_RECENT: int = 3

DIV_POSITIVE = "positive"
DIV_NEGATIVE = "negative"


# ---------------------------------------------------------------------------
# ΔMT
# ---------------------------------------------------------------------------

def delta_mt(energy_hist: Sequence[Optional[int]]) -> Optional[int]:
    """ΔMT_t = errata.delta_from_history(Energy[..t]) — AM-2 그대로."""
    return delta_from_history(energy_hist, **DELTA_PARAMS)  # type: ignore[arg-type]


def delta_c2(energy_hist: Sequence[Optional[int]]) -> Optional[int]:
    p = dict(DELTA_PARAMS)
    p["recent"] = DMT_C2_RECENT
    return delta_from_history(energy_hist, **p)  # type: ignore[arg-type]


def ema_series(values: Sequence[Optional[float]], span: int, min_obs: int = 1) -> list[Optional[float]]:
    """None 을 건너뛰는(ignore_na) 지수이동평균 (adjust=False, α=2/(span+1)). 유효 관측 < min_obs 인 동안 None. 당일 None 이면 None
    (직전 EMA 는 내부에서 유지)."""
    if span < 1:
        raise ValueError("span must be >= 1")
    alpha = 2.0 / (span + 1.0)
    out: list[Optional[float]] = [None] * len(values)
    ema: Optional[float] = None
    k = 0
    for i, v in enumerate(values):
        if not is_finite(v):
            continue
        x = float(v)
        ema = x if ema is None else alpha * x + (1 - alpha) * ema
        k += 1
        if k >= min_obs:
            out[i] = ema
    return out


def delta_c1(energy: Sequence[Optional[float]]) -> list[Optional[float]]:
    """DMT-C1 = EMA3 − EMA10 (Energy)."""
    e3 = ema_series(energy, DMT_C1_SPANS[0])
    e10 = ema_series(energy, DMT_C1_SPANS[1])
    return [None if (a is None or b is None) else float(a - b) for a, b in zip(e3, e10)]


# ---------------------------------------------------------------------------
# Divergence
# ---------------------------------------------------------------------------

def slope_last(values: Sequence[Optional[float]], i: int, n: int) -> Optional[float]:
    """values[i−n+1..i] 의 OLS 기울기(x=0..n−1). 결측 있으면 None."""
    if i - n + 1 < 0:
        return None
    seg = values[i - n + 1: i + 1]
    if any(not is_finite(v) for v in seg):
        return None
    y = np.asarray([float(v) for v in seg], dtype=float)
    x = np.arange(n, dtype=float)
    return float(np.polyfit(x, y, 1)[0])


def slope_series(values: Sequence[Optional[float]], n: int) -> list[Optional[float]]:
    return [slope_last(values, i, n) for i in range(len(values))]


def divergence_series(
    energy: Sequence[Optional[float]],
    ln_close: Sequence[Optional[float]],
    *,
    slope_days: int = DIV_SLOPE_DAYS,
    z_window: int = DIV_Z_WINDOW_DAYS,
    z_min_samples: int = DIV_Z_MIN_SAMPLES,
    threshold: float = DIV_LABEL_THRESHOLD,
) -> dict[str, list]:
    """Divergence_t = z(slope_E) − z(slope_lnP), 각 z 는 자기 과거 z_window 기울기 분포(t−1까지). 라벨 규칙 §6.

    Returns: {"slope_e", "slope_p", "z_slope_e", "z_slope_p", "divergence", "label"}
    """
    n = len(energy)
    if len(ln_close) != n:
        raise ValueError("energy/ln_close length differ")
    se = slope_series(energy, slope_days)
    sp = slope_series(ln_close, slope_days)
    ze = [past_z(se, i, z_window, z_min_samples, clip_abs=None) for i in range(n)]
    zp = [past_z(sp, i, z_window, z_min_samples, clip_abs=None) for i in range(n)]
    div: list[Optional[float]] = [None] * n
    lab: list[Optional[str]] = [None] * n
    for i in range(n):
        if ze[i] is None or zp[i] is None:
            continue
        div[i] = float(ze[i] - zp[i])
        lab[i] = divergence_label(div[i], zp[i], threshold)
    return {"slope_e": se, "slope_p": sp, "z_slope_e": ze, "z_slope_p": zp, "divergence": div, "label": lab}


def divergence_label(div: Optional[float], price_z: Optional[float], threshold: float = DIV_LABEL_THRESHOLD) -> Optional[str]:
    if div is None or price_z is None:
        return None
    if div >= threshold and price_z < 0:
        return DIV_POSITIVE
    if div <= -threshold and price_z > 0:
        return DIV_NEGATIVE
    return None


def divergence_level_series(
    energy: Sequence[Optional[float]],
    ln_close: Sequence[Optional[float]],
    *,
    mean_days: int = 20,
    z_window: int = DIV_Z_WINDOW_DAYS,
    z_min_samples: int = DIV_Z_MIN_SAMPLES,
    threshold: float = DIV_LABEL_THRESHOLD,
) -> dict[str, list]:
    """DIV-C2: z(E 20일 평균) − z(r20), r20 = ln close_t − ln close_{t−20}."""
    n = len(energy)
    em: list[Optional[float]] = [None] * n
    r20: list[Optional[float]] = [None] * n
    for i in range(n):
        if i - mean_days + 1 >= 0:
            seg = energy[i - mean_days + 1: i + 1]
            if all(is_finite(v) for v in seg):
                em[i] = float(np.mean([float(v) for v in seg]))
        if i - mean_days >= 0 and is_finite(ln_close[i]) and is_finite(ln_close[i - mean_days]):
            r20[i] = float(ln_close[i]) - float(ln_close[i - mean_days])
    ze = [past_z(em, i, z_window, z_min_samples, clip_abs=None) for i in range(n)]
    zp = [past_z(r20, i, z_window, z_min_samples, clip_abs=None) for i in range(n)]
    div = [None if (a is None or b is None) else float(a - b) for a, b in zip(ze, zp)]
    lab = [divergence_label(d, p, threshold) for d, p in zip(div, zp)]
    return {"slope_e": em, "slope_p": r20, "z_slope_e": ze, "z_slope_p": zp, "divergence": div, "label": lab}


def divergence_challengers(energy: Sequence[Optional[float]], ln_close: Sequence[Optional[float]]) -> dict[str, dict[str, list]]:
    out: dict[str, dict[str, list]] = {}
    for name, p in DIV_CHALLENGER_PARAMS.items():
        if p.get("kind") == "level":
            out[name] = divergence_level_series(energy, ln_close, mean_days=int(p["mean_days"]), z_window=int(p["z_window"]))
        else:
            out[name] = divergence_series(energy, ln_close, slope_days=int(p["slope_days"]), z_window=int(p["z_window"]))
    return out


# ---------------------------------------------------------------------------
# Regime (느린 층)
# ---------------------------------------------------------------------------

def breadth_level_z(above_20d_ratio: Sequence[Optional[float]]) -> list[Optional[float]]:
    return [past_z(above_20d_ratio, i, DIV_Z_WINDOW_DAYS, DIV_Z_MIN_SAMPLES, clip_abs=3.0) for i in range(len(above_20d_ratio))]


def regime_step(
    energy_ema20: Optional[float],
    delta: Optional[float],
    bad_resilience: Optional[float],
    breadth_level: Optional[float],
    prev_probs: Optional[Mapping[str, float]],
    current: Optional[str],
    streak_state: Optional[dict],
) -> dict[str, Any]:
    """하루치 Regime: classify_regime(A-2) → regime_transition(A-3). Divergence·Good Acceptance 인자 없음(자기참조 차단·시그니처 고정).

    Returns: {"probs": {..}, "fallback": str, "penalty": float, "label": str, "transition": bool, "streak_state": {..}}
    """
    rc: RegimeClassification = classify_regime(energy_ema20, delta, bad_resilience, breadth_level,
                                               prev_probs=dict(prev_probs) if prev_probs is not None else None)
    label, streak = regime_transition(current, rc.probs, margin=REGIME_MARGIN, streak_state=streak_state,
                                      required_days=REGIME_REQUIRED_DAYS)
    return {"probs": rc.probs, "fallback": rc.fallback, "penalty": rc.confidence_penalty, "label": label,
            "transition": bool(current is not None and label != current), "streak_state": streak}


def regime_series(
    energy: Sequence[Optional[float]],
    delta: Sequence[Optional[float]],
    bad_resilience: Sequence[Optional[float]],
    breadth_level: Sequence[Optional[float]],
) -> dict[str, list]:
    """스코프 하나의 시계열 Regime. **시작 규칙(해석 기록 ⑫)**: EMA20 이 정의된 뒤 classify_regime 이 fallback 없이(조건 충족, fallback="none")
    확률을 낸 첫날부터 라벨을 확정한다. 그 전(조건 전부 미충족)은 A-2 uniform fallback → argmax 가 사전 순서(winter)로 고정되는 인공물이라
    라벨·확률 모두 None 으로 둔다(prev_probs 도 넘기지 않음)."""
    n = len(energy)
    ema = ema_series(energy, REGIME_EMA_SPAN, REGIME_EMA_MIN_OBS)
    probs: list[Optional[dict]] = [None] * n
    fallback: list[Optional[str]] = [None] * n
    penalty: list[Optional[float]] = [None] * n
    label: list[Optional[str]] = [None] * n
    trans: list[Optional[bool]] = [None] * n
    prev_probs: Optional[dict] = None
    current: Optional[str] = None
    streak: Optional[dict] = None
    started = False
    for i in range(n):
        if not started:
            if ema[i] is None:
                continue
            probe = classify_regime(ema[i], delta[i], bad_resilience[i], breadth_level[i], prev_probs=None)
            if probe.fallback != "none":
                continue
            started = True
        st = regime_step(ema[i], delta[i], bad_resilience[i], breadth_level[i], prev_probs, current, streak)
        probs[i], fallback[i], penalty[i], label[i], trans[i] = st["probs"], st["fallback"], st["penalty"], st["label"], st["transition"]
        prev_probs, current, streak = st["probs"], st["label"], st["streak_state"]
    return {"energy_ema20": ema, "probs": probs, "fallback": fallback, "penalty": penalty, "label": label, "transition": trans}


# ---------------------------------------------------------------------------
# 텍스트 템플릿 (반대 신호 병기 의무)
# ---------------------------------------------------------------------------

def _fmt_signed(v: float, nd: int = 0) -> str:
    return f"{v:+.{nd}f}"


def contrary_signals(
    regime_label: str,
    *,
    energy: Optional[float],
    delta: Optional[float],
    good_acceptance: Optional[float],
    good_conf: Optional[float],
    bad_resilience: Optional[float],
    bad_conf: Optional[float],
    divergence: Optional[float],
    divergence_label: Optional[str],
) -> list[str]:
    """Regime 극성과 어긋나는 빠른 층 근거 문구 목록 (사전 등록 임계). 빈 목록 = 반대 신호 없음."""
    pol = REGIME_POLARITY.get(regime_label)
    if pol is None:
        raise ValueError(f"unknown regime {regime_label!r}")
    out: list[str] = []
    conf_g = f", conf {int(good_conf)}" if good_conf is not None else ", conf n/a"
    conf_b = f", conf {int(bad_conf)}" if bad_conf is not None else ", conf n/a"
    if pol < 0:
        if energy is not None and energy > 0:
            out.append(f"Energy 양전({_fmt_signed(energy)})")
        if delta is not None and delta > TEXT_DELTA_THRESHOLD:
            out.append(f"ΔMT 상승({_fmt_signed(delta)})")
        if bad_resilience is not None and bad_resilience >= TEXT_STATE_THRESHOLD:
            out.append(f"악재 내성 급개선({_fmt_signed(bad_resilience)}{conf_b})")
        if good_acceptance is not None and good_acceptance >= TEXT_STATE_THRESHOLD:
            out.append(f"호재 수용 개선({_fmt_signed(good_acceptance)}{conf_g})")
        if divergence_label == DIV_POSITIVE and divergence is not None:
            out.append(f"MT 양의 다이버전스({_fmt_signed(divergence, 1)})")
    else:
        if energy is not None and energy < 0:
            out.append(f"Energy 음전({_fmt_signed(energy)})")
        if delta is not None and delta < -TEXT_DELTA_THRESHOLD:
            out.append(f"ΔMT 하락({_fmt_signed(delta)})")
        if bad_resilience is not None and bad_resilience <= -TEXT_STATE_THRESHOLD:
            out.append(f"악재 내성 급악화({_fmt_signed(bad_resilience)}{conf_b})")
        if good_acceptance is not None and good_acceptance <= -TEXT_STATE_THRESHOLD:
            out.append(f"호재 수용 악화({_fmt_signed(good_acceptance)}{conf_g})")
        if divergence_label == DIV_NEGATIVE and divergence is not None:
            out.append(f"MT 음의 다이버전스({_fmt_signed(divergence, 1)})")
    return out


def _interpretation(regime_label: str, n_contrary: int) -> str:
    pol = REGIME_POLARITY[regime_label]
    if pol < 0:
        return "강한 해빙 신호" if n_contrary >= 2 else "해빙 조짐"
    return "강한 냉각 경고" if n_contrary >= 2 else "냉각 조짐"


def compose_text(
    regime_label: Optional[str],
    regime_probs: Optional[Mapping[str, float]],
    transition: Optional[bool],
    *,
    energy: Optional[float],
    delta: Optional[float],
    good_acceptance: Optional[float],
    good_conf: Optional[float],
    bad_resilience: Optional[float],
    bad_conf: Optional[float],
    divergence: Optional[float],
    divergence_label: Optional[str],
) -> Optional[str]:
    """§6 템플릿. Regime 없으면 None. 반대 신호가 하나라도 있으면 반드시 " / 그러나 … — …" 절을 붙인다."""
    if regime_label is None or regime_probs is None:
        return None
    p = float(regime_probs.get(regime_label, 0.0))
    head = f"{REGIME_KO.get(regime_label, regime_label)} {'전환' if transition else '유지'} ({p:.0%})"
    contra = contrary_signals(regime_label, energy=energy, delta=delta, good_acceptance=good_acceptance, good_conf=good_conf,
                              bad_resilience=bad_resilience, bad_conf=bad_conf, divergence=divergence, divergence_label=divergence_label)
    if not contra:
        return head
    return f"{head} / 그러나 {'·'.join(contra)} — {_interpretation(regime_label, len(contra))}"


__all__ = [
    "DELTA_PARAMS", "DIV_SLOPE_DAYS", "DIV_Z_WINDOW_DAYS", "DIV_Z_MIN_SAMPLES", "DIV_LABEL_THRESHOLD", "REGIME_EMA_SPAN", "REGIME_EMA_MIN_OBS",
    "REGIME_MARGIN", "REGIME_REQUIRED_DAYS", "TEXT_DELTA_THRESHOLD", "TEXT_STATE_THRESHOLD", "REGIME_POLARITY", "REGIMES",
    "delta_mt", "delta_c1", "delta_c2", "ema_series", "slope_last", "divergence_series", "divergence_level_series",
    "divergence_challengers", "divergence_label", "breadth_level_z", "regime_step", "regime_series", "contrary_signals", "compose_text",
]
