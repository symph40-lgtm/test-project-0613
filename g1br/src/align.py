# T3 — 시간 정렬 (WORKORDER §4 / 스펙 §2.3). 이번 주의 본체.
#
# 구조를 둘로 나눈다:
#   map_nights(start, end)        — 캘린더만으로 (미 세션들 → 다음 KRX 개장) 매핑 + 전수 룩어헤드 assert.
#                                    시장 데이터 불필요 → 테스트가 오프라인으로 돈다.
#   build_night_panel(start, end) — 매핑 위에 parquet 캐시의 변수·라벨을 얹는다.
#
# 규칙 (스펙 §2.3 그대로):
#   1) 미 휴장·KRX 개장일 → 표본 제외 (us_holiday_skip 기록)
#   2) KRX 휴장·미 개장일 → 미 2세션+ 누적, multi_session=True, 기본 회귀 제외 플래그
#   3) 캘린더는 exchange_calendars(XKRX/XNYS) — 수기 휴일 리스트 금지
#   4) 전수 assert: us_close_ts(UTC) < krx_open_ts(UTC). 위반 1건이라도 → LookaheadError로 중단
#   5) 서머타임은 타임존 라이브러리에 위임 (수동 오프셋 금지) — 테스트로 검증
#   6) 락일: pykrx 이벤트 API가 KRX 계정 필요(AUDIT §3-1)라 무계정 시 ex_date=False + 경고 기록
import math
from functools import lru_cache
from pathlib import Path

import exchange_calendars as xcals
import numpy as np
import pandas as pd

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"


class LookaheadError(RuntimeError):
    """시간 정렬 위반 — 우회 금지, 파이프라인 중단 (WORKORDER §0-3)."""


@lru_cache(maxsize=4)
def _cal(name: str):
    return xcals.get_calendar(name, start="2022-01-01")


def _assert_no_lookahead(df: pd.DataFrame) -> None:
    bad = df[df["us_close_utc"] >= df["krx_open_utc"]]
    if len(bad):
        first = bad.iloc[0]
        raise LookaheadError(
            f"룩어헤드 {len(bad)}건: 예) 미 세션 {first['us_dates']} 마감 {first['us_close_utc']} "
            f">= KRX {first['krx_date']} 개장 {first['krx_open_utc']}"
        )


def map_nights(start: str, end: str) -> pd.DataFrame:
    """각 행 = '하나의 밤' (미 세션 묶음 → 다음 KRX 개장). 캘린더 정보만 사용."""
    xkrx, xnys = _cal("XKRX"), _cal("XNYS")
    krx_sessions = xkrx.sessions_in_range(start, end)
    us_sessions = xnys.sessions_in_range(
        (pd.Timestamp(start) - pd.Timedelta(days=15)).date().isoformat(), end
    )
    if len(krx_sessions) < 2:
        return pd.DataFrame()

    # 미 세션 → (close_utc, half_day). exchange_calendars의 스케줄이 DST를 처리한다 (규칙 5).
    us_closes = xnys.schedule.loc[us_sessions, "close"]  # tz-aware UTC
    # 반일장 = ET 기준 마감이 16시 이전 (13:00 ET 등). ET 변환으로 DST 계절차를 흡수한다.
    us_close_et_hour = us_closes.dt.tz_convert("America/New_York").dt.hour
    krx_opens = xkrx.schedule.loc[krx_sessions, "open"]

    rows = []
    # 각 KRX 세션 d(i≥1)에 대해: 직전 KRX 세션 d-1 이후 ~ d 개장 이전에 마감된 미 세션 전부가 그 밤의 소스
    for i in range(1, len(krx_sessions)):
        d_prev, d = krx_sessions[i - 1], krx_sessions[i]
        open_utc = krx_opens.iloc[i]
        prev_open_utc = krx_opens.iloc[i - 1]
        mask = (us_closes > prev_open_utc) & (us_closes < open_utc)
        sel = us_closes[mask]
        n = len(sel)
        half = bool(n and (us_close_et_hour[mask] < 16).any())
        rows.append({
            "krx_date": d.date().isoformat(),
            "krx_prev_date": d_prev.date().isoformat(),
            "krx_open_utc": open_utc,
            "us_dates": [t.date().isoformat() for t in sel.index],
            "us_close_utc": sel.iloc[-1] if n else pd.NaT,
            "n_us_sessions": n,
            "us_holiday_skip": n == 0,
            "multi_session": n >= 2,
            "us_half_day": half,
            "excluded": n == 0,                       # 규칙 1
            "exclude_from_base_regression": n != 1,   # 규칙 2 (multi_session도 기본 회귀 제외)
        })
    df = pd.DataFrame(rows)
    _assert_no_lookahead(df[~df["excluded"]])         # 규칙 4 — 전수 assert
    return df


