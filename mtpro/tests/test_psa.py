"""T5-3 부품 9 PSA — 정의(계획서 §4·§12.4)·pending/final·available_at·룩어헤드·상수-config 일치 테스트."""
from __future__ import annotations

import pathlib
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest
import yaml

from mtpro.components import psa as P

CFG = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 합성 데이터
# ---------------------------------------------------------------------------

def _dates(n: int, start: date = date(2024, 1, 1)) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _noise(n: int, amp: float = 0.001) -> list[float]:
    """결정적 소진폭 잡음: std>0, max|x|/std ≈ 1.41 < 2.0 → 스스로 충격을 만들지 않는다."""
    return list(amp * np.sin(np.arange(n) * 1.7 + 0.3))


def _ohlcv(closes, scope="005930", opens=None, highs=None, lows=None, vols=None, dates=None, price_adjusted=True) -> pd.DataFrame:
    n = len(closes)
    closes = np.asarray(closes, dtype=float)
    if opens is None:                                   # 기본: 갭 0 (시가 = 전일 종가) → 갭 트리거 비활성
        opens = np.concatenate([[closes[0]], closes[:-1]])
    opens = np.asarray(opens, dtype=float)
    highs = np.maximum(closes, opens) * 1.001 if highs is None else np.asarray(highs, dtype=float)
    lows = np.minimum(closes, opens) * 0.999 if lows is None else np.asarray(lows, dtype=float)
    vols = np.full(n, 1000.0) if vols is None else np.asarray(vols, dtype=float)
    dates = _dates(n) if dates is None else dates
    return pd.DataFrame({"date": dates, "code": scope, "open": opens, "high": highs, "low": lows, "close": closes,
                         "volume": vols, "price_adjusted": price_adjusted})


def _series_from_returns(rets):
    closes = [100.0]
    for r in rets:
        closes.append(closes[-1] * (1 + r))
    return np.array(closes)


# ---------------------------------------------------------------------------
# 상수 — config 일치
# ---------------------------------------------------------------------------

def test_constants_match_config():
    c = CFG["psa"]["constants"]
    assert (c["k_sigma"], c["k_gap"]) == (P.K_SIGMA, P.K_GAP)
    assert (c["sigma_window_days"], c["sigma_min_samples"]) == (P.SIGMA_WINDOW_DAYS, P.SIGMA_MIN_SAMPLES)
    assert (c["window_sessions"], c["settle_sessions"]) == (P.WINDOW_SESSIONS, P.SETTLE_SESSIONS)
    assert tuple(c["level_hold_clip"]) == P.LEVEL_HOLD_CLIP
    assert (c["z_ref_window_days"], c["z_ref_min_samples"], c["z_clip"]) == (P.Z_REF_WINDOW_DAYS, P.Z_REF_MIN_SAMPLES, P.Z_CLIP)
    assert c["ewma_halflife_days"] == P.EWMA_HALFLIFE_DAYS
    assert tuple(CFG["psa"]["scopes"]) == P.DEFAULT_SCOPES
    # champion 파라미터 = 모듈 상수
    p = P.PSA_CHAMPION
    assert (p.k_sigma, p.k_gap, p.sigma_window, p.window, p.settle, p.z_ref_window, p.z_ref_min_samples, p.z_clip) == (
        P.K_SIGMA, P.K_GAP, P.SIGMA_WINDOW_DAYS, P.WINDOW_SESSIONS, P.SETTLE_SESSIONS, P.Z_REF_WINDOW_DAYS,
        P.Z_REF_MIN_SAMPLES, P.Z_CLIP)
    # challenger 등록부 = config
    ch = CFG["psa"]["challengers"]
    assert set(ch) == set(P.CHALLENGER_NAMES) == set(P.CHALLENGERS)
    assert P.CHALLENGERS["PSA-EARLY"].window == ch["PSA-EARLY"]["window_sessions"] == 3
    assert P.CHALLENGERS["PSA-K2"].k_sigma == ch["PSA-K2"]["k_sigma"] == 2.0
    assert P.CHALLENGERS["PSA-W7"].window == ch["PSA-W7"]["window_sessions"] == 7
    # 계획서 §4 값 재확인
    assert P.K_SIGMA == 2.5 and P.K_GAP == 2.0 and P.WINDOW_SESSIONS == 5 and P.LEVEL_HOLD_CLIP == (-1.0, 1.5)


