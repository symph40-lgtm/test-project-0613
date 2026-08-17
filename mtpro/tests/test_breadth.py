"""부품 5 Breadth — 합성 데이터 테스트 (룩어헤드 assert · 결측 None · PIT 월별 구성 · 분위 · leadership · impulse/z · C-2)."""
from __future__ import annotations

import sys
import pathlib
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from mtpro.components import breadth as B  # noqa: E402
from mtpro.schema import SILVER_CONSTITUENTS_MONTHLY  # noqa: E402


# ---------------------------------------------------------------------------
# 합성 데이터 생성기
# ---------------------------------------------------------------------------

def _trading_days(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _month_first(days: list[date]) -> list[date]:
    firsts, seen = [], set()
    for d in days:
        key = (d.year, d.month)
        if key not in seen:
            seen.add(key)
            firsts.append(d)
    return firsts


def make_universe(n_days: int = 420, n_codes: int = 12, seed: int = 7, start: date = date(2022, 1, 3)):
    rng = np.random.default_rng(seed)
    days = _trading_days(start, n_days)
    codes = [f"{i:06d}" for i in range(1, n_codes + 1)]
    px = 100.0 * np.exp(np.cumsum(rng.normal(0.0003, 0.02, size=(n_days, n_codes)), axis=0))
    close = pd.DataFrame(px, index=days, columns=codes)
    return days, codes, close


def ohlcv_from_close(close: pd.DataFrame, adjusted: bool = True) -> pd.DataFrame:
    long = close.stack(future_stack=True).rename("close").reset_index()
    long.columns = ["date", "code", "close"]
    long = long.dropna(subset=["close"])
    long["open"] = long["close"]; long["high"] = long["close"]; long["low"] = long["close"]
    long["volume"] = 1.0; long["trading_value"] = np.nan
    long["price_adjusted"] = adjusted
    long["source"] = "synthetic"; long["fetch_ts"] = pd.Timestamp("2026-01-01", tz="UTC")
    return long


def constituents_and_mcap(days: list[date], codes: list[str], members_by_month=None, seed: int = 3):
    """월초 PIT 구성 + 시총 단면. members_by_month: {asof: [codes]} 없으면 전 종목."""
    rng = np.random.default_rng(seed)
    firsts = _month_first(days)
    cons_rows, mc_rows = [], []
    for a in firsts:
        members = members_by_month.get(a, codes) if members_by_month else codes
        for c in members:
            cons_rows.append({"asof": a, "index_code": "1028", "code": c, "source": "syn", "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
        # 시총: 코드 순서대로 내림차순이 되게 (000001 이 최대) + 약간의 노이즈 없이 결정적
        for i, c in enumerate(codes):
            mc_rows.append({"asof": a, "code": c, "close": 100.0, "market_cap": float(1_000_000 - i * 1000),
                            "trading_value": 1.0, "shares": 1.0, "price_adjusted": False, "source": "syn",
                            "fetch_ts": pd.Timestamp("2026-01-01", tz="UTC")})
    return pd.DataFrame(cons_rows), pd.DataFrame(mc_rows)


SMALL_TIERS = {"large": (1, 4), "mid": (5, 8), "small": (9, 12)}


def build_panel(close, cons, mc, tiers=SMALL_TIERS, output_start=None, calendar=None):
    cm = B.build_constituents_monthly(cons, mc, tiers=tiers)
    return B.compute_breadth_panel(ohlcv_from_close(close), cm, output_start=output_start, calendar=calendar), cm


# ---------------------------------------------------------------------------
# silver: 구성·분위
# ---------------------------------------------------------------------------

def test_constituents_monthly_rank_and_tier():
    days, codes, close = make_universe(n_days=60)
    cons, mc = constituents_and_mcap(days, codes)
    cm = B.build_constituents_monthly(cons, mc, tiers=SMALL_TIERS)
    assert list(cm.columns) == ["month", "asof", "code", "mcap_rank", "tier"]
    first = cm[cm["asof"] == _month_first(days)[0]].sort_values("mcap_rank")
    assert list(first["code"]) == codes                       # 시총 내림차순 = 코드 순
    assert list(first["mcap_rank"]) == list(range(1, 13))
    assert list(first["tier"]) == ["large"] * 4 + ["mid"] * 4 + ["small"] * 4
    # 스키마로 arrow 변환 가능
    tbl = B.constituents_monthly_to_arrow(cm)
    assert tbl.schema.equals(SILVER_CONSTITUENTS_MONTHLY)


def test_constituents_monthly_missing_mcap_gives_none_not_zero():
    days, codes, close = make_universe(n_days=30)
    cons, mc = constituents_and_mcap(days, codes)
    mc = mc[mc["code"] != codes[2]]                          # 한 종목 시총 없음
    cm = B.build_constituents_monthly(cons, mc, tiers=SMALL_TIERS)
    row = cm[cm["code"] == codes[2]].iloc[0]
    assert pd.isna(row["mcap_rank"]) and pd.isna(row["tier"])
    others = cm[cm["code"] != codes[2]]
    assert sorted(others[others["asof"] == others["asof"].min()]["mcap_rank"]) == list(range(1, 12))


def test_constituents_monthly_rejects_adjusted_mcap():
    days, codes, close = make_universe(n_days=30)
    cons, mc = constituents_and_mcap(days, codes)
    mc["price_adjusted"] = True
    with pytest.raises(AssertionError):
        B.build_constituents_monthly(cons, mc)


def test_constituents_monthly_unknown_index_code_is_loud():
    days, codes, close = make_universe(n_days=30)
    cons, mc = constituents_and_mcap(days, codes)
    with pytest.raises(B.BreadthInputError):
        B.build_constituents_monthly(cons, mc, index_code="9999")


# ---------------------------------------------------------------------------
# C-2
# ---------------------------------------------------------------------------

def test_c2_unadjusted_or_mixed_prices_rejected():
    days, codes, close = make_universe(n_days=40)
    cons, mc = constituents_and_mcap(days, codes)
    cm = B.build_constituents_monthly(cons, mc, tiers=SMALL_TIERS)
    with pytest.raises(AssertionError):
        B.compute_breadth_panel(ohlcv_from_close(close, adjusted=False), cm)
    mixed = ohlcv_from_close(close, adjusted=True)
    mixed.loc[mixed.index[:5], "price_adjusted"] = False
    with pytest.raises(AssertionError):
        B.compute_breadth_panel(mixed, cm)


# ---------------------------------------------------------------------------
# 룩어헤드 assert: 미래 행 변경·삭제 시 과거 값 불변
# ---------------------------------------------------------------------------

def _rows_before(panel: pd.DataFrame, cutoff: date) -> pd.DataFrame:
    return panel[panel["date"] < cutoff].reset_index(drop=True)


def test_lookahead_future_price_change_does_not_alter_past():
    days, codes, close = make_universe(n_days=420)
    cons, mc = constituents_and_mcap(days, codes)
    base, _ = build_panel(close, cons, mc)
    cutoff = days[300]
    # (a) 미래 가격을 크게 바꿈 → 미래 신고가·MA·impulse·z 가 바뀌어도 과거 행 불변
    mutated = close.copy()
    mutated.loc[[d for d in days if d >= cutoff]] *= 3.0
    alt, _ = build_panel(mutated, cons, mc)
    pd.testing.assert_frame_equal(_rows_before(base, cutoff), _rows_before(alt, cutoff))
    # 미래 행은 실제로 달라졌어야 테스트가 의미 있음
    assert not base[base["date"] >= cutoff]["new_high_252"].equals(alt[alt["date"] >= cutoff]["new_high_252"])
    # (b) 미래 행 삭제
    truncated = close.loc[[d for d in days if d < cutoff]]
    cut, _ = build_panel(truncated, cons[cons["asof"] < cutoff], mc[mc["asof"] < cutoff])
    pd.testing.assert_frame_equal(_rows_before(base, cutoff), cut)


def test_lookahead_future_constituent_change_does_not_alter_past():
    days, codes, close = make_universe(n_days=420)
    firsts = _month_first(days)
    cons, mc = constituents_and_mcap(days, codes)
    base, _ = build_panel(close, cons, mc)
    cutoff = firsts[-3]
    # 미래 스냅샷에서 종목 절반 편출
    fut = cons["asof"] >= cutoff
    cons2 = pd.concat([cons[~fut], cons[fut & cons["code"].isin(codes[:6])]])
    alt, _ = build_panel(close, cons2, mc)
    pd.testing.assert_frame_equal(_rows_before(base, cutoff), _rows_before(alt, cutoff))
    assert (alt[alt["date"] >= cutoff]["n_available"] == 6).all()


def test_impulse_z_uses_only_past_window():
    # impulse 시계열을 직접 만들어 z 가 당일을 기준 분포에 넣지 않는지 확인
    n = 200
    rng = np.random.default_rng(1)
    imp = pd.Series(rng.normal(0, 1, n))
    z = B.breadth_impulse_z(imp)
    t = 150
    hist = imp.iloc[t - B.IMPULSE_Z_WINDOW_DAYS:t]           # t 제외 직전 120
    expected = (imp.iloc[t] - hist.mean()) / hist.std(ddof=1)
    assert z.iloc[t] == pytest.approx(expected)
    # 표본 < 60 → None
    assert z.iloc[:B.IMPULSE_Z_MIN_SAMPLES].isna().all()
    assert pd.notna(z.iloc[B.IMPULSE_Z_MIN_SAMPLES])
    # 미래 값 변경이 과거 z 에 영향 없음
    imp2 = imp.copy(); imp2.iloc[151:] += 100
    z2 = B.breadth_impulse_z(imp2)
    pd.testing.assert_series_equal(z.iloc[:151], z2.iloc[:151])


# ---------------------------------------------------------------------------
# 결측 None · 편출/상폐 · 분모
# ---------------------------------------------------------------------------

def test_missing_prices_reduce_denominator_not_zero_filled():
    days, codes, close = make_universe(n_days=120)
    cons, mc = constituents_and_mcap(days, codes)
    close = close.copy()
    gone_from = days[80]
    close.loc[[d for d in days if d >= gone_from], codes[0]] = np.nan   # 상장폐지 흉내: 가격 이력 끊김
    panel, _ = build_panel(close, cons, mc)
    before = panel[panel["date"] < gone_from]
    after = panel[panel["date"] >= gone_from]
    assert (before["n_available"] == 12).all()
    assert (after["n_available"] == 11).all()
    # above_20d_ratio 는 11 종목 평균이어야 함 (0 대체면 12로 나눠 값이 작아짐)
    d = days[100]
    ma20 = close.rolling(20, min_periods=20).mean()
    manual = float((close.loc[d, codes[1:]] > ma20.loc[d, codes[1:]]).mean())
    got = float(panel.loc[panel["date"] == d, "above_20d_ratio"].iloc[0])
    assert got == pytest.approx(manual)


def test_all_missing_day_gives_none_not_zero():
    days, codes, close = make_universe(n_days=100)
    cons, mc = constituents_and_mcap(days, codes)
    close = close.copy()
    d = days[70]
    close.loc[d, :] = np.nan
    panel, _ = build_panel(close, cons, mc, calendar=days)     # 달력을 주면 전 종목 결측일도 행으로 남는다
    row = panel[panel["date"] == d].iloc[0]
    assert row["n_available"] == 0
    for c in ("above_20d_ratio", "above_60d_ratio", "new_high_252", "new_low_252", "adv_ratio",
              "large_above20", "mid_above20", "small_above20", "leadership"):
        assert pd.isna(row[c]), c
    # 그 날을 포함하는 20일 창의 impulse 도 None (0 대체 없음)
    later = panel[(panel["date"] > d)].head(19)
    assert later["breadth_impulse"].isna().all()


def test_early_rows_none_until_windows_fill():
    days, codes, close = make_universe(n_days=300)
    cons, mc = constituents_and_mcap(days, codes)
    panel, _ = build_panel(close, cons, mc)
    assert panel["above_20d_ratio"].iloc[:19].isna().all() and panel["above_20d_ratio"].iloc[19:].notna().all()
    assert panel["above_60d_ratio"].iloc[:59].isna().all() and panel["above_60d_ratio"].iloc[59:].notna().all()
    assert panel["new_high_252"].iloc[:251].isna().all() and panel["new_high_252"].iloc[251:].notna().all()
    assert pd.isna(panel["adv_ratio"].iloc[0]) and panel["adv_ratio"].iloc[1:].notna().all()
    # impulse: above_20d 첫 유효 = idx 19 → 20개 필요 → idx 38 부터
    assert panel["breadth_impulse"].iloc[:38].isna().all() and panel["breadth_impulse"].iloc[38:].notna().all()
    # z: impulse 첫 유효 38, 당일 제외 60 표본 → idx 98 부터
    assert panel["breadth_impulse_z"].iloc[:98].isna().all() and panel["breadth_impulse_z"].iloc[98:].notna().all()


def test_removed_constituent_excluded_even_if_priced():
    days, codes, close = make_universe(n_days=90)
    firsts = _month_first(days)
    cons, mc = constituents_and_mcap(days, codes)
    drop_from = firsts[2]
    cons2 = cons[~((cons["asof"] >= drop_from) & (cons["code"] == codes[5]))]
    panel, cm = build_panel(close, cons2, mc)
    assert (panel[panel["date"] >= drop_from]["n_available"] == 11).all()
    assert (panel[panel["date"] < drop_from]["n_available"] == 12).all()
    # constituents_asof 가 스냅샷 날짜로 기록됨
    assert (panel[panel["date"] >= drop_from]["constituents_asof"] >= drop_from).all()
    assert set(panel["constituents_asof"].unique()) == set(firsts)


def test_output_start_filters_but_uses_lookback():
    days, codes, close = make_universe(n_days=300)
    cons, mc = constituents_and_mcap(days, codes)
    full, _ = build_panel(close, cons, mc, output_start=None)
    start = days[150]
    part, _ = build_panel(close, cons, mc, output_start=start)
    pd.testing.assert_frame_equal(full[full["date"] >= start].reset_index(drop=True), part)
    assert part["breadth_impulse_z"].iloc[0] is not pd.NA and not pd.isna(part["breadth_impulse_z"].iloc[0])


# ---------------------------------------------------------------------------
# 지표 정의 검산
# ---------------------------------------------------------------------------

def test_new_high_low_and_adv_ratio_definitions():
    days, codes, close = make_universe(n_days=300)
    cons, mc = constituents_and_mcap(days, codes)
    panel, _ = build_panel(close, cons, mc)
    d = days[280]
    win = close.loc[[x for x in days if x <= d]].tail(252)
    nh = int((close.loc[d] >= win.max()).sum())
    nl = int((close.loc[d] <= win.min()).sum())
    row = panel[panel["date"] == d].iloc[0]
    assert row["new_high_252"] == nh and row["new_low_252"] == nl
    prev = days[279]
    adv = float((close.loc[d] > close.loc[prev]).mean())
    assert row["adv_ratio"] == pytest.approx(adv)


def test_breadth_impulse_formula():
    r = pd.Series(np.arange(1, 41, dtype=float) / 100)      # 0.01..0.40
    imp = B.breadth_impulse(r)
    assert imp.iloc[:19].isna().all()
    t = 25
    expected = r.iloc[t - 4:t + 1].mean() - r.iloc[t - 19:t - 4].mean()
    assert imp.iloc[t] == pytest.approx(expected)


def test_leadership_rules_and_constants():
    assert B.leadership_label(0.5, 0.2) == "large_cap_only"
    assert B.leadership_label(0.35, 0.35) == "broad"
    assert B.leadership_label(0.5, 0.35) == "broad"          # large>0.4 but mid>=0.25 → broad 조건
    assert B.leadership_label(0.2, 0.2) == "mixed"
    assert B.leadership_label(0.5, 0.25) == "mixed"          # 경계: mid<0.25 아님, mid>0.3 아님
    assert B.leadership_label(None, 0.3) is None
    assert B.leadership_label(0.5, float("nan")) is None
    assert B.LEADERSHIP_LARGE_ONLY == {"large_gt": 0.40, "mid_lt": 0.25}
    assert B.LEADERSHIP_BROAD == {"large_gt": 0.30, "mid_gt": 0.30}
    assert B.DEFAULT_TIERS == {"large": (1, 50), "mid": (51, 150), "small": (151, 200)}


def test_tier_ratios_match_manual():
    days, codes, close = make_universe(n_days=100)
    cons, mc = constituents_and_mcap(days, codes)
    panel, cm = build_panel(close, cons, mc)
    d = days[90]
    ma20 = close.rolling(20, min_periods=20).mean()
    above = (close.loc[d] > ma20.loc[d])
    row = panel[panel["date"] == d].iloc[0]
    assert row["large_above20"] == pytest.approx(above[codes[0:4]].mean())
    assert row["mid_above20"] == pytest.approx(above[codes[4:8]].mean())
    assert row["small_above20"] == pytest.approx(above[codes[8:12]].mean())
    assert row["leadership"] == B.leadership_label(row["large_above20"], row["mid_above20"])


def test_config_tiers_match_module_defaults():
    import yaml
    cfg = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    tiers = {k: tuple(v) for k, v in cfg["breadth"]["tiers"].items()}
    assert tiers == B.DEFAULT_TIERS
    assert str(cfg["breadth"]["lookback_start"]) == "2022-01-03"


def test_panel_columns_and_arrow_nulls():
    days, codes, close = make_universe(n_days=80)
    cons, mc = constituents_and_mcap(days, codes)
    panel, _ = build_panel(close, cons, mc)
    assert list(panel.columns) == B.PANEL_COLUMNS
    tbl = B.panel_to_arrow(panel)
    assert tbl.schema.equals(B.GOLD_BREADTH_PANEL)
    # 결측이 null 로 저장(NaN 아님)
    assert tbl.column("above_60d_ratio").null_count == 59
    assert tbl.column("new_high_252").null_count == 80
    assert (panel["engine_ver"] == B.ENGINE_VER).all()
    s = B.summarize_panel(panel)
    assert s["rows"] == 80 and s["none_ratio"]["new_high_252"] == 1.0


# ---------------------------------------------------------------------------
# jobs/build_breadth.py 엔드투엔드 (합성 bronze → silver·gold parquet)
# ---------------------------------------------------------------------------

def test_build_job_end_to_end(tmp_path, monkeypatch):
    import importlib.util
    import pyarrow.parquet as pq
    from mtpro.schema import BRONZE_CONSTITUENTS, BRONZE_MARKET_CAP, BRONZE_OHLCV

    spec = importlib.util.spec_from_file_location(
        "build_breadth", pathlib.Path(__file__).resolve().parents[1] / "jobs" / "build_breadth.py")
    job = importlib.util.module_from_spec(spec); spec.loader.exec_module(job)

    days, codes, close = make_universe(n_days=330, n_codes=12)
    cons, mc = constituents_and_mcap(days, codes)
    ohlcv = ohlcv_from_close(close)
    # 지수 달력 (code=KOSPI200)
    idx = ohlcv[ohlcv["code"] == codes[0]].copy(); idx["code"] = "KOSPI200"

    bronze = tmp_path / "bronze"; bronze.mkdir()
    def _w(df, schema, name):
        df = df.copy()
        for c in ("date", "asof"):
            if c in df.columns:
                df[c] = pd.to_datetime(df[c]).dt.date
        pq.write_table(pa_table(df, schema), bronze / name)
    import pyarrow as pa
    def pa_table(df, schema):
        return pa.Table.from_pandas(df[schema.names], schema=schema, preserve_index=False)
    _w(cons, BRONZE_CONSTITUENTS, "constituents.parquet")
    _w(mc, BRONZE_MARKET_CAP, "market_cap.parquet")
    _w(ohlcv, BRONZE_OHLCV, "ohlcv_adj_constituents.parquet")
    _w(idx, BRONZE_OHLCV, "ohlcv_adj.parquet")

    monkeypatch.setitem(job.BRONZE_FILES, "constituents", bronze / "constituents.parquet")
    monkeypatch.setitem(job.BRONZE_FILES, "market_cap", bronze / "market_cap.parquet")
    monkeypatch.setitem(job.BRONZE_FILES, "ohlcv_adj_constituents", bronze / "ohlcv_adj_constituents.parquet")
    monkeypatch.setitem(job.OPTIONAL_FILES, "ohlcv_adj", bronze / "ohlcv_adj.parquet")
    monkeypatch.setattr(job, "SILVER_OUT", tmp_path / "silver.parquet")
    monkeypatch.setattr(job, "GOLD_OUT", tmp_path / "gold.parquet")
    monkeypatch.setattr(job.settings, "ensure_dirs", lambda: None)

    summ = tmp_path / "s.json"
    rc = job.main(["--start", str(days[260]), "--summary-json", str(summ)])
    assert rc == 0
    gold = pq.read_table(tmp_path / "gold.parquet")
    assert gold.schema.equals(B.GOLD_BREADTH_PANEL)
    g = gold.to_pandas()
    assert g["date"].min() == days[260] and len(g) == 70
    assert g["breadth_impulse_z"].notna().all()            # 2022 lookback 으로 z 가 출력 시작일부터 유효
    silver = pq.read_table(tmp_path / "silver.parquet")
    assert silver.schema.equals(SILVER_CONSTITUENTS_MONTHLY)
    # 실데이터 tiers(1~50/51~150/151~200)를 12종목에 적용 → 전부 large
    assert set(silver.to_pandas()["tier"].unique()) == {"large"}
    import json
    s = json.loads(summ.read_text(encoding="utf-8"))
    assert s["rows"] == 70 and s["calendar_source"] == "ohlcv_adj(1028)"


def test_build_job_wait_timeout(monkeypatch, tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "build_breadth2", pathlib.Path(__file__).resolve().parents[1] / "jobs" / "build_breadth.py")
    job = importlib.util.module_from_spec(spec); spec.loader.exec_module(job)
    monkeypatch.setitem(job.BRONZE_FILES, "constituents", tmp_path / "nope.parquet")
    assert job.main(["--wait-minutes", "0"]) == 3
