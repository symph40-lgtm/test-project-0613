"""부록 A 결함 정오표(A-1~A-6) 수정 구현 — WORKORDER_MTPRO_v10.1 §2.3.

순수 함수만 둔다. 데이터 적재·파이프라인·크론 없음. 외부 의존은 numpy 뿐.
공통 규칙(§5 불변 규칙 3): 결측은 None 으로 유지한다. 0 대체 금지 — "중립"과 "모름"은 다르다.

DEV_COMPLETE_SPEC.md 의 부품 1·2·6·7 코드는 의도 전달용으로만 참고했고 그대로 옮기지 않았다.

| #   | 결함                                              | 이 모듈의 수정                                   |
|-----|---------------------------------------------------|--------------------------------------------------|
| A-1 | expected_std ≈ 0.5 상수 → ERR~N(0,1) 검증 무의미  | expected_std_rolling / err_z_std_check           |
| A-2 | regime 전 조건 불충족 시 확률합 0 (0.01 나눗셈)   | classify_regime (prev 유지·uniform fallback)     |
| A-3 | sticky 가점 누적 → 탈출 불가                      | regime_transition (2일 연속 마진 초과 시 전환)   |
| A-4 | 표본<2 → asymmetry 0.0 (중립≡모름)                | asymmetry (None + "insufficient")                |
| A-5 | attribution_quality 겹침 감지 미구현              | attribution_quality (1/n_overlap, 상수 등록)     |
| A-6 | Energy None → NaN 전파, Delta 미절단              | energy (재정규화·<3이면 None), delta_from_history |
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Iterable, NamedTuple, Optional, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# 공통
# ---------------------------------------------------------------------------

REGIMES: tuple[str, ...] = ("winter", "thaw", "spring", "cooling")


def _is_missing(x: object) -> bool:
    """None 또는 NaN 이면 결측. (NaN 은 None 으로 승격해 전파를 끊는다.)"""
    if x is None:
        return True
    try:
        return math.isnan(float(x))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False


def _clean(values: Iterable[Optional[float]]) -> list[float]:
    """결측(None/NaN) 제거 후 float 리스트."""
    return [float(v) for v in values if not _is_missing(v)]


def _clip_int(x: float, lo: int = -100, hi: int = 100) -> int:
    """반올림 후 [lo, hi] 정수 클립."""
    return int(max(lo, min(hi, round(x))))


# ---------------------------------------------------------------------------
# A-1  expected_std — 이벤트 유형별 회귀 잔차 rolling std
# ---------------------------------------------------------------------------

def expected_std_rolling(
    residuals_by_type: dict[str, Sequence[Optional[float]]],
    event_type: str,
    window: int = 20,
    floor: float = 0.1,
    min_samples: int = 3,
) -> Optional[float]:
    """이벤트 유형별 기대반응 회귀 잔차의 rolling 표준편차 (A-1).

    원 사양은 ``model.predict(단일 행).std() + 0.5`` 로 사실상 0.5 상수였다. 여기서는
    해당 유형의 최근 ``window`` 개 잔차의 표본 std(ddof=1)를 쓰고, 상수는 하한 ``floor`` 뿐이다.

    Args:
        residuals_by_type: {event_type: [잔차 = 실제 - 기대, 시간순(오래된→최신)]}. None/NaN 은 제외.
        event_type: 조회 유형.
        window: 최신 몇 개 잔차를 볼지.
        floor: std 하한 (0 나눗셈·과소 표준편차 방지). 유일한 상수.
        min_samples: 이 미만이면 std 를 정의하지 않고 None.

    Returns:
        max(rolling std, floor). 표본 부족·유형 없음이면 None (0 이나 floor 로 대체하지 않는다).
    """
    if window < 2:
        raise ValueError("window must be >= 2")
    vals = _clean(residuals_by_type.get(event_type, ()))
    if len(vals) < max(min_samples, 2):
        return None
    recent = np.asarray(vals[-window:], dtype=float)
    if recent.size < max(min_samples, 2):
        return None
    std = float(np.std(recent, ddof=1))
    return max(std, float(floor))


def err_z_std_check(
    err_z: Sequence[Optional[float]],
    lo: float = 0.7,
    hi: float = 1.3,
    min_samples: int = 10,
) -> Optional[bool]:
    """ERR_z ~ N(0,1) 캘리브레이션 검증: std(err_z) ∈ [lo, hi] (A-1 검출 테스트용 판정기).

    Returns:
        True/False. 표본 < min_samples 면 None (판정 보류 — 통과로 간주하지 않는다).
    """
    vals = _clean(err_z)
    if len(vals) < min_samples:
        return None
    s = float(np.std(np.asarray(vals), ddof=1))
    return bool(lo <= s <= hi)


# ---------------------------------------------------------------------------
# A-2  classify_regime — 전 조건 불충족 fallback
# ---------------------------------------------------------------------------

class RegimeClassification(NamedTuple):
    """classify_regime 결과.

    probs: {regime: 확률}, 합 = 1.0, NaN 없음.
    fallback: "none" (조건으로 산출) | "prev_regime" (직전 확률 유지) | "uniform" (직전 없음, 0.25 균등).
    confidence_penalty: fallback 시 Confidence 에서 감점할 점수(0~100 척도). 정상 산출은 0.
    """

    probs: dict[str, float]
    fallback: str
    confidence_penalty: float


FALLBACK_PENALTY_PREV: float = 10.0
FALLBACK_PENALTY_UNIFORM: float = 20.0

# 규칙 점수 (원 사양 값 유지; sticky 가점은 A-3 로 이관해 제거)
_REGIME_RULES = {
    "winter": (lambda e, d, b, br: e < -20 and b < 0, 0.5),
    "thaw": (lambda e, d, b, br: d > 15 and b > 0, 0.5),
    "spring": (lambda e, d, b, br: e > 30 and br > 0, 0.5),
    "cooling": (lambda e, d, b, br: e > 20 and d < -15, 0.4),
}


def _normalize_probs(scores: dict[str, float]) -> dict[str, float]:
    total = sum(scores.values())
    if not (total > 0) or math.isnan(total):
        raise ValueError("probabilities must have positive finite total")
    probs = {k: float(scores.get(k, 0.0)) / total for k in REGIMES}
    return probs


def _validate_probs(probs: dict[str, float]) -> dict[str, float]:
    if set(probs) != set(REGIMES):
        raise ValueError(f"probs keys must be {REGIMES}, got {sorted(probs)}")
    for k, v in probs.items():
        if _is_missing(v) or v < 0:
            raise ValueError(f"invalid probability for {k}: {v!r}")
    return _normalize_probs(probs)


def classify_regime(
    energy: Optional[float],
    delta: Optional[float],
    bad_resilience_z: Optional[float],
    breadth_impulse_z: Optional[float],
    prev_probs: Optional[dict[str, float]] = None,
) -> RegimeClassification:
    """Winter/Thaw/Spring/Cooling 확률 (A-2).

    규칙 점수: winter 0.5 (energy<-20 & bad<0), thaw 0.5 (delta>15 & bad>0),
    spring 0.5 (energy>30 & breadth>0), cooling 0.4 (energy>20 & delta<-15).
    결측(None/NaN) 입력은 해당 조건 미충족으로 본다.

    전 조건 미충족(합 0)이면 원 사양처럼 0.01 로 나누지 않고:
      - prev_probs 가 있으면 그대로 유지 (fallback="prev_regime", penalty 10)
      - 없으면 uniform 0.25 (fallback="uniform", penalty 20)
    sticky 가점은 여기서 주지 않는다 (A-3 regime_transition 이 전환을 담당).

    Returns:
        RegimeClassification(probs 합=1.0·NaN 없음, fallback, confidence_penalty)
    """
    prev_norm = _validate_probs(prev_probs) if prev_probs is not None else None

    def _f(x: Optional[float]) -> float:
        # 결측은 NaN 으로 → 모든 비교가 False = 조건 미충족 (0 대체가 아님)
        return float("nan") if _is_missing(x) else float(x)

    e, d, b, br = _f(energy), _f(delta), _f(bad_resilience_z), _f(breadth_impulse_z)
    scores = {k: 0.0 for k in REGIMES}
    for regime, (cond, score) in _REGIME_RULES.items():
        if cond(e, d, b, br):
            scores[regime] = score

    if sum(scores.values()) > 0:
        return RegimeClassification(_normalize_probs(scores), "none", 0.0)
    if prev_norm is not None:
        return RegimeClassification(prev_norm, "prev_regime", FALLBACK_PENALTY_PREV)
    return RegimeClassification({k: 0.25 for k in REGIMES}, "uniform", FALLBACK_PENALTY_UNIFORM)


# ---------------------------------------------------------------------------
# A-3  regime_transition — 전환 임계 방식 (가점 누적 금지)
# ---------------------------------------------------------------------------

def regime_transition(
    current: Optional[str],
    probs: dict[str, float],
    margin: float = 0.15,
    streak_state: Optional[dict] = None,
    required_days: int = 2,
) -> tuple[str, dict]:
    """전환 임계 방식 regime 전환 (A-3).

    원 사양의 sticky(+0.3/일 누적)는 현 regime 을 영구 고착시켰다. 여기서는 점수를 만지지 않고,
    **신규 regime 확률 > 현 regime 확률 + margin** 이 ``required_days``(기본 2)일 **연속** 성립할 때만 전환한다.
    연속이 끊기면 streak 는 0 으로 리셋되고, 후보가 바뀌면 1 부터 다시 센다 (누적 없음).

    Args:
        current: 현재 regime. None 이면 초기 상태 → argmax 로 즉시 확정.
        probs: classify_regime 결과 확률.
        margin: 전환 마진 (기본 0.15).
        streak_state: {"candidate": str|None, "days": int}. None 이면 초기화. 입력 dict 는 변경하지 않는다.
        required_days: 연속 초과 필요 일수.

    Returns:
        (new_regime, new_streak_state)
    """
    p = _validate_probs(probs)
    reset = {"candidate": None, "days": 0}
    if current is None:
        return max(REGIMES, key=lambda k: p[k]), dict(reset)
    if current not in REGIMES:
        raise ValueError(f"unknown regime {current!r}")

    state = dict(streak_state) if streak_state else dict(reset)
    challenger = max((k for k in REGIMES if k != current), key=lambda k: p[k])
    if p[challenger] > p[current] + margin:
        if state.get("candidate") == challenger:
            state["days"] = int(state.get("days", 0)) + 1
        else:
            state = {"candidate": challenger, "days": 1}
        if state["days"] >= required_days:
            return challenger, dict(reset)
        return current, state
    return current, dict(reset)


# ---------------------------------------------------------------------------
# A-4  asymmetry — 표본 부족 시 None + "insufficient"
# ---------------------------------------------------------------------------

def ewma_mean(values: Sequence[float], halflife: float = 15.0) -> float:
    """지수가중 평균. 마지막 원소가 최신, 가중치 w = 0.5 ** (age / halflife) (age=0 이 최신)."""
    if halflife <= 0:
        raise ValueError("halflife must be > 0")
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        raise ValueError("ewma_mean of empty sequence")
    ages = np.arange(arr.size - 1, -1, -1, dtype=float)
    w = 0.5 ** (ages / halflife)
    return float(np.sum(arr * w) / np.sum(w))


def asymmetry(
    err_z_good: Sequence[Optional[float]],
    err_z_bad: Sequence[Optional[float]],
    min_n: int = 2,
    halflife: float = 15.0,
) -> dict:
    """Good/Bad ERR 비대칭 (A-4).

    호재(surprise_z>+0.3) 이벤트의 ERR_z 와 악재(surprise_z<-0.3) 이벤트의 ERR_z 를 각각 EWMA(반감기 15) 로 요약.
    표본 < min_n 이면 값 None + status "insufficient" — 0.0 으로 대체하지 않는다 (중립 ≠ 모름).
    None/NaN 표본은 개수에서 제외한다.

    Returns:
        {"good_acceptance_z": float|None, "bad_resilience_z": float|None,
         "good_status": "ok"|"insufficient", "bad_status": ..., "good_n": int, "bad_n": int}
    """
    good = _clean(err_z_good)
    bad = _clean(err_z_bad)

    def _summ(vals: list[float]) -> tuple[Optional[float], str]:
        if len(vals) < min_n:
            return None, "insufficient"
        return ewma_mean(vals, halflife=halflife), "ok"

    g_val, g_status = _summ(good)
    b_val, b_status = _summ(bad)
    return {
        "good_acceptance_z": g_val,
        "bad_resilience_z": b_val,
        "good_status": g_status,
        "bad_status": b_status,
        "good_n": len(good),
        "bad_n": len(bad),
    }


# ---------------------------------------------------------------------------
# A-5  attribution_quality — 겹침 감점 공식 사전 등록
# ---------------------------------------------------------------------------

ATTRIBUTION_QUALITY_FORMULA: str = "1/n_overlap"
"""사전 등록 공식: quality = 1 / n_overlap, n_overlap = 자기 자신 포함 창이 겹치는 이벤트 수. 측정 후 변경 금지."""

RELEASE_TIME_WINDOW_MIN: int = 30
"""t0_mode="release_time" 이벤트의 겹침 창 반경(분): t0 ± 30분."""

T0_MODES: tuple[str, ...] = ("A1_open", "release_time")


def _event_window(ev: dict) -> tuple[datetime, datetime]:
    t0 = ev.get("t0")
    mode = ev.get("t0_mode")
    if not isinstance(t0, datetime):
        raise ValueError(f"event {ev.get('event_id')!r}: t0 must be datetime, got {t0!r}")
    if mode == "A1_open":
        # Amendment A-1: 개장 전 재료는 당일 09:00 시가로 정렬 → 점(point) 창. 같은 t0 만 겹침.
        return t0, t0
    if mode == "release_time":
        r = timedelta(minutes=RELEASE_TIME_WINDOW_MIN)
        return t0 - r, t0 + r
    raise ValueError(f"event {ev.get('event_id')!r}: t0_mode must be one of {T0_MODES}, got {mode!r}")


def attribution_quality(events: Sequence[dict]) -> dict[str, float]:
    """이벤트별 attribution_quality ∈ (0, 1] (A-5).

    이벤트 dict 필수 필드: event_id, t0(datetime), t0_mode ∈ {"A1_open","release_time"}.
    선택 필드: asset_scope — 값이 있으면 같은 scope 끼리만 겹침 판정 (없으면 전역).

    겹침 규칙(사전 등록):
      - 창: A1_open → [t0, t0] (같은 개장 t0 만), release_time → [t0-30m, t0+30m]
      - 어느 한쪽의 t0 가 다른 쪽의 창 안(경계 포함)에 들면 겹침.
        ⇒ A1/A1: 같은 t0, release/release: |Δt| ≤ 30분, A1/release: |Δt| ≤ 30분.
        쌍(pairwise) 판정, 추이적이지 않음.
      - quality = 1 / n_overlap  (ATTRIBUTION_QUALITY_FORMULA)

    Returns:
        {event_id: quality}. 단독 이벤트는 1.0, 동시각 2개는 0.5.
    """
    wins: list[tuple[str, object, datetime, datetime, datetime]] = []
    for ev in events:
        eid = ev.get("event_id")
        if not eid:
            raise ValueError("event_id required")
        lo, hi = _event_window(ev)
        wins.append((str(eid), ev.get("asset_scope"), ev["t0"], lo, hi))
    if len({w[0] for w in wins}) != len(wins):
        raise ValueError("duplicate event_id")

    out: dict[str, float] = {}
    for eid, scope, t0, lo, hi in wins:
        n_overlap = 1
        for oid, oscope, ot0, olo, ohi in wins:
            if oid == eid:
                continue
            if scope is not None and oscope is not None and scope != oscope:
                continue
            if (lo <= ot0 <= hi) or (olo <= t0 <= ohi):  # 상대 t0 가 내 창에, 또는 내 t0 가 상대 창에
                n_overlap += 1
        out[eid] = 1.0 / n_overlap
    return out


# ---------------------------------------------------------------------------
# A-6  energy / delta — None 제외·재정규화·클립
# ---------------------------------------------------------------------------

def energy(
    components: dict[str, Optional[float]],
    weights: dict[str, float],
    min_components: int = 3,
) -> dict:
    """MT-Energy (A-6, A-4 연동).

    각 컴포넌트 z 에 tanh 를 취해 가중합, ×100 후 반올림 정수, [-100,100] 클립.
    None/NaN 컴포넌트는 제외하고 남은 컴포넌트 가중치를 합=1 로 재정규화한다.
    가용 컴포넌트 < min_components 이면 energy=None (0 대체 금지).

    Args:
        components: {name: z|None}. 이름은 weights 에 있어야 한다.
        weights: {name: weight>0}. 사전 등록 가중치.
        min_components: Energy 산출 최소 컴포넌트 수.

    Returns:
        {"energy": int|None, "available_components": [name...] (components 순서),
         "weights_used": {name: 재정규화 가중치} (energy None 이면 {})}
    """
    unknown = [k for k in components if k not in weights]
    if unknown:
        raise ValueError(f"components without registered weight: {unknown}")
    for k, w in weights.items():
        if _is_missing(w) or w <= 0:
            raise ValueError(f"weight for {k!r} must be positive finite, got {w!r}")

    available = [k for k, v in components.items() if not _is_missing(v)]
    if len(available) < min_components:
        return {"energy": None, "available_components": available, "weights_used": {}}

    wsum = sum(weights[k] for k in available)
    weights_used = {k: weights[k] / wsum for k in available}
    raw = sum(math.tanh(float(components[k])) * weights_used[k] for k in available)  # type: ignore[arg-type]
    return {
        "energy": _clip_int(raw * 100.0),
        "available_components": available,
        "weights_used": weights_used,
    }


DELTA_SD_FLOOR: float = 1.0
"""Delta z 화 시 이력 변화량 std 하한. Energy 는 정수라 1점이 최소 의미 단위 — 완전 정체 이력에서 0 나눗셈 방지."""


def delta_from_history(
    energy_hist: Sequence[Optional[int]],
    recent: int = 5,
    hist_window: int = 60,
    scale: float = 20.0,
    min_changes: int = 5,
) -> Optional[int]:
    """MT-Delta: 최근 Energy 변화 속도 (A-6 보강 — 원 사양은 ±100 미절단).

    최근 ``recent`` 개 Energy 의 최소자승 기울기를, **최근 창 이전** ``hist_window`` 구간의 일간 변화량
    분포(평균·std, std 하한 DELTA_SD_FLOOR)로 z 화한 뒤 ×scale, 반올림 정수, **반드시 [-100,100] 클립**.

    설계 메모(원 사양 대비 차이, 기록): 원 사양은 기준 분포에 최근 창 자체를 포함했다. 그러면 극단 구간이
    자기 자신을 정규화해 |z| ≲ √n/2 로 묶이고 ±100 이 사실상 도달 불가였다. 여기서는 기준 분포를 최근 창
    이전으로 두어 "이전 대비 지금 얼마나 급한가"를 재며, 클립이 실제 의미를 갖게 했다.

    - 최근 창에 None 이 있으면 None (보간·0 대체 금지).
    - 기준 변화량(연속 non-None 쌍의 diff) 표본 < min_changes 면 None.

    Returns:
        int in [-100, 100] 또는 None.
    """
    if recent < 2:
        raise ValueError("recent must be >= 2")
    hist = list(energy_hist)
    if len(hist) < recent:
        return None
    tail = hist[-recent:]
    if any(_is_missing(v) for v in tail):
        return None
    y = np.asarray([float(v) for v in tail])  # type: ignore[arg-type]
    x = np.arange(recent, dtype=float)
    slope = float(np.polyfit(x, y, 1)[0])

    # 기준 분포: 최근 창의 첫 점까지 포함, 최근 창 내부 변화량(recent-1 개)은 제외
    base = hist[: len(hist) - (recent - 1)][-hist_window:]
    changes = [
        float(b) - float(a)  # type: ignore[arg-type]
        for a, b in zip(base[:-1], base[1:])
        if not _is_missing(a) and not _is_missing(b)
    ]
    if len(changes) < min_changes:
        return None
    ch = np.asarray(changes)
    sd = max(float(np.std(ch, ddof=1)), DELTA_SD_FLOOR)
    z = (slope - float(ch.mean())) / sd
    return _clip_int(z * scale)