def test_schema_columns():
    assert P.EVENT_COLUMNS == ["shock_id", "scope", "shock_date", "direction", "k_sigma", "trigger", "status", "available_at",
                               "level_hold", "rebreak", "range_norm", "vol_norm", "psa_score", "psa_z", "overlap_shock",
                               "engine_ver"]
    assert P.GOLD_PSA_CHALLENGER.names[-1] == "challenger"


# ---------------------------------------------------------------------------
# 검출·σ20 (t 제외)
# ---------------------------------------------------------------------------

def test_sigma20_excludes_shock_day_and_k_sigma_is_measured():
    rets = _noise(30, 0.002) + [0.05] + _noise(8, 0.002)
    closes = _series_from_returns(rets)
    df = _ohlcv(closes)
    ev = P.compute_psa_events(df, scopes=["005930"])
    t = 31                                             # closes 인덱스 (rets 인덱스 30 + 1)
    assert list(ev["shock_date"]) == [df["date"].iloc[t]]
    r = closes[1:] / closes[:-1] - 1                   # r[i] = 수익률 of closes 인덱스 i+1
    r_t = r[t - 1]
    sigma_excl = np.std(r[t - 21:t - 1], ddof=1)       # r_{t−20..t−1}
    sigma_incl = np.std(r[t - 20:t], ddof=1)           # t 포함(잘못된 정의)
    k = float(ev["k_sigma"].iloc[0])
    assert k == pytest.approx(abs(r_t) / sigma_excl, rel=1e-9)
    assert k > 2.5 and abs(r_t) / sigma_incl < k       # t 포함이면 k 가 작아진다 — 제외 정의가 실제로 쓰였음
    assert ev["trigger"].iloc[0] == "ret" and int(ev["direction"].iloc[0]) == 1
    # 충격 다음날(t+1)의 σ20 은 충격을 포함하므로 같은 크기 이하의 잡음은 검출되지 않는다 (같은 데이터에서 충격 1건뿐)
    assert len(ev) == 1


def test_no_detection_when_sigma_sample_below_20():
    rets = _noise(15, 0.002) + [0.08] + [0.0] * 6
    ev = P.compute_psa_events(_ohlcv(_series_from_returns(rets)), scopes=["005930"])
    assert ev.empty


def test_gap_trigger_direction_and_k_sigma():
    """갭만 충족(시가 급등 후 종가 원위치): trigger=gap, direction=sign(gap), k_sigma=|r|/σ20 실측(작음)."""
    n = 40
    rets = _noise(n, 0.002)
    closes = _series_from_returns(rets)
    opens = closes.copy()
    opens[1:] = closes[:-1] * (1 + np.array(_noise(n, 0.0005)))     # 평소 갭 아주 작음
    t = 30
    opens[t] = closes[t - 1] * 1.03                                # 큰 갭업
    closes[t] = closes[t - 1] * 1.0001                             # 종가는 거의 원위치 → ret 미충족
    highs = np.maximum(closes, opens) * 1.001
    lows = np.minimum(closes, opens) * 0.999
    df = _ohlcv(closes, opens=opens, highs=highs, lows=lows)
    ev = P.compute_psa_events(df, scopes=["005930"])
    row = ev[ev["shock_date"] == df["date"].iloc[t]]
    assert len(row) == 1 and row["trigger"].iloc[0] == "gap" and int(row["direction"].iloc[0]) == 1
    assert float(row["k_sigma"].iloc[0]) < 2.5


# ---------------------------------------------------------------------------
# 최종 지표 정의
# ---------------------------------------------------------------------------

def _shock_frame(direction=1, post_rets=None, seed=0, n_pre=40):
    pre = _noise(n_pre)
    shock = 0.10 * direction
    post = list(post_rets if post_rets is not None else [0.0] * 5)
    closes = _series_from_returns(pre + [shock] + post)
    t = n_pre + 1
    return _ohlcv(closes), t, closes