# ───────── 데이터 결합 ─────────

def _load(name: str) -> pd.Series:
    df = pd.read_parquet(RAW / (name + ".parquet")).set_index("data_date").sort_index()
    return df["close"]


def _load_oc(name: str) -> pd.DataFrame:
    return (
        pd.read_parquet(RAW / (name + ".parquet"))[["data_date", "open", "close"]]
        .set_index("data_date").sort_index()
    )


def _ret_over(series: pd.Series, dates: list) -> float:
    """미 세션 묶음의 누적 로그수익률 — 첫 세션 직전 종가 → 마지막 세션 종가 (multi_session 대응)."""
    if not dates:
        return math.nan
    idx = series.index
    pos0 = idx.searchsorted(dates[0])
    if pos0 == 0 or pos0 >= len(idx) or idx[min(pos0, len(idx) - 1)] < dates[0]:
        # dates[0]가 시리즈에 없으면(해당 시장 휴장) 직전 관측 사용
        pos0 = min(pos0, len(idx) - 1)
    posN = idx.searchsorted(dates[-1], side="right") - 1
    if posN < 1 or pos0 < 1:
        return math.nan
    base = series.iloc[pos0 - 1]
    last = series.iloc[posN]
    if not (base > 0 and last > 0):
        return math.nan
    return math.log(last / base)


def _diff_over(series: pd.Series, dates: list) -> float:
    """레벨 차분(금리 등) — 첫 세션 직전 관측 → 마지막 세션 관측."""
    if not dates:
        return math.nan
    idx = series.index
    pos0 = idx.searchsorted(dates[0])
    posN = idx.searchsorted(dates[-1], side="right") - 1
    if posN < 0 or pos0 < 1:
        return math.nan
    a, b = series.iloc[pos0 - 1], series.iloc[posN]
    return float(b - a) if (pd.notna(a) and pd.notna(b)) else math.nan


def _sum_over(daily_series: pd.Series, dates: list) -> float:
    """일별 변화량(bp 등)의 세션 묶음 합 — multi_session이면 누적. 결측 하나라도 있으면 NaN."""
    if not dates:
        return math.nan
    vals = [daily_series.get(d, math.nan) for d in dates]
    if any(pd.isna(v) for v in vals):
        return math.nan
    return float(sum(vals))


def _asof(series: pd.Series, date: str) -> float:
    idx = series.index
    pos = idx.searchsorted(date, side="right") - 1
    return float(series.iloc[pos]) if pos >= 0 and pd.notna(series.iloc[pos]) else math.nan


def _prev_ret(series: pd.Series, before_date: str) -> float:
    """before_date 이전 마지막 관측의 직전 대비 로그수익률 (아시아 전일 변수)."""
    idx = series.index
    pos = idx.searchsorted(before_date) - 1
    if pos < 1:
        return math.nan
    a, b = series.iloc[pos - 1], series.iloc[pos]
    return math.log(b / a) if (a > 0 and b > 0) else math.nan


