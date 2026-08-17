"""T5-6 등급A Expected Reaction (events/expected_reaction.py) — 합성 데이터 테스트.

- 종목 독립: 한 스코프의 반응 변조가 다른 스코프 결과에 영향 없음 (pooling 금지)
- 룩어헤드: t0 이후 반응·피처 변조 → 그 이전 이벤트 행 불변, 당사자 이벤트의 expected 불변
- Implicit(동일 유형·|Δsz|<0.8·최근 5·EWMA 달력일 hl 30·<3 None) / Explicit(최근 120 OLS + 전 이력 shrinkage α, <20 None) / q 결합 / expected_std / None 규칙
- surprise_z 유형별 과거 std(A-1), 상수-config 일치, 스키마 왕복, SHRINK-H 등록, gap3g overlay 인터페이스, 0 이벤트
"""
from __future__ import annotations

import pathlib
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest
import yaml

from mtpro.core.errata import expected_std_rolling
from mtpro.events import expected_reaction as ER
from mtpro.events import kr_calendar as KC

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
P = ER.ExpectedReactionParams()
UTC = timezone.utc


def _bdays(start: date, n: int) -> list[date]:
    return [d.date() for d in pd.bdate_range(start, periods=n)]


def make_world(n_events=90, seed=7, scopes=("005930", "000660"), types=("US_CPI", "FOMC", "US_NFP"), same_day_pairs=0):
    """평일 달력(미국 세션 = 국내 세션 같은 날짜열). 이벤트는 8 영업일 간격, 유형 순환. 반응 gap = a·surprise_z + b·sox_shift_z + 잡음 (스코프별 계수)."""
    rng = np.random.default_rng(seed)
    days = _bdays(date(2022, 1, 3), 300 + n_events * 8 + 20)
    # 미국 일봉 재료
    sox_ret = rng.normal(0, 1.5, len(days))
    vix = 15 + np.cumsum(rng.normal(0, 0.5, len(days)))
    tnx = 3.5 + np.cumsum(rng.normal(0, 0.03, len(days)))
    sox_df = pd.DataFrame({"date": days, "ret_pct": sox_ret})
    vix_df = pd.DataFrame({"date": days, "close": vix})
    tnx_df = pd.DataFrame({"date": days, "close": tnx})
    # 이벤트
    type_std = {"US_CPI": 0.1, "FOMC": 0.25, "US_NFP": 50.0}
    rows = []
    k = 0
    idx = 300
    while k < n_events:
        et = types[k % len(types)]
        t0 = days[idx]
        cons = {"US_CPI": 0.3, "FOMC": 5.25, "US_NFP": 180.0}[et]
        actual = cons + rng.normal(0, type_std[et])
        sched = datetime.combine(t0 - timedelta(days=1), datetime.min.time(), tzinfo=UTC) + timedelta(hours=13, minutes=30)
        rows.append({"event_id": f"{et}_{t0:%Y%m%d}", "event_type": et, "asset_scope": list(scopes), "scheduled_ts_utc": sched, "t0_mode": "A1_open",
                     "consensus_value": cons, "actual_value": actual, "actual_ts": sched, "available_at": sched + timedelta(minutes=5),
                     "frozen": True, "grade": "A", "t0_kr": t0, "schedule_status": "confirmed"})
        k += 1
        if same_day_pairs and k < n_events and (k % 10 == 0) and same_day_pairs > 0:
            et2 = types[(k + 1) % len(types)]
            cons2 = {"US_CPI": 0.3, "FOMC": 5.25, "US_NFP": 180.0}[et2]
            rows.append({**rows[-1], "event_id": f"{et2}_{t0:%Y%m%d}", "event_type": et2, "consensus_value": cons2,
                         "actual_value": cons2 + rng.normal(0, type_std[et2])})
            k += 1
            same_day_pairs -= 1
        idx += 8
    events = ER.event_table(rows)
    events = ER.add_surprise(events, P)
    events = ER.build_features(events, vix_df, sox_df, tnx_df, P, sessions=days)
    # 반응 (스코프별 다른 계수) — 모든 세션에 gap 을 둔다
    coef = {sc: (0.6 + 0.4 * i, 0.3 - 0.2 * i) for i, sc in enumerate(scopes)}
    ev_by_date = {r["t0_kr"]: r for r in events.to_dict("records")}
    rec = []
    for sc in scopes:
        a, b = coef[sc]
        for d in days:
            e = ev_by_date.get(d)
            sz = e["surprise_z"] if e is not None and pd.notna(e["surprise_z"]) else 0.0
            sx = e["sox_shift_z"] if e is not None and pd.notna(e["sox_shift_z"]) else 0.0
            rec.append({"date": d, "scope": sc, "gap_pct": a * sz + b * sx + rng.normal(0, 0.5)})
    reactions = pd.DataFrame(rec)
    return events, reactions, {"days": days, "sox": sox_df, "vix": vix_df, "tnx": tnx_df, "rows": rows}