def test_level_hold_positive_negative_and_clip():
    # 양 충격, 이후 종가가 (t−1 대비) 이동폭의 절반까지 되돌림 → level_hold = 0.5 (min close 기준)
    df, t, closes = _shock_frame(direction=1, post_rets=[0.0, -0.05 / 1.10 * 1.0, 0.0, 0.0, 0.0])
    ev = P.compute_psa_events(df, scopes=["005930"])
    row = ev.iloc[0]
    den = closes[t] - closes[t - 1]
    exp = (min(closes[t + 1:t + 6]) - closes[t - 1]) / den
    assert row["status"] == "final" and float(row["level_hold"]) == pytest.approx(exp, rel=1e-9)
    assert 0.4 < float(row["level_hold"]) < 0.6
    # 음 충격, 이후 보합 → max close = 충격일 종가 → 1.0 — 대칭(max close 사용)
    df2, t2, c2 = _shock_frame(direction=-1, post_rets=[0.0] * 5)
    ev2 = P.compute_psa_events(df2, scopes=["005930"])
    r2 = ev2[ev2["shock_date"] == df2["date"].iloc[t2]].iloc[0]
    assert int(r2["direction"]) == -1
    assert float(r2["level_hold"]) == pytest.approx((max(c2[t2 + 1:t2 + 6]) - c2[t2 - 1]) / (c2[t2] - c2[t2 - 1]), rel=1e-9)
    assert float(r2["level_hold"]) == pytest.approx(1.0, rel=1e-9)
    # 음 충격 후 계속 하락(−1%/일) → max close = t+1 종가 < 충격일 종가 → 1.09 (>1 = 확장), 반등(+3%) → 0.7 (<1 = 회복)
    df5, t5, c5 = _shock_frame(direction=-1, post_rets=[-0.01] * 5)
    r5 = P.compute_psa_events(df5, scopes=["005930"]).iloc[0]
    assert float(r5["level_hold"]) == pytest.approx((c5[t5 + 1] - c5[t5 - 1]) / (c5[t5] - c5[t5 - 1]), rel=1e-9) and float(r5["level_hold"]) > 1.0
    df6, t6, c6 = _shock_frame(direction=-1, post_rets=[0.03, 0.0, 0.0, 0.0, 0.0])
    r6 = P.compute_psa_events(df6, scopes=["005930"]).iloc[0]
    assert 0.6 < float(r6["level_hold"]) < 0.8
    # 클립: 양 충격 후 폭락 → −1 하한
    df3, t3, _ = _shock_frame(direction=1, post_rets=[-0.30, 0.0, 0.0, 0.0, 0.0])
    ev3 = P.compute_psa_events(df3, scopes=["005930"])
    r3 = ev3[ev3["shock_date"] == df3["date"].iloc[t3]].iloc[0]
    assert float(r3["level_hold"]) == -1.0
    # 상한 1.5: 양 충격 후 계속 상승
    df4, t4, _ = _shock_frame(direction=1, post_rets=[0.05] * 5)
    ev4 = P.compute_psa_events(df4, scopes=["005930"])
    r4 = ev4[ev4["shock_date"] == df4["date"].iloc[t4]].iloc[0]
    assert float(r4["level_hold"]) == 1.5


def test_rebreak_definition():
    df, t, closes = _shock_frame(direction=1, post_rets=[0.0] * 5)
    df.loc[t, "low"] = closes[t] * 0.995                      # 충격일 저가 = 종가 근처
    df.loc[t + 3, "low"] = closes[t] * 0.99                    # t+3 저가가 충격일 저가 아래 → 재붕괴
    ev = P.compute_psa_events(df, scopes=["005930"])
    assert bool(ev.iloc[0]["rebreak"]) is True
    df.loc[t, "low"] = closes[t] * 0.9                        # 충격일 저가를 아주 낮게 → 재붕괴 없음
    ev = P.compute_psa_events(df, scopes=["005930"])
    assert bool(ev.iloc[0]["rebreak"]) is False
    # 음 충격: high > high_t
    df2, t2, c2 = _shock_frame(direction=-1, post_rets=[0.0] * 5)
    df2.loc[t2, "high"] = c2[t2] * 1.005                       # 충격일 고가 = 종가 근처
    df2.loc[t2 + 5, "high"] = c2[t2] * 1.01                    # 창 마지막 날 고가가 충격일 고가 위 → 재돌파
    ev2 = P.compute_psa_events(df2, scopes=["005930"])
    r2 = ev2[ev2["shock_date"] == df2["date"].iloc[t2]].iloc[0]
    assert bool(r2["rebreak"]) is True
    df2.loc[t2, "high"] = c2[t2 - 1] * 1.05                    # 충격일 고가를 아주 높게 → 없음
    r2 = P.compute_psa_events(df2, scopes=["005930"]).iloc[0]
    assert bool(r2["rebreak"]) is False


