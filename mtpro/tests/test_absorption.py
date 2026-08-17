"""T5-6 부품 3 장중 6점 (components/absorption.py) — 합성 분봉 테스트.

- 6점: t0=09:00 시가 앵커, t1 09:05 / t3 09:30 / t4 14:30 = "시작시각 < HH:MM 인 마지막 봉 종가", t5 = 종가, t2 = 재료 방향 극값(호재 max high / 악재 min low)
- absorption_ratio: 악재 1−|t5|/|t2|, 호재 t5/t2, t2=0 None, 방향 None → None ; half_life
- 방향 표: 등급A(surprise 부호) 우선 → 등급C(sox 부호), 부호 충돌 None, sox None → None
- z: 스코프별 과거 전용 120 세션(t−1까지), 표본<60 None, 클립 ±3, 미래 변조 시 과거 불변
- partial(<300봉) → 6점 None, late_open(10:00 개장) → t1·t3 None, 상수-config 일치, 스키마 왕복
"""
from __future__ import annotations

import pathlib
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest
import yaml

from mtpro.components import absorption as A

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
P = A.AbsorptionParams()


def _times(start="09:00", n=391):
    h, m = map(int, start.split(":"))
    t = h * 60 + m
    out = []
    for i in range(n):
        tt = t + i
        if tt > 15 * 60 + 30:
            break
        out.append(f"{tt // 60:02d}:{tt % 60:02d}")
    return out


def make_day(path_pct, start="09:00", open0=100.0, wick=0.0):
    """path_pct[i] = i 번째 봉 종가의 시가 대비 %. open=이전 종가(첫 봉은 open0), high/low = max/min(open, close) ± wick%."""
    times = _times(start, len(path_pct))
    rows = []
    prev = open0
    for t, p in zip(times, path_pct):
        c = open0 * (1 + p / 100)
        o = prev
        hi = max(o, c) * (1 + wick / 100)
        lo = min(o, c) * (1 - wick / 100)
        rows.append({"time": t, "open": o, "high": hi, "low": lo, "close": c, "volume": 1.0})
        prev = c
    return pd.DataFrame(rows)


def _bars_frame(code: str, d: date, day: pd.DataFrame) -> pd.DataFrame:
    f = day.copy()
    f["date"] = d
    f["code"] = code
    f["price_adjusted"] = False
    f["market_div"] = "J"
    f["source"] = "syn"
    f["fetch_ts"] = pd.Timestamp("2026-01-01", tz="UTC")
    return f


def test_constants_match_config():
    c = CFG["intraday"]["absorption"]["constants"]
    for f in ("t1", "t3", "t4", "z_window_days", "z_min_samples", "z_clip_abs", "min_bars", "max_price_gap_minutes"):
        assert getattr(P, f) == c[f], f
    assert list(CFG["intraday"]["absorption"]["scopes"]) == list(A.SCOPES)
    assert A.load_params() == P
    assert A.TIME_AXIS == "A-1" and A.T0_MODE == "A1_open"


def test_six_points_and_price_at_rule():
    # 09:00 봉 종가 −0.5%, 09:04 봉 −1.0%(→ t1=09:05 값), 09:29 −0.2%(→ t3), 14:29 +0.4%(→ t4), 마지막 +0.3%(t5). 최저 low = 09:04 봉.
    n = 391
    path = np.zeros(n)
    path[0] = -0.5
    path[1:5] = -1.0
    path[5:30] = -0.2
    path[30:300] = 0.1
    path[300:390] = 0.4        # 14:00~15:29 봉 +0.4 → t4(14:30 시점 = 14:29 봉) = 0.4, 최고 high 첫 봉 = 14:00
    path[390] = 0.3
    day = make_day(path)
    assert len(day) == 391 and day["time"].iloc[-1] == "15:30"
    sp = A.six_points(day, A.DIRECTION_BAD, P)
    assert sp["session_state"] == "ok" and sp["n_bars"] == 391 and sp["open0"] == 100.0
    assert sp["t1"] == pytest.approx(-1.0)
    assert sp["t3"] == pytest.approx(-0.2)
    assert sp["t4"] == pytest.approx(0.4)
    assert sp["t5"] == pytest.approx(0.3)
    assert sp["t2"] == pytest.approx(-1.0) and sp["t2_time"] == "09:01"        # 첫 극값 봉 (09:01 봉 low = 종가 −1.0)
    # 호재 방향: 극값 = max high
    sp_g = A.six_points(day, A.DIRECTION_GOOD, P)
    assert sp_g["t2"] == pytest.approx(0.4) and sp_g["t2_time"] == "14:00"
    # 방향 None: t2 None, 나머지 그대로
    sp_n = A.six_points(day, None, P)
    assert sp_n["t2"] is None and sp_n["t2_time"] is None and sp_n["t5"] == pytest.approx(0.3)