@pytest.fixture(scope="module")
def world():
    return make_world()


# ---------------------------------------------------------------------------
def test_constants_match_config():
    c = CFG["expected_reaction"]["constants"]
    for f in ("surprise_std_window", "surprise_std_min_samples", "implicit_max_delta_surprise_z", "implicit_recent_n", "implicit_halflife_days",
              "implicit_min_samples", "explicit_recent_n", "explicit_min_samples", "explicit_r2_recent_n", "explicit_r2_threshold",
              "alpha_informative", "alpha_default", "q_high", "q_mid", "expected_std_window", "expected_std_floor", "expected_std_min_samples",
              "feature_z_window_days", "feature_z_min_samples", "feature_z_clip_abs", "rate_change_sessions", "max_stale_calendar_days"):
        assert getattr(P, f) == c[f], f
    for f in ("weights_high", "weights_mid", "weights_low"):
        assert tuple(getattr(P, f)) == tuple(c[f]), f
    assert list(CFG["expected_reaction"]["challengers"]) == list(ER.CHALLENGERS) == ["SHRINK-H"]
    assert CFG["expected_reaction"]["independence"] == "per_scope"
    assert CFG["expected_reaction"]["reaction"] == ER.REACTION_BASIS
    assert list(CFG["expected_reaction"]["features"]) == list(ER.FEATURES)
    assert ER.load_params() == P


def test_event_table_filters_and_reasons():
    base = {"event_type": "US_CPI", "asset_scope": ["005930"], "scheduled_ts_utc": datetime(2026, 9, 11, 12, 30, tzinfo=UTC), "t0_mode": "A1_open",
            "consensus_value": 0.3, "actual_value": 0.4, "frozen": True, "grade": "A", "t0_kr": date(2026, 9, 14)}
    rows = [
        {**base, "event_id": "ok"},
        {**base, "event_id": "c", "grade": "C", "consensus_value": None},
        {**base, "event_id": "nf", "frozen": False},
        {**base, "event_id": "na", "actual_value": None},
    ]
    ev = ER.event_table(rows)
    assert list(ev["event_id"]) == ["ok"]
    assert {d["event_id"]: d["reason"] for d in ev.attrs["dropped"]} == {"c": "grade=C", "nf": "not_frozen", "na": "actual_missing"}


def test_surprise_z_uses_only_past_same_type(world):
    ev, _, _ = world
    for et, g in ev.groupby("event_type"):
        g = g.sort_values("t0_kr")
        sur = g["surprise"].tolist()
        # 첫 3건은 과거 표본 < 3 → None
        assert g["surprise_z"].iloc[:3].isna().all()
        for i in range(3, len(g)):
            s = expected_std_rolling({et: sur[:i]}, et, window=P.surprise_std_window, floor=0.0, min_samples=P.surprise_std_min_samples)
            assert g["surprise_std"].iloc[i] == pytest.approx(s)
            assert g["surprise_z"].iloc[i] == pytest.approx(sur[i] / s)


def test_features_use_sessions_strictly_before_t0(world):
    ev, _, w = world
    days = w["days"]
    ev2 = ev.copy()
    t_cut = ev2["t0_kr"].iloc[40]
    # t_cut 이후(포함) 세션의 VIX·TNX·SOX 를 뒤흔든다 → t0 ≤ t_cut 이벤트의 피처 불변
    vix = w["vix"].copy(); vix.loc[pd.to_datetime(vix["date"]).dt.date >= t_cut, "close"] += 50
    tnx = w["tnx"].copy(); tnx.loc[pd.to_datetime(tnx["date"]).dt.date >= t_cut, "close"] += 5
    sox = w["sox"].copy(); sox.loc[pd.to_datetime(sox["date"]).dt.date >= t_cut, "ret_pct"] += 30
    f2 = ER.build_features(ev2[["event_id", "event_type", "scopes", "scheduled_ts_utc", "t0_kr", "consensus_value", "actual_value",
                                "actual_ts", "available_at", "schedule_status", "surprise", "surprise_std", "surprise_z", "direction"]],
                           vix, sox, tnx, P, sessions=days)
    before = ev[ev["t0_kr"] <= t_cut]
    after = f2[f2["t0_kr"] <= t_cut]
    for c in ("vix_z", "sox_shift_z", "rate_change_bp", "feature_session_date"):
        pd.testing.assert_series_equal(before[c].reset_index(drop=True), after[c].reset_index(drop=True), check_names=False)
    # 그 이후 이벤트는 바뀐다 (변조가 실제로 먹혔는지)
    assert not f2[f2["t0_kr"] > t_cut]["vix_z"].equals(ev[ev["t0_kr"] > t_cut]["vix_z"])
    # feature_session_date 는 항상 t0_kr 미만
    fs = ev.dropna(subset=["feature_session_date"])
    assert (pd.to_datetime(fs["feature_session_date"]).dt.date < fs["t0_kr"]).all()