# available_by_0715 판정 (AUDIT §2 실측 근거) — 패널 attrs에 기록
AVAILABLE_BY_0715 = {
    "r_spx": True, "r_soxx": True, "r_tsm": True, "r_mu": True, "r_nvda": True,
    "r_ewy": True, "breadth_proxy": True, "r_gdr": True,
    "d_y2_bp": True, "d_y10_bp": True,    # ^TNX·ZT=F 환산 (발주자 T1 판정 — 조건부 편입+감시)
    "d_fx_daily": False,                   # KRW=X 일봉은 KST 08~09시 완성 (AUDIT §3-부록) — 참조용만
    "d_fx_night": True,                    # b4 확정(T3): 60분봉 07:00 KST 절단 — 2024-08 이후 가용
    "r_n225_prev": True, "r_axjo_prev": True,
    "gap": False, "gap_idx": False,        # 라벨 (사후값)
}


def build_night_panel(start: str, end: str) -> pd.DataFrame:
    nights = map_nights(start, end)
    if nights.empty:
        return nights

    spx = _load("yf__i_GSPC")
    soxx = _load("yf_SOXX")
    tsm = _load("yf_TSM")
    mu = _load("yf_MU")
    nvda = _load("yf_NVDA")
    ewy = _load("yf_EWY")
    rsp = _load("yf_RSP")
    spy = _load("yf_SPY")
    gdr = _load("yf_SMSN_IL")
    # 금리 (발주자 T1 판정 2026-08-09): 10Y = ^TNX(×10=bp) / 2Y = ZT=F DV01 환산(bp).
    # 2YY=F는 피드 붕괴로 사용 금지 (backlog.md 포스트모템). 감시: 롤링 126일 상관 <0.90 → I1b 강등 플래그.
    try:
        from src.rates import TNX_INDEX_TO_BP, zt_monitor_corr126, zt_yield_bp
    except ModuleNotFoundError:  # 직접 실행(python src/align.py) 시
        from rates import TNX_INDEX_TO_BP, zt_monitor_corr126, zt_yield_bp
    tnx_bp = _load("yf__i_TNX").diff() * TNX_INDEX_TO_BP
    zt_bp = zt_yield_bp()
    y2_mon = zt_monitor_corr126()
    fx = _load("yf_KRW_eq_X")
    # b4 확정 (T3 판정 2026-08-09): Δfx = 60분봉 야간 절단 (전 KRX일 15:00 KST → 당일 07:00 KST).
    # 2024-08 이후만 가용 — 그 이전 밤은 NaN (A안 전일봉은 fx 없는 대조보다도 나빠 기각).
    fx_night_lookup: dict[str, float] = {}
    fxh_path = RAW / "yf_KRW_eq_X_60m.parquet"
    if fxh_path.exists():
        h = pd.read_parquet(fxh_path)
        h["ts"] = pd.to_datetime(h["ts_utc"], utc=True)
        h = h.sort_values("ts")
        hts = h["ts"].values
        hcl = h["close"].values

        def _fx_at(anchor: pd.Timestamp) -> float:
            pos = hts.searchsorted(np.datetime64(anchor.tz_convert(None))) - 1
            return float(hcl[pos]) if pos >= 0 else math.nan

        for i in range(1, len(nights)):
            r = nights.iloc[i]
            p1 = _fx_at(pd.Timestamp(r["krx_prev_date"] + "T06:00:00Z"))
            p2 = _fx_at(pd.Timestamp(r["krx_date"] + "T22:00:00Z") - pd.Timedelta(days=1))
            if p1 > 0 and p2 > 0:
                fx_night_lookup[r["krx_date"]] = math.log(p2 / p1)
    n225 = _load("yf__i_N225")
    axjo = _load("yf__i_AXJO")
    k200 = _load_oc("kospi200_pykrx" if (RAW / "kospi200_pykrx.parquet").exists() else "kospi200_ks200")
    ss = _load_oc("krx_005930")
    hx = _load_oc("krx_000660")

    def label_gap(oc: pd.DataFrame, prev_d: str, d: str) -> float:
        if prev_d not in oc.index or d not in oc.index:
            return math.nan
        c, o = oc.loc[prev_d, "close"], oc.loc[d, "open"]
        return math.log(o / c) if (c > 0 and o > 0) else math.nan

    recs = []
    for _, r in nights.iterrows():
        ud, d, pd_ = r["us_dates"], r["krx_date"], r["krx_prev_date"]
        recs.append({
            **{k: r[k] for k in ["krx_date", "krx_prev_date", "us_dates", "n_us_sessions",
                                  "us_holiday_skip", "multi_session", "us_half_day",
                                  "excluded", "exclude_from_base_regression",
                                  "us_close_utc", "krx_open_utc"]},
            # 미국 세션 변수 (t — multi_session이면 누적)
            "r_spx": _ret_over(spx, ud), "r_soxx": _ret_over(soxx, ud),
            "r_tsm": _ret_over(tsm, ud), "r_mu": _ret_over(mu, ud),
            "r_nvda": _ret_over(nvda, ud), "r_ewy": _ret_over(ewy, ud),
            "breadth_proxy": _ret_over(rsp, ud) - _ret_over(spy, ud),
            "r_gdr": _ret_over(gdr, ud),
            "d_y10_bp": _sum_over(tnx_bp, ud), "d_y2_bp": _sum_over(zt_bp, ud),
            "y2_monitor_corr126": (lambda v: round(v, 4) if pd.notna(v) else math.nan)(_asof(y2_mon, ud[-1]) if ud else math.nan),
            "y2_degraded": (_asof(y2_mon, ud[-1]) < 0.90) if ud and pd.notna(_asof(y2_mon, ud[-1])) else False,
            "d_fx_daily": _ret_over(fx, ud),
            "d_fx_night": fx_night_lookup.get(d, math.nan),
            # 아시아 전일 변수 (KRX 개장 전 확정치)
            "r_n225_prev": _prev_ret(n225, d), "r_axjo_prev": _prev_ret(axjo, d),
            # 락일 — KRX 계정 없이는 이벤트 API 불가 (AUDIT §3-1): False 고정 + attrs 경고
            "ex_date": False,
            # 라벨
            "gap_idx": label_gap(k200, pd_, d),
            "gap_ss": label_gap(ss, pd_, d),
            "gap_hx": label_gap(hx, pd_, d),
        })
    panel = pd.DataFrame(recs)
    _assert_no_lookahead(panel[~panel["excluded"]])
    panel.attrs["available_by_0715"] = AVAILABLE_BY_0715
    panel.attrs["ex_date_warning"] = "pykrx 이벤트 API는 KRX 계정 필요 — 무계정 실행이라 ex_date 전부 False (AUDIT §3-1)"
    return panel


def summary(panel: pd.DataFrame) -> dict:
    live = panel[~panel["excluded"]]
    var_cols = [c for c in panel.columns if c.startswith(("r_", "d_", "gap", "breadth"))]
    return {
        "nights_total": int(len(panel)),
        "nights_live": int(len(live)),
        "excluded_us_holiday": int(panel["us_holiday_skip"].sum()),
        "multi_session": int(panel["multi_session"].sum()),
        "us_half_day": int(panel["us_half_day"].sum()),
        "missing_pct": {c: round(100 * float(live[c].isna().mean()), 2) for c in var_cols},
        "period": [panel["krx_date"].min(), panel["krx_date"].max()],
    }


if __name__ == "__main__":
    import io, json, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    p = build_night_panel("2023-01-01", "2026-08-08")
    print(json.dumps(summary(p), ensure_ascii=False, indent=1))
    out = RAW.parent / "night_panel.parquet"
    p.drop(columns=["us_close_utc", "krx_open_utc"]).assign(
        us_dates=p["us_dates"].apply(lambda x: ",".join(x))
    ).to_parquet(out, index=False)
    print(f"저장: {out}")