def test_price_at_gap_rule():
    day = make_day(np.zeros(391))
    day2 = day[~day["time"].between("08:59", "09:04")].reset_index(drop=True)          # 09:00~09:04 봉 결측
    assert A.price_at(day2, "09:05", 5) is None                                          # 앞 봉이 없음
    day3 = day[~day["time"].between("09:26", "09:29")].reset_index(drop=True)          # 09:26~09:29 결측 → 09:25 봉이 09:30 에서 5분 → 허용
    assert A.price_at(day3, "09:30", 5) == pytest.approx(100.0)
    day4 = day[~day["time"].between("09:24", "09:29")].reset_index(drop=True)          # 6분 → None
    assert A.price_at(day4, "09:30", 5) is None


def test_absorption_ratio_formulas():
    assert A.absorption_ratio(-2.0, -0.5, A.DIRECTION_BAD) == pytest.approx(0.75)      # 악재: 낙폭 2% 중 1.5% 회복
    assert A.absorption_ratio(-2.0, -2.0, A.DIRECTION_BAD) == pytest.approx(0.0)
    assert A.absorption_ratio(-2.0, 0.0, A.DIRECTION_BAD) == pytest.approx(1.0)
    assert A.absorption_ratio(-2.0, 1.0, A.DIRECTION_BAD) == pytest.approx(0.5)        # 스펙 문구 |t5| — 악재인데 상승 마감이면 1 미만 (해석 기록)
    assert A.absorption_ratio(2.0, 1.0, A.DIRECTION_GOOD) == pytest.approx(0.5)        # 호재: 최대 상승분의 절반 유지
    assert A.absorption_ratio(2.0, -1.0, A.DIRECTION_GOOD) == pytest.approx(-0.5)
    assert A.absorption_ratio(0.0, 1.0, A.DIRECTION_GOOD) is None
    assert A.absorption_ratio(None, 1.0, A.DIRECTION_GOOD) is None
    assert A.absorption_ratio(2.0, 1.0, None) is None


def test_half_life_minutes():
    n = 391
    path = np.zeros(n)
    path[0:10] = -1.0          # 09:00~09:09 저점
    path[10:40] = -0.8         # 아직 절반(−0.5) 위로 못 옴
    path[40:] = -0.4           # 09:40 봉부터 −0.4 ≥ −0.5 → 절반 회복
    day = make_day(path)
    sp = A.six_points(day, A.DIRECTION_BAD, P)
    assert sp["t2"] == pytest.approx(-1.0) and sp["t2_time"] == "09:00"
    assert A.half_life_minutes(day, 100.0, sp["t2"], sp["t2_time"], A.DIRECTION_BAD) == 40
    # 호재: 절반 되돌림 없음 → None
    path_g = np.full(n, 1.0)
    day_g = make_day(path_g)
    sp_g = A.six_points(day_g, A.DIRECTION_GOOD, P)
    assert A.half_life_minutes(day_g, 100.0, sp_g["t2"], sp_g["t2_time"], A.DIRECTION_GOOD) is None


def test_partial_and_late_open():
    day = make_day(np.zeros(200))
    sp = A.six_points(day, A.DIRECTION_BAD, P)
    assert sp["session_state"] == "partial" and sp["t5"] is None and sp["t2"] is None and sp["n_bars"] == 200
    late = make_day(np.full(331, 0.2), start="10:00")
    sp2 = A.six_points(late, A.DIRECTION_GOOD, P)
    assert sp2["session_state"] == "late_open" and sp2["t1"] is None and sp2["t3"] is None
    assert sp2["t4"] == pytest.approx(0.2) and sp2["t5"] == pytest.approx(0.2) and sp2["open0"] == 100.0
    empty = A.six_points(pd.DataFrame(columns=["time", "open", "high", "low", "close"]), A.DIRECTION_BAD, P)
    assert empty["session_state"] == "missing"