def test_range_and_vol_norm_windows():
    """range_norm = mean(TR_{t+3..t+5}) / mean(TR_{t−20..t−1}); vol_norm 동일 (분모 t 제외)."""
    df, t, closes = _shock_frame(direction=1, post_rets=[0.0] * 5)
    vols = np.full(len(df), 100.0)
    vols[t] = 10_000.0                                       # 충격일 거래량 폭증 → 분모(t−20..t−1)에 안 들어가야 한다
    vols[t + 1:t + 3] = 5_000.0                              # t+1,t+2 는 분자(t+3..t+5)에 안 들어간다
    vols[t + 3:t + 6] = [200.0, 300.0, 400.0]
    df["volume"] = vols
    ev = P.compute_psa_events(df, scopes=["005930"])
    assert float(ev.iloc[0]["vol_norm"]) == pytest.approx(300.0 / 100.0, rel=1e-12)
    # TR 수동 계산
    h, l, c = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    prev = np.concatenate([[np.nan], c[:-1]])
    tr = np.max(np.vstack([h - l, np.abs(h - prev), np.abs(l - prev)]), axis=0)
    exp = np.mean(tr[t + 3:t + 6]) / np.mean(tr[t - 20:t])
    assert float(ev.iloc[0]["range_norm"]) == pytest.approx(exp, rel=1e-12)


def test_index_without_volume_gives_vol_norm_none():
    df, t, _ = _shock_frame(direction=1)
    df["code"] = "KOSPI200"
    df["volume"] = np.nan
    ev = P.compute_psa_events(df, scopes=["KOSPI200"])
    assert ev.iloc[0]["status"] == "final" and pd.isna(ev.iloc[0]["vol_norm"]) and pd.notna(ev.iloc[0]["range_norm"])


# ---------------------------------------------------------------------------
# pending / final / available_at / 룩어헤드
# ---------------------------------------------------------------------------

def test_pending_until_t_plus_5_and_available_at():
    df, t, _ = _shock_frame(direction=1, post_rets=[0.0] * 5)
    dates = list(df["date"])
    for k in range(0, 5):                                     # asof = t..t+4 → pending, 값 전부 None, available_at None
        ev = P.compute_psa_events(df, scopes=["005930"], asof=dates[t + k])
        assert len(ev) == 1 and ev.iloc[0]["status"] == "pending"
        assert pd.isna(ev.iloc[0]["available_at"])
        for col in P.FINAL_METRICS:
            assert pd.isna(ev.iloc[0][col]), col
    ev = P.compute_psa_events(df, scopes=["005930"], asof=dates[t + 5])
    assert ev.iloc[0]["status"] == "final" and ev.iloc[0]["available_at"] == dates[t + 5]
    assert pd.notna(ev.iloc[0]["level_hold"]) and pd.notna(ev.iloc[0]["rebreak"])
    # 표본 부족(과거 final 충격 < 10) → psa_z None 이더라도 status 는 final
    assert pd.isna(ev.iloc[0]["psa_z"])


def _big_random_frame(n=700, seed=7, scope="005930"):
    rng = np.random.default_rng(seed)
    # t 분포(꼬리 두꺼움)로 충격이 자연 발생
    rets = rng.standard_t(3, n) * 0.012
    closes = _series_from_returns(rets)
    opens = closes.copy()
    opens[1:] = closes[:-1] * (1 + rng.standard_t(3, n) * 0.004)
    highs = np.maximum(closes, opens) * (1 + np.abs(rng.normal(0, 0.004, n + 1)))
    lows = np.minimum(closes, opens) * (1 - np.abs(rng.normal(0, 0.004, n + 1)))
    vols = np.exp(rng.normal(np.log(1e6), 0.4, n + 1))
    return _ohlcv(closes, scope=scope, opens=opens, highs=highs, lows=lows, vols=vols)


def test_future_tampering_does_not_change_past_final_records():
    df = _big_random_frame()
    dates = list(df["date"])
    full = P.compute_psa_events(df, scopes=["005930"])
    assert (full["status"] == "final").sum() >= 20 and full["psa_z"].notna().sum() >= 5, "테스트 표본 부족"
    D = dates[500]
    tam = df.copy()
    m = tam["date"] > D
    tam.loc[m, ["open", "high", "low", "close"]] *= 1.37       # 미래 변조
    tam.loc[m, "volume"] *= 9.0
    tampered = P.compute_psa_events(tam, scopes=["005930"])
    key = ["shock_id"]
    a = full[full["available_at"].notna() & (full["available_at"] <= D)].set_index(key)
    b = tampered.set_index(key).reindex(a.index)
    pd.testing.assert_frame_equal(a, b, check_dtype=False)
    # asof 절단 재현: asof=D 로 계산한 표에서 available_at ≤ D 인 final 레코드는 전체 계산과 동일
    trunc = P.compute_psa_events(df, scopes=["005930"], asof=D)
    c = trunc[trunc["status"] == "final"].set_index(key)
    pd.testing.assert_frame_equal(a.sort_index(), c.sort_index(), check_dtype=False)
    # 절단 표에서 shock_date ≤ D 이지만 available_at > D 인 충격은 pending
    late = full[(full["shock_date"] <= D) & (full["available_at"] > D)]
    if len(late):
        st = trunc.set_index("shock_id").reindex(late["shock_id"])["status"]
        assert (st == "pending").all()


