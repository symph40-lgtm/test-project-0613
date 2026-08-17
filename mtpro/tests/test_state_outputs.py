"""T5-5 출력 산식 — ΔMT · Divergence · Regime · 텍스트 (계획서 §6)."""
import inspect
import math

import pytest

from mtpro.core import errata
from mtpro.state import outputs as OU


def test_delta_mt_is_errata_delta_from_history():
    hist = [0, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 30, 50, 70, 90, 100]
    assert OU.delta_mt(hist) == errata.delta_from_history(hist)
    assert OU.delta_mt(hist) is not None and OU.delta_mt(hist) > 0
    assert OU.delta_mt([1, 2, None, 4, 5]) is None


def test_divergence_and_regime_signatures_have_no_divergence_argument():
    """§6 자기참조 차단: Regime·Energy 함수 시그니처에 div 인자 없음."""
    from mtpro.state import energy as EN
    for fn in (OU.regime_step, OU.regime_series, errata.classify_regime, errata.regime_transition, EN.combine_families):
        assert not any("div" in p.lower() for p in inspect.signature(fn).parameters), fn.__name__


def test_divergence_label_rules():
    assert OU.divergence_label(1.2, -0.3) == "positive"
    assert OU.divergence_label(1.2, 0.3) is None            # 가격 z 양이면 양의 다이버전스 아님
    assert OU.divergence_label(-1.0, 0.2) == "negative"
    assert OU.divergence_label(-1.0, -0.2) is None
    assert OU.divergence_label(0.9, -0.5) is None
    assert OU.divergence_label(None, -0.5) is None


def test_divergence_series_uses_past_only_z_and_min_samples():
    n = 260
    energy = [10 * math.sin(i / 15.0) for i in range(n)]
    lnp = [math.log(100 + 5 * math.cos(i / 15.0)) for i in range(n)]
    d = OU.divergence_series(energy, lnp)
    first = next(i for i, v in enumerate(d["divergence"]) if v is not None)
    # 기울기 창 20 → 첫 기울기 idx 19; z 는 과거 60 개 기울기 필요 → 19+60 = 79
    assert first == OU.DIV_SLOPE_DAYS - 1 + OU.DIV_Z_MIN_SAMPLES
    # 미래 변조 → 과거 불변
    energy2 = list(energy); energy2[200:] = [99.0] * (n - 200)
    d2 = OU.divergence_series(energy2, lnp)
    assert d["divergence"][:200] == d2["divergence"][:200]
    # 결측 Energy 가 창에 있으면 None
    energy3 = list(energy); energy3[150] = None
    d3 = OU.divergence_series(energy3, lnp)
    assert all(d3["divergence"][i] is None for i in range(150, 150 + OU.DIV_SLOPE_DAYS))


def test_regime_series_starts_at_first_non_fallback_and_transitions_by_a3():
    n = 80
    energy = [None] * 5 + [-40] * 40 + [60] * (n - 45)
    delta = [0] * n
    bad = [-10] * 45 + [10] * (n - 45)
    breadth = [1.0] * n
    r = OU.regime_series(energy, delta, bad, breadth)
    labels = r["label"]
    first = next(i for i, v in enumerate(labels) if v is not None)
    assert first >= 5 + OU.REGIME_EMA_MIN_OBS - 1
    assert labels[first] == "winter"
    assert "spring" in labels[first:]
    i_spring = labels.index("spring")
    assert r["transition"][i_spring] is True and r["transition"][i_spring - 1] is False
    assert sum(1 for t in r["transition"] if t) == 1
    for p in r["probs"]:
        if p is not None:
            assert abs(sum(p.values()) - 1) < 1e-9


def test_ema_series_ignores_none_and_requires_min_obs():
    e = OU.ema_series([None, 10, None, 20, 30], span=2, min_obs=2)
    assert e[0] is None and e[1] is None and e[2] is None and e[3] is not None and e[4] is not None


def test_text_mandatory_contrary_clause_when_fast_layer_disagrees():
    probs = {"winter": 0.7, "thaw": 0.1, "spring": 0.1, "cooling": 0.1}
    t = OU.compose_text("winter", probs, False, energy=-30, delta=0, good_acceptance=None, good_conf=None,
                        bad_resilience=62, bad_conf=58, divergence=1.4, divergence_label="positive")
    assert t.startswith("Winter 유지 (70%)")
    assert " / 그러나 " in t and "악재 내성 급개선(+62, conf 58)" in t and "MT 양의 다이버전스(+1.4)" in t
    assert t.endswith("— 강한 해빙 신호")
    # 반대 신호 없음 → 절 없음
    t0 = OU.compose_text("winter", probs, False, energy=-30, delta=-5, good_acceptance=-10, good_conf=20,
                         bad_resilience=-20, bad_conf=30, divergence=-0.5, divergence_label=None)
    assert " / 그러나 " not in t0 and t0 == "Winter 유지 (70%)"
    # 양의 regime 에서 Energy 음전 하나 → 냉각 조짐
    t1 = OU.compose_text("spring", {"winter": 0.1, "thaw": 0.1, "spring": 0.6, "cooling": 0.2}, True, energy=-5, delta=0,
                         good_acceptance=None, good_conf=None, bad_resilience=None, bad_conf=None, divergence=None, divergence_label=None)
    assert t1.startswith("Spring 전환 (60%) / 그러나 Energy 음전(-5) — 냉각 조짐")
    assert OU.compose_text(None, None, None, energy=1, delta=1, good_acceptance=None, good_conf=None, bad_resilience=None, bad_conf=None,
                           divergence=None, divergence_label=None) is None


def test_contrary_signals_thresholds():
    c = OU.contrary_signals("winter", energy=0, delta=15, good_acceptance=49, good_conf=1, bad_resilience=50, bad_conf=None,
                            divergence=None, divergence_label=None)
    assert c == ["악재 내성 급개선(+50, conf n/a)"]
    c2 = OU.contrary_signals("thaw", energy=-1, delta=-16, good_acceptance=-50, good_conf=10, bad_resilience=0, bad_conf=0,
                             divergence=-1.5, divergence_label="negative")
    assert len(c2) == 4 and c2[0].startswith("Energy 음전") and "ΔMT 하락(-16)" in c2
    with pytest.raises(ValueError):
        OU.contrary_signals("summer", energy=0, delta=0, good_acceptance=0, good_conf=0, bad_resilience=0, bad_conf=0,
                            divergence=0, divergence_label=None)


def test_dmt_challengers():
    e = [float(i) for i in range(30)]
    c1 = OU.delta_c1(e)
    assert c1[-1] is not None and c1[-1] > 0
    assert OU.delta_c2(list(range(80))) == errata.delta_from_history(list(range(80)), recent=3)