def test_scope_independence_no_pooling(world):
    ev, rx, _ = world
    out = ER.build_events(ev, rx, P, scopes=("005930", "000660"))
    a1 = out[out["scope"] == "005930"].reset_index(drop=True)
    # 000660 반응을 완전히 변조 (부호 반전 + 큰 잡음)
    rx2 = rx.copy()
    m = rx2["scope"] == "000660"
    rx2.loc[m, "gap_pct"] = -3.0 * rx2.loc[m, "gap_pct"] + 7.0
    out2 = ER.build_events(ev, rx2, P, scopes=("005930", "000660"))
    a2 = out2[out2["scope"] == "005930"].reset_index(drop=True)
    pd.testing.assert_frame_equal(a1, a2)
    b1 = out[out["scope"] == "000660"]["expected_gap"].dropna()
    b2 = out2[out2["scope"] == "000660"]["expected_gap"].dropna()
    assert len(b1) > 20 and not np.allclose(b1.to_numpy(), b2.to_numpy())
    # 스코프별 독립 호출과 전체 호출이 같다
    solo = ER.build_scope_events("005930", ev, rx, P)
    pd.testing.assert_frame_equal(solo.reset_index(drop=True), a1)


def test_lookahead_reactions(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    k = 60
    t_k = out["t0_kr"].iloc[k]
    rx2 = rx.copy()
    m = (rx2["scope"] == "005930") & (pd.to_datetime(rx2["date"]).dt.date >= t_k)
    rx2.loc[m, "gap_pct"] += 9.0
    out2 = ER.build_scope_events("005930", ev, rx2, P)
    pd.testing.assert_frame_equal(out.iloc[:k].reset_index(drop=True), out2.iloc[:k].reset_index(drop=True))
    # k 번째 이벤트: expected 는 그대로(과거만 사용), gap·err 만 바뀐다
    for c in ("expected_implicit", "expected_explicit", "expected_gap", "expected_std", "method", "alpha", "n_explicit"):
        assert (out.iloc[k][c] == out2.iloc[k][c]) or (pd.isna(out.iloc[k][c]) and pd.isna(out2.iloc[k][c])), c
    assert out2.iloc[k]["gap_pct"] == pytest.approx(out.iloc[k]["gap_pct"] + 9.0)


def test_implicit_rule_and_none(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    hist = out.to_dict("records")
    for i, r in enumerate(hist):
        past = [h for h in hist[:i] if h["t0_kr"] < r["t0_kr"]]
        exp, n = ER.implicit_expected(r["t0_kr"], r["event_type"], r["surprise_z"], past, P)
        if r["surprise_z"] is None or pd.isna(r["surprise_z"]):
            assert exp is None and n == 0
            continue
        cands = [h for h in past if h["event_type"] == r["event_type"] and h["surprise_z"] is not None and not pd.isna(h["surprise_z"])
                 and h["gap_pct"] is not None and abs(h["surprise_z"] - r["surprise_z"]) < 0.8]
        cands = sorted(cands, key=lambda h: h["t0_kr"])[-5:]
        assert n == len(cands)
        if len(cands) < 3:
            assert exp is None and pd.isna(r["expected_implicit"])
        else:
            w = np.array([0.5 ** ((r["t0_kr"] - h["t0_kr"]).days / 30.0) for h in cands])
            y = np.array([h["gap_pct"] for h in cands])
            assert exp == pytest.approx(float((w * y).sum() / w.sum()))
            assert r["expected_implicit"] == pytest.approx(exp)
            assert r["n_implicit"] == n


def _ols_pred(rows, x):
    X = np.array([[1.0] + [h[f] for f in ER.FEATURES] for h in rows])
    y = np.array([h["gap_pct"] for h in rows])
    b = np.linalg.lstsq(X, y, rcond=None)[0]
    return float(np.r_[1.0, x] @ b), b, X, y


def test_explicit_shrinkage_and_alpha(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    hist = out.to_dict("records")
    n_defined = 0
    for i, r in enumerate(hist):
        past = [h for h in hist[:i] if h["t0_kr"] < r["t0_kr"] and h["gap_pct"] is not None
                and all(h[f] is not None and not pd.isna(h[f]) for f in ER.FEATURES)]
        cur_ok = all(r[f] is not None and not pd.isna(r[f]) for f in ER.FEATURES)
        recent = past[-120:]
        if len(recent) < 20 or not cur_ok:
            assert pd.isna(r["expected_explicit"]), (i, len(recent), cur_ok)
            assert r["n_explicit"] == len(recent)
            continue
        n_defined += 1
        x = [r[f] for f in ER.FEATURES]
        pr, br, Xr, yr = _ols_pred(recent, x)
        pf, bf, _, _ = _ols_pred(past, x)
        m = min(30, len(recent))
        yhat = Xr[-m:] @ br
        r2 = 1 - ((yr[-m:] - yhat) ** 2).sum() / ((yr[-m:] - yr[-m:].mean()) ** 2).sum()
        alpha = 0.5 if r2 > 0.3 else 0.8
        assert r["alpha"] == alpha and r["r2_recent"] == pytest.approx(r2)
        assert r["expected_explicit"] == pytest.approx((1 - alpha) * pr + alpha * pf, abs=1e-9)
        assert r["n_explicit"] == len(recent) and r["n_explicit_full"] == len(past)
    assert n_defined > 30


def test_explicit_full_vs_recent_differ_when_history_exceeds_120():
    ev, rx, _ = make_world(n_events=170, seed=11, scopes=("005930",), types=("US_CPI", "FOMC"))
    out = ER.build_scope_events("005930", ev, rx, P)
    tail = out.dropna(subset=["expected_explicit"])
    assert (tail["n_explicit_full"] > tail["n_explicit"]).any()
    assert set(tail["alpha"].unique()) <= {0.5, 0.8}


def test_combine_rules_and_q():
    assert ER.combine(1.0, 2.0, 0.9) == (pytest.approx(0.7 * 1 + 0.3 * 2), "combined", 0.7, 0.3)
    assert ER.combine(1.0, 2.0, 0.75) == (pytest.approx(1.5), "combined", 0.5, 0.5)
    assert ER.combine(1.0, 2.0, 0.5) == (pytest.approx(0.2 * 1 + 0.8 * 2), "combined", 0.2, 0.8)
    assert ER.combine(1.0, None, None) == (1.0, "explicit_only", 1.0, 0.0)
    assert ER.combine(None, 2.0, None) == (2.0, "implicit_only", 0.0, 1.0)
    assert ER.combine(None, None, None) == (None, None, None, None)
    with pytest.raises(ER.ExpectedReactionError):
        ER.combine(1.0, 2.0, None)


def test_same_day_events_get_q_half_and_low_weights():
    ev, rx, _ = make_world(n_events=90, seed=5, scopes=("005930",), same_day_pairs=3)
    out = ER.build_scope_events("005930", ev, rx, P)
    dup = out[out.duplicated("t0_kr", keep=False)]
    assert len(dup) >= 4
    assert (dup["q"] == 0.5).all()
    assert (out[~out["t0_kr"].isin(dup["t0_kr"])]["q"] == 1.0).all()
    both = dup.dropna(subset=["expected_implicit", "expected_explicit"])
    if len(both):
        assert (both["w_explicit"] == 0.2).all() and (both["w_implicit"] == 0.8).all()
    comb = out[out["method"] == "combined"]
    assert len(comb) > 0
    for r in comb.to_dict("records"):
        assert r["expected_gap"] == pytest.approx(r["w_explicit"] * r["expected_explicit"] + r["w_implicit"] * r["expected_implicit"])
    # 같은 t0 이벤트는 서로의 이력이 아니다: 둘의 n_explicit 동일
    for t0, g in dup.groupby("t0_kr"):
        assert g["n_explicit"].nunique() == 1


def test_expected_std_and_err_z(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    hist = out.to_dict("records")
    for i, r in enumerate(hist):
        past = [h for h in hist[:i] if h["t0_kr"] < r["t0_kr"] and h["event_type"] == r["event_type"] and h["err"] is not None and not pd.isna(h["err"])]
        s = expected_std_rolling({r["event_type"]: [h["err"] for h in past]}, r["event_type"], window=20, floor=0.1, min_samples=3)
        if s is None:
            assert pd.isna(r["expected_std"]) and pd.isna(r["err_z"])
        else:
            assert r["expected_std"] == pytest.approx(s) and s >= 0.1
            if not pd.isna(r["expected_gap"]) and not pd.isna(r["gap_pct"]):
                assert r["err"] == pytest.approx(r["gap_pct"] - r["expected_gap"])
                assert r["err_z"] == pytest.approx(r["err"] / s)
    # err_z 가 정의된 이벤트에서 표준편차가 터무니없지 않다 (캘리브레이션 원값)
    ez = out["err_z"].dropna()
    assert len(ez) > 20 and 0.3 < ez.std() < 3.0
    # available_at = t0_kr 15:30 KST
    r0 = out.iloc[0]
    assert r0["available_at"] == KC.kst(r0["t0_kr"], ER.SESSION_CLOSE_KST).astimezone(UTC)
    assert set(out["direction"].dropna().unique()) <= {"good", "bad", "neutral"}


def test_reaction_missing_gives_none_gap_but_keeps_expected(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    t_missing = out["t0_kr"].iloc[70]
    rx2 = rx[~((rx["scope"] == "005930") & (pd.to_datetime(rx["date"]).dt.date == t_missing))]
    out2 = ER.build_scope_events("005930", ev, rx2, P)
    r = out2[out2["t0_kr"] == t_missing].iloc[0]
    assert pd.isna(r["gap_pct"]) and pd.isna(r["err"]) and pd.isna(r["err_z"])
    assert not pd.isna(r["expected_gap"])
    # 그 이벤트는 이후 이력(반응 없음)에서 빠진다 → 이후 이벤트의 n_explicit 이 하나 줄거나 같다
    after = out[out["t0_kr"] > t_missing]["n_explicit"].to_numpy()
    after2 = out2[out2["t0_kr"] > t_missing]["n_explicit"].to_numpy()
    assert (after2 <= after).all() and (after2 < after).any()


def test_write_read_roundtrip_and_zero_events(tmp_path, world):
    ev, rx, _ = world
    out = ER.build_events(ev, rx, P, scopes=("005930", "000660"))
    p = ER.write_gold(out, tmp_path / "er.parquet")
    back = ER.read_gold(p)
    assert len(back) == len(out) and list(back.columns) == [f.name for f in ER.GOLD_EXPECTED_REACTION_EVENTS]
    s = ER.summarize(back)
    assert s["n_events"] == out["event_id"].nunique() and set(s["scopes"]) == {"005930", "000660"}
    # 0 이벤트: 빈 표 기록·읽기·요약
    empty = ER.event_table([])
    assert len(empty) == 0
    e_out = ER.build_events(ER.add_surprise(empty, P) if len(empty) else empty, rx, P)
    assert len(e_out) == 0
    p2 = ER.write_gold(e_out, tmp_path / "empty.parquet")
    assert len(ER.read_gold(p2)) == 0
    assert ER.summarize(ER.read_gold(p2))["rows"] == 0


def test_overlay_gap3g_interface(world):
    ev, rx, _ = world
    out = ER.build_scope_events("005930", ev, rx, P)
    panel = rx[rx["scope"] == "005930"].copy()
    for c, v in (("expected_gap", 0.1), ("expected_gap_source", "gradeC"), ("grade", "C"), ("no_material_flag", False), ("sigma_gap", 0.5),
                 ("gap_reaction_err", 0.0), ("gap_reaction_err_z", 0.0)):
        panel[c] = v
    ov = ER.overlay_gap3g(panel, out)
    assert len(ov) == len(panel)
    dates = pd.to_datetime(ov["date"]).dt.date
    got = ov[ov["expected_gap_source"] == "gradeA"]
    exp_ids = set(out.dropna(subset=["expected_gap"])["t0_kr"])
    assert set(dates[ov["expected_gap_source"] == "gradeA"]) == exp_ids
    assert (got["grade"] == "A").all() and got["gradeA_event_id"].notna().all()
    # 원본 불변, 등급C 행 그대로
    assert (panel["expected_gap_source"] == "gradeC").all()
    assert (ov.loc[~dates.isin(exp_ids), "expected_gap_source"] == "gradeC").all()


def test_shrink_h_registered_not_implemented():
    assert "SHRINK-H" in ER.CHALLENGERS
    assert not hasattr(ER, "shrink_h")