def test_psa_state_at_excludes_pending_even_with_values():
    ev = pd.DataFrame({
        "shock_id": ["s:1", "s:2", "s:3"], "scope": ["s"] * 3,
        "shock_date": [date(2024, 1, 2), date(2024, 1, 10), date(2024, 1, 20)],
        "direction": [1, -1, 1], "k_sigma": [3.0, 3.0, 3.0], "trigger": ["ret"] * 3,
        "status": ["final", "final", "pending"],
        "available_at": [date(2024, 1, 9), date(2024, 1, 17), None],
        "level_hold": [1.0, 0.5, 0.9], "rebreak": [False, True, False], "range_norm": [1.0, 1.2, 1.0],
        "vol_norm": [1.0, 1.1, 1.0], "psa_score": [1.0, -0.5, 2.0],
        "psa_z": [1.0, 0.5, 2.0],                              # pending 인데 값이 들어 있는 적대적 케이스
        "overlap_shock": [False, False, False], "engine_ver": ["psa-test"] * 3,
    })
    st = P.psa_state_at(ev, date(2024, 1, 31), "s")
    assert st["n_obs"] == 2 and st["psa_state"] is not None and abs(st["psa_state"] - 2.0) > 0.5
    # 정확한 EWMA (달력일 거리): d = 22, 14
    w = np.power(0.5, np.array([22, 14]) / 10.0)
    assert st["psa_state"] == pytest.approx(float((w * np.array([1.0, 0.5])).sum() / w.sum()))
    assert st["freshness"] == pytest.approx(0.5 ** (14 / 10.0)) and st["last_available_at"] == date(2024, 1, 17)
    # available_at 이후에만 포함
    st2 = P.psa_state_at(ev, date(2024, 1, 16), "s")
    assert st2["n_obs"] == 1 and st2["psa_state"] == pytest.approx(1.0)
    st3 = P.psa_state_at(ev, date(2024, 1, 8), "s")
    assert st3["n_obs"] == 0 and st3["psa_state"] is None and st3["freshness"] is None
    # 세션 거리
    sess = _dates(40, date(2024, 1, 1))
    st4 = P.psa_state_at(ev, date(2024, 1, 31), "s", sessions=sess)
    assert st4["distance_unit"] == "sessions" and st4["n_obs"] == 2
    d1 = sess.index(date(2024, 1, 31)) - sess.index(date(2024, 1, 9))
    d2 = sess.index(date(2024, 1, 31)) - sess.index(date(2024, 1, 17))
    w = np.power(0.5, np.array([d1, d2]) / 10.0)
    assert st4["psa_state"] == pytest.approx(float((w * np.array([1.0, 0.5])).sum() / w.sum()))
    # 다른 스코프 미포함
    assert P.psa_state_at(ev, date(2024, 1, 31), "other")["n_obs"] == 0


def test_psa_state_at_never_uses_pending_from_real_engine_output():
    df = _big_random_frame(seed=11)
    dates = list(df["date"])
    for k in (600, 640, 690, 699):
        D = dates[k]
        ev = P.compute_psa_events(df, scopes=["005930"], asof=D)
        st = P.psa_state_at(ev, D, "005930", sessions=dates)
        fin = ev[(ev["status"] == "final") & ev["psa_z"].notna()]
        assert st["n_obs"] == len(fin)
        assert (fin["available_at"] <= D).all()
        pend = ev[ev["status"] == "pending"]
        assert pend["psa_z"].isna().all() and pend["available_at"].isna().all()
        # 절단 시점 상태 = 전체 자료로 계산한 표를 같은 시점에 질의한 상태 (미래 자료가 상태에 새지 않음)
        full = P.compute_psa_events(df, scopes=["005930"])
        st_full = P.psa_state_at(full, D, "005930", sessions=dates)
        assert st_full["n_obs"] == st["n_obs"]
        if st["psa_state"] is not None:
            assert st_full["psa_state"] == pytest.approx(st["psa_state"])