def test_material_table_priority_and_conflict():
    d1, d2, d3, d4 = date(2026, 9, 14), date(2026, 9, 17), date(2026, 10, 1), date(2026, 10, 6)
    gap3g = pd.DataFrame([
        {"date": d1, "scope": "005930", "sox_ret_prev": -1.2, "no_material_flag": False},
        {"date": d2, "scope": "005930", "sox_ret_prev": 0.8, "no_material_flag": True},
        {"date": d3, "scope": "005930", "sox_ret_prev": None, "no_material_flag": None},
        {"date": d4, "scope": "005930", "sox_ret_prev": 0.5, "no_material_flag": False},
        {"date": d1, "scope": "KOSPI200", "sox_ret_prev": -1.2, "no_material_flag": False},
    ])
    er = pd.DataFrame([
        {"event_id": "US_CPI_20260911", "scope": "005930", "t0_kr": d1, "surprise_z": 1.5, "surprise": 0.1},          # 등급A 호재 → C(−) 덮음
        {"event_id": "FOMC_20260916", "scope": "005930", "t0_kr": d2, "surprise_z": None, "surprise": None},          # 부호 없음 → 등급C 유지
        {"event_id": "US_PCE_20260930", "scope": "005930", "t0_kr": d4, "surprise_z": -0.2, "surprise": -0.01},
        {"event_id": "US_NFP_20261002", "scope": "005930", "t0_kr": d4, "surprise_z": 0.9, "surprise": 30.0},          # 같은 날 부호 충돌
    ])
    m = A.material_table(gap3g, er, ("005930",))
    m = m.set_index("date")
    assert m.loc[d1, "grade"] == "A" and m.loc[d1, "direction"] == 1 and m.loc[d1, "material_source"] == "gradeA_surprise_sign"
    assert m.loc[d1, "event_id"] == "US_CPI_20260911" and m.loc[d1, "sox_ret_prev"] == -1.2
    assert m.loc[d2, "grade"] == "C" and m.loc[d2, "direction"] == 1 and m.loc[d2, "no_material_flag"] == True  # noqa: E712
    assert m.loc[d3, "grade"] is None and pd.isna(m.loc[d3, "direction"])
    assert m.loc[d4, "grade"] == "A" and pd.isna(m.loc[d4, "direction"]) and m.loc[d4, "material_source"] == "gradeA_conflict"
    assert "KOSPI200" not in set(m["scope"])
    # 등급A 없음 → 전부 등급C
    m2 = A.material_table(gap3g, None, ("005930",))
    assert set(m2["grade"].dropna()) == {"C"}
    assert len(A.material_table(None, None)) == 0


def make_world(n_days=200, seed=3, code="005930"):
    rng = np.random.default_rng(seed)
    days = [d.date() for d in pd.bdate_range(date(2025, 9, 1), periods=n_days)]
    frames, mat = [], []
    for i, d in enumerate(days):
        direction = 1 if rng.random() < 0.5 else -1
        drift = rng.normal(0, 0.8) * direction
        path = np.cumsum(rng.normal(0, 0.05, 391)) + np.linspace(0, drift, 391)
        frames.append(_bars_frame(code, d, make_day(path, wick=0.02)))
        mat.append({"date": d, "scope": code, "grade": "C", "direction": direction, "material_source": "gradeC_sox_sign", "event_id": None,
                    "sox_ret_prev": float(direction), "no_material_flag": False})
    return pd.concat(frames, ignore_index=True), pd.DataFrame(mat), days


def test_panel_z_past_only_and_min_samples():
    minute, mat, days = make_world()
    panel = A.build_scope_panel("005930", minute, mat, days, P)
    assert len(panel) == len(days)
    assert panel["absorption_ratio"].notna().sum() >= 190
    ratios = panel["absorption_ratio"].tolist()
    # 표본 < 60 → None ; 60번째 유효 표본 이후 정의
    first_z = panel["shock_absorption_z"].first_valid_index()
    assert first_z is not None and first_z >= 60
    for i in range(len(panel)):
        z = panel["shock_absorption_z"].iat[i]
        past = [r for r in ratios[max(0, i - 120):i] if r is not None and not pd.isna(r)]
        if len(past) < 60 or pd.isna(ratios[i]):
            assert pd.isna(z)
        else:
            exp = (ratios[i] - np.mean(past)) / np.std(past, ddof=1)
            assert z == pytest.approx(max(-3.0, min(3.0, exp)))
    # 미래 변조 → 과거 불변
    cut = days[150]
    m2 = minute.copy()
    sel = pd.to_datetime(m2["date"]).dt.date >= cut
    m2.loc[sel, "close"] = m2.loc[sel, "close"] * 1.03
    m2.loc[sel, "high"] = np.maximum(m2.loc[sel, "high"], m2.loc[sel, "close"])
    panel2 = A.build_scope_panel("005930", m2, mat, days, P)
    pd.testing.assert_frame_equal(panel[panel["date"] < cut].reset_index(drop=True), panel2[panel2["date"] < cut].reset_index(drop=True))
    assert not np.allclose(panel[panel["date"] >= cut]["t5"].to_numpy(dtype=float), panel2[panel2["date"] >= cut]["t5"].to_numpy(dtype=float))


