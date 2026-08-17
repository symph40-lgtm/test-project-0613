"""A-3 검출 테스트 — sticky 가점(+0.3)이 매일 누적되어 현 regime 에서 탈출 불가능하던 결함.

수정 방향: 가점 누적 대신 **전환 임계 방식** — 신규 regime 확률이 (현 regime 확률 + margin 0.15)를
          2일 연속 초과할 때만 전환.
검출 조건: 인위적 강신호 시계열에서 전환이 실제 발생, 1일만 초과하면 전환 안 됨.
"""
from __future__ import annotations

from mtpro.core.errata import regime_transition


def _p(winter=0.0, thaw=0.0, spring=0.0, cooling=0.0):
    return {"winter": winter, "thaw": thaw, "spring": spring, "cooling": cooling}


def test_strong_signal_series_actually_transitions():
    """현 regime=winter, spring 확률이 연속으로 압도 → 2일째 전환. 며칠이 지나도 붙잡히면 안 된다."""
    state = None
    current = "winter"
    series = [_p(winter=0.1, spring=0.9)] * 5
    transitioned_on = None
    for day, probs in enumerate(series, start=1):
        current, state = regime_transition(current, probs, margin=0.15, streak_state=state)
        if current == "spring" and transitioned_on is None:
            transitioned_on = day
    assert current == "spring"
    assert transitioned_on == 2  # 1일차 후보 등록, 2일차 확정


def test_single_day_exceed_does_not_transition():
    state = None
    current = "winter"
    # 1일 강신호 후 바로 되돌아옴 → 전환 없음, streak 리셋
    current, state = regime_transition(current, _p(winter=0.1, spring=0.9), streak_state=state)
    assert current == "winter"
    assert state["candidate"] == "spring" and state["days"] == 1
    current, state = regime_transition(current, _p(winter=0.8, spring=0.2), streak_state=state)
    assert current == "winter"
    assert state["candidate"] is None and state["days"] == 0
    # 다시 1일 초과 → 여전히 전환 없음 (누적되지 않았음을 확인)
    current, state = regime_transition(current, _p(winter=0.1, spring=0.9), streak_state=state)
    assert current == "winter"
    assert state["days"] == 1


def test_margin_is_respected():
    # 초과폭이 margin 미만이면 아무리 연속이어도 전환 없음
    state = None
    current = "winter"
    for _ in range(5):
        current, state = regime_transition(current, _p(winter=0.45, spring=0.55), margin=0.15, streak_state=state)
    assert current == "winter"
    assert state["days"] == 0


def test_alternating_candidates_do_not_accumulate():
    # spring → thaw → spring 로 후보가 바뀌면 streak 는 1에서 다시 시작해야 한다
    state = None
    current = "winter"
    current, state = regime_transition(current, _p(winter=0.1, spring=0.9), streak_state=state)
    current, state = regime_transition(current, _p(winter=0.1, thaw=0.9), streak_state=state)
    assert current == "winter" and state["candidate"] == "thaw" and state["days"] == 1
    current, state = regime_transition(current, _p(winter=0.1, spring=0.9), streak_state=state)
    assert current == "winter" and state["candidate"] == "spring" and state["days"] == 1


def test_streak_resets_after_transition():
    state = None
    current = "winter"
    for _ in range(2):
        current, state = regime_transition(current, _p(winter=0.1, spring=0.9), streak_state=state)
    assert current == "spring"
    assert state == {"candidate": None, "days": 0}


def test_initial_state_without_current_takes_argmax():
    current, state = regime_transition(None, _p(winter=0.2, spring=0.7, thaw=0.1), streak_state=None)
    assert current == "spring"
    assert state == {"candidate": None, "days": 0}


def test_input_state_is_not_mutated():
    state = {"candidate": None, "days": 0}
    regime_transition("winter", _p(winter=0.1, spring=0.9), streak_state=state)
    assert state == {"candidate": None, "days": 0}