def test_z_reference_is_past_final_only_and_min_samples():
    """psa_z 는 available_at ≤ t−1 인 과거 final 충격 ≥10 건이 있을 때만; 첫 충격들은 None."""
    df = _big_random_frame(seed=5)
    ev = P.compute_psa_events(df, scopes=["005930"]).sort_values("shock_date").reset_index(drop=True)
    fin = ev[ev["status"] == "final"]
    first_z = fin.index[fin["psa_z"].notna()]
    assert len(first_z) > 0
    i0 = first_z[0]
    assert i0 >= P.Z_REF_MIN_SAMPLES                       # 앞선 충격 10건 이상 없이는 z 없음
    # 처음 10건은 반드시 None
    assert fin.iloc[:P.Z_REF_MIN_SAMPLES]["psa_z"].isna().all()
    # psa_z = psa_score × direction
    z = fin[fin["psa_z"].notna()]
    assert np.allclose(z["psa_z"].astype(float), z["psa_score"].astype(float) * z["direction"].astype(float))
    assert (z["psa_score"].astype(float).abs() <= P.Z_CLIP).all()


def test_overlap_shock_flag():
    """창(t+1..t+5) 안의 새 충격 → 양쪽 overlap_shock=True, 각각 독립 레코드."""
    pre = _noise(40)
    rets = pre + [0.10, 0.0, 0.0, -0.20, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    df = _ohlcv(_series_from_returns(rets))
    ev = P.compute_psa_events(df, scopes=["005930"]).sort_values("shock_date")
    assert len(ev) == 2
    assert list(ev["direction"]) == [1, -1]
    assert ev["overlap_shock"].astype(bool).all()
    assert (ev["status"] == "final").all()
    # 서로 6세션 이상 떨어지면 overlap 아님
    rets2 = pre + [0.10, 0.0, 0.0, 0.0, 0.0, 0.0, -0.20, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    ev2 = P.compute_psa_events(_ohlcv(_series_from_returns(rets2)), scopes=["005930"])
    assert len(ev2) == 2 and not ev2["overlap_shock"].astype(bool).any()


def test_challengers_shadow_only_and_early_available_at():
    df = _big_random_frame(seed=13)
    dates = list(df["date"])
    ch = P.compute_challengers(df, scopes=["005930"])
    assert set(ch) == set(P.CHALLENGER_NAMES)
    champ = P.compute_psa_events(df, scopes=["005930"])
    early = ch["PSA-EARLY"]
    assert (early["challenger"] == "PSA-EARLY").all() and early["engine_ver"].str.endswith("PSA-EARLY").all()
    # 같은 충격 집합(검출 파라미터 동일), available_at 은 t+3
    assert set(early["shock_id"]) == set(champ["shock_id"])
    for _, r in early[early["status"] == "final"].head(5).iterrows():
        assert dates.index(r["available_at"]) - dates.index(r["shock_date"]) == 3
    for _, r in champ[champ["status"] == "final"].head(5).iterrows():
        assert dates.index(r["available_at"]) - dates.index(r["shock_date"]) == 5
    # K2 는 충격이 더 많고(임계 완화), W7 은 available_at = t+7
    assert len(ch["PSA-K2"]) >= len(champ)
    w7 = ch["PSA-W7"]
    for _, r in w7[w7["status"] == "final"].head(5).iterrows():
        assert dates.index(r["available_at"]) - dates.index(r["shock_date"]) == 7
    # arrow 변환
    P.challenger_to_arrow(early)
    P.events_to_arrow(champ)
    with pytest.raises(P.PsaInputError):
        P.compute_challengers(df, scopes=["005930"], names=["PSA-NOPE"])


def test_rejects_unadjusted_source():
    df, _, _ = _shock_frame()
    df["price_adjusted"] = False
    with pytest.raises(AssertionError):
        P.compute_psa_events(df, scopes=["005930"])


def test_multi_scope_independent():
    a = _big_random_frame(seed=21, scope="005930")
    b = _big_random_frame(seed=22, scope="000660")
    both = P.compute_psa_events(pd.concat([a, b], ignore_index=True), scopes=["005930", "000660"])
    only_a = P.compute_psa_events(a, scopes=["005930"])
    pd.testing.assert_frame_equal(both[both["scope"] == "005930"].reset_index(drop=True), only_a, check_dtype=False)