def test_panel_missing_session_row_and_direction_none():
    minute, mat, days = make_world(n_days=80)
    # 세션 하나 분봉 제거 → 행은 남고 값 None(session_state missing) ; 다른 세션 방향 None → ratio None 이지만 t5 는 있음
    gone = days[10]
    m2 = minute[pd.to_datetime(minute["date"]).dt.date != gone]
    mat2 = mat.copy()
    mat2.loc[mat2["date"] == days[20], ["direction", "grade", "material_source"]] = [None, None, None]
    panel = A.build_scope_panel("005930", m2, mat2, days, P)
    r = panel[panel["date"] == gone].iloc[0]
    assert r["session_state"] == "missing" and pd.isna(r["t5"]) and pd.isna(r["absorption_ratio"]) and r["n_bars"] == 0
    r2 = panel[panel["date"] == days[20]].iloc[0]
    assert pd.isna(r2["direction"]) and pd.isna(r2["t2"]) and pd.isna(r2["absorption_ratio"]) and not pd.isna(r2["t5"])
    # 방향과 무관한 t1/t3/t4/t5 는 방향을 바꿔도 동일
    mat3 = mat.copy()
    mat3["direction"] = -mat3["direction"]
    panel3 = A.build_scope_panel("005930", minute, mat3, days, P)
    panel0 = A.build_scope_panel("005930", minute, mat, days, P)
    for c in ("t1", "t3", "t4", "t5", "open0", "n_bars"):
        pd.testing.assert_series_equal(panel0[c], panel3[c])
    assert not panel0["t2"].equals(panel3["t2"])


def test_scope_independence_and_schema_roundtrip(tmp_path):
    m1, mat1, days = make_world(n_days=100, seed=1, code="005930")
    m2, mat2, _ = make_world(n_days=100, seed=2, code="000660")
    minute = pd.concat([m1, m2], ignore_index=True)
    mat = pd.concat([mat1, mat2], ignore_index=True)
    panel = A.build_panel(minute, mat, days, P, ("005930", "000660"))
    a1 = panel[panel["scope"] == "005930"].reset_index(drop=True)
    m2b = m2.copy()
    m2b["close"] *= 1.05
    panel_b = A.build_panel(pd.concat([m1, m2b], ignore_index=True), mat, days, P, ("005930", "000660"))
    pd.testing.assert_frame_equal(a1, panel_b[panel_b["scope"] == "005930"].reset_index(drop=True))
    p = A.write_gold(panel, tmp_path / "abs.parquet")
    back = A.read_gold(p)
    assert list(back.columns) == [f.name for f in A.GOLD_ABSORPTION_PANEL] and len(back) == len(panel)
    s = A.summarize(back)
    assert set(s) == {"005930", "000660"} and s["005930"]["rows"] == 100
    with pytest.raises(AssertionError):
        A.build_scope_panel("SOXX", minute, mat, days, P)      # C-3: 국내 스코프만 A1_open


def test_price_at_within_intraday_gap_uses_last_before():
    # 실측 관측: KIS 분봉에 하루 중 ~30분 블록 결측이 있을 수 있다(예: 11:20~11:48). 시점 앵커(09:05·09:30·14:30)가 결측 블록 밖이면 영향 없음.
    day = make_day(np.zeros(391))
    gap = day[~day["time"].between("11:20", "11:48")].reset_index(drop=True)
    assert A.price_at(gap, "14:30", 5) is not None            # 앵커는 결측 블록 밖 → 정상
    assert A.price_at(gap, "09:30", 5) is not None
    sp = A.six_points(gap, A.DIRECTION_BAD, P)
    assert sp["session_state"] == "ok" and sp["t4"] is not None and sp["t5"] is not None
