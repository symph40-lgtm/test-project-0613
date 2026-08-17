"""부품 5 — Breadth Impulse (WORKORDER_MTPRO_v10.1 §2.1 소급 트랙, T1-2 승인 제안, config `breadth` 블록).

입력(bronze, 읽기 전용 — 적재는 ingest 소관):
  - constituents.parquet   : 월초 첫 거래일 PIT KOSPI200 구성종목 (asof, index_code, code)
  - market_cap.parquet     : 월초 시총 단면 (asof, code, market_cap, price_adjusted=False) — **순위 산출에만** 사용
  - ohlcv_adj_constituents : 구성종목 수정주가 OHLCV (date, code, close, price_adjusted=True) — 모든 가격 지표의 유일한 원천

출력:
  - silver/constituents_monthly.parquet (schema.SILVER_CONSTITUENTS_MONTHLY): month, asof, code, mcap_rank, tier
  - gold/breadth_panel.parquet (GOLD_BREADTH_PANEL, 이 모듈에 정의): 일별 breadth 패널

규칙(사전 등록·불변 규칙):
  - 월별 PIT: 날짜 d 의 구성 리스트 = asof ≤ d 인 가장 최근 월초 스냅샷. `constituents_asof` 열에 기록.
  - 시총 분위: 그 asof 시총 단면의 KOSPI200 내 순위 1~50 large / 51~150 mid / 151~200 small (config tiers).
  - C-2: 가격 지표(MA20/60·252일 신고저·등락)는 price_adjusted=True 원천만. 시총 단면은 순위에만 쓰고 가격 식에 넣지 않는다.
  - 결측은 None (0 대체 금지). 편출·상장폐지·미상장 구간은 그 종목의 그날 결측 → 분모(n_available)에서 빠진다.
  - 룩어헤드 없음: 모든 롤링은 과거~당일까지만. impulse_z 기준 분포는 **당일 제외** 직전 120 거래일(표본<60 → None).
  - 상수는 아래 모듈 상수로 노출(측정 후 변경 금지, 변경은 amendment).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Mapping, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa

from mtpro.schema import SILVER_CONSTITUENTS_MONTHLY, assert_same_adjustment

ENGINE_VER = "breadth-0.1"

# ---- 사전 등록 상수 --------------------------------------------------------------
MA_SHORT_DAYS = 20                 # above_20d
MA_LONG_DAYS = 60                  # above_60d
HIGH_LOW_WINDOW_DAYS = 252         # 252일 신고가·신저가 (당일 포함 252 거래일, 전부 유효해야 산출)
IMPULSE_RECENT_DAYS = 5            # breadth_impulse = mean(최근 5일) − mean(이전 15일)
IMPULSE_PRIOR_DAYS = 15
IMPULSE_Z_WINDOW_DAYS = 120        # impulse_z 기준 분포 = 당일 제외 직전 120 거래일의 impulse
IMPULSE_Z_MIN_SAMPLES = 60         # 표본 < 60 → None
LEADERSHIP_LARGE_ONLY = {"large_gt": 0.40, "mid_lt": 0.25}    # large>0.4 & mid<0.25 → large_cap_only
LEADERSHIP_BROAD = {"large_gt": 0.30, "mid_gt": 0.30}         # large>0.3 & mid>0.3   → broad
LEADERSHIP_LABELS = ("large_cap_only", "broad", "mixed")
DEFAULT_TIERS: dict[str, tuple[int, int]] = {"large": (1, 50), "mid": (51, 150), "small": (151, 200)}
TIER_NAMES = ("large", "mid", "small")
DEFAULT_INDEX_CODE = "1028"        # KOSPI200 (pykrx 지수 코드)
OUTPUT_START = date(2023, 1, 3)    # 지표 산출 시작 (lookback 2022-01-03~ 은 config breadth.lookback_start)

GOLD_BREADTH_PANEL = pa.schema([
    ("date", pa.date32()),
    ("constituents_asof", pa.date32()),
    ("n_available", pa.int32()),          # 그날 구성종목 중 유효 종가 보유 종목 수
    ("above_20d_ratio", pa.float64()),
    ("above_60d_ratio", pa.float64()),
    ("new_high_252", pa.int32()),
    ("new_low_252", pa.int32()),
    ("adv_ratio", pa.float64()),          # 전일 대비 상승 종목 / 전일·당일 종가 모두 유효한 종목 (보합은 분모에만)
    ("large_above20", pa.float64()),
    ("mid_above20", pa.float64()),
    ("small_above20", pa.float64()),
    ("leadership", pa.string()),
    ("breadth_impulse", pa.float64()),
    ("breadth_impulse_z", pa.float64()),
    ("engine_ver", pa.string()),
])
PANEL_COLUMNS = GOLD_BREADTH_PANEL.names


class BreadthInputError(ValueError):
    """loud-failure: 입력 결손·스키마 위반은 조용히 넘어가지 않는다."""


# ---------------------------------------------------------------------------
# silver: 월별 PIT 구성 + 시총 분위
# ---------------------------------------------------------------------------

def _tier_of(rank: Optional[int], tiers: Mapping[str, tuple[int, int]]) -> Optional[str]:
    if rank is None or (isinstance(rank, float) and np.isnan(rank)):
        return None
    r = int(rank)
    for name, (lo, hi) in tiers.items():
        if lo <= r <= hi:
            return name
    # D-C (발주자 2026-08-17 승인): KRX PDF가 200을 초과해 반환한 기간(2024-10·11·12, 201종목)의 초과 순위는
    # 순위 기준으로 마지막 분위(small = 151~끝)에 귀속. config breadth.tier_overflow 참조.
    last_name, (last_lo, _) = max(tiers.items(), key=lambda kv: kv[1][1])
    if r > last_lo:
        return last_name
    return None


def build_constituents_monthly(
    constituents: pd.DataFrame,
    market_cap: pd.DataFrame,
    tiers: Mapping[str, Sequence[int]] | None = None,
    index_code: Optional[str] = DEFAULT_INDEX_CODE,
) -> pd.DataFrame:
    """월초 PIT 구성 리스트 × 그 asof 시총 단면 → (month, asof, code, mcap_rank, tier).

    - 순위는 **그 asof 구성종목 안에서** 시총 내림차순 1..N (동률은 code 오름차순으로 결정적).
    - 시총 단면에 없는 구성종목은 mcap_rank/tier = None (그 종목만 결측, 나머지 순위는 시총 보유 종목끼리 1..N).
    - 시총은 여기서 순위에만 쓰인다. 가격 컬럼과 섞지 않는다(C-2). market_cap.price_adjusted 는 True 가 섞여 있으면 거부.
    """
    tiers_t = {k: (int(v[0]), int(v[1])) for k, v in (tiers or DEFAULT_TIERS).items()}
    cons = constituents.copy()
    if "index_code" in cons.columns and index_code is not None:
        codes_present = set(cons["index_code"].astype(str).unique())
        if index_code not in codes_present:
            raise BreadthInputError(f"constituents has no index_code={index_code!r} (present: {sorted(codes_present)})")
        cons = cons[cons["index_code"].astype(str) == index_code]
    for col in ("asof", "code"):
        if col not in cons.columns:
            raise BreadthInputError(f"constituents missing column {col!r}")
    cons["asof"] = pd.to_datetime(cons["asof"]).dt.date
    cons["code"] = cons["code"].astype(str)
    cons = cons[["asof", "code"]].drop_duplicates()

    mc = market_cap.copy()
    for col in ("asof", "code", "market_cap"):
        if col not in mc.columns:
            raise BreadthInputError(f"market_cap missing column {col!r}")
    if "price_adjusted" in mc.columns and mc["price_adjusted"].astype(bool).any():
        raise AssertionError("C-2: market_cap cross-section must be unadjusted (price_adjusted=False)")
    mc["asof"] = pd.to_datetime(mc["asof"]).dt.date
    mc["code"] = mc["code"].astype(str)
    mc = mc[["asof", "code", "market_cap"]].dropna(subset=["market_cap"]).drop_duplicates(["asof", "code"], keep="last")

    merged = cons.merge(mc, on=["asof", "code"], how="left")
    out_rows: list[dict] = []
    for asof, g in merged.groupby("asof", sort=True):
        g = g.sort_values(["market_cap", "code"], ascending=[False, True], na_position="last").reset_index(drop=True)
        n_with = int(g["market_cap"].notna().sum())
        ranks = list(range(1, n_with + 1)) + [None] * (len(g) - n_with)
        for (code, rank) in zip(g["code"], ranks):
            out_rows.append({
                "month": f"{asof.year:04d}-{asof.month:02d}",
                "asof": asof,
                "code": code,
                "mcap_rank": rank,
                "tier": _tier_of(rank, tiers_t),
            })
    out = pd.DataFrame(out_rows, columns=["month", "asof", "code", "mcap_rank", "tier"])
    out["mcap_rank"] = out["mcap_rank"].astype("Int32")
    out["tier"] = out["tier"].astype("string")
    return out


def constituents_monthly_to_arrow(df: pd.DataFrame) -> pa.Table:
    return pa.Table.from_pandas(df, schema=SILVER_CONSTITUENTS_MONTHLY, preserve_index=False)


# ---------------------------------------------------------------------------
# gold: 일별 breadth 패널
# ---------------------------------------------------------------------------

def _validate_adjusted(ohlcv: pd.DataFrame) -> None:
    """C-2: 가격 지표 원천은 price_adjusted=True 만. 혼용·비수정은 assert."""
    if "price_adjusted" not in ohlcv.columns:
        raise BreadthInputError("ohlcv missing required column 'price_adjusted' (C-2)")
    flags = [bool(x) for x in ohlcv["price_adjusted"].dropna().unique()]
    if not flags:
        raise BreadthInputError("ohlcv price_adjusted column is empty")
    assert_same_adjustment(*flags)
    if flags != [True]:
        raise AssertionError("C-2: breadth price indicators require price_adjusted=True source")


def _pivot_close(ohlcv: pd.DataFrame, calendar: Optional[Sequence[date]]) -> pd.DataFrame:
    df = ohlcv[["date", "code", "close"]].copy()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df["code"] = df["code"].astype(str)
    df = df.drop_duplicates(["date", "code"], keep="last")
    close = df.pivot(index="date", columns="code", values="close").sort_index()
    if calendar is not None:
        cal = sorted({pd.Timestamp(d).date() for d in calendar})
        close = close.reindex(cal)     # 달력에 없는 날은 버리고, 달력에만 있는 날은 전 종목 결측
    close = close.astype(float)
    return close


def _flag(cond: pd.DataFrame, valid: pd.DataFrame) -> pd.DataFrame:
    """조건을 1.0/0.0 으로, 유효하지 않은 셀은 NaN 으로 (0 대체 금지)."""
    return cond.astype(float).where(valid)


@dataclass
class _StockIndicators:
    above20: pd.DataFrame
    above60: pd.DataFrame
    new_high: pd.DataFrame
    new_low: pd.DataFrame
    advance: pd.DataFrame       # 1.0 상승 / 0.0 보합·하락 / NaN 전일·당일 종가 결손
    close_valid: pd.DataFrame   # bool
    diagnostics: dict = field(default_factory=dict)


def _stock_indicators(close: pd.DataFrame) -> _StockIndicators:
    valid = close.notna()
    ma20 = close.rolling(MA_SHORT_DAYS, min_periods=MA_SHORT_DAYS).mean()
    ma60 = close.rolling(MA_LONG_DAYS, min_periods=MA_LONG_DAYS).mean()
    hi = close.rolling(HIGH_LOW_WINDOW_DAYS, min_periods=HIGH_LOW_WINDOW_DAYS).max()
    lo = close.rolling(HIGH_LOW_WINDOW_DAYS, min_periods=HIGH_LOW_WINDOW_DAYS).min()
    prev = close.shift(1)
    return _StockIndicators(
        above20=_flag(close > ma20, valid & ma20.notna()),
        above60=_flag(close > ma60, valid & ma60.notna()),
        new_high=_flag(close >= hi, valid & hi.notna()),
        new_low=_flag(close <= lo, valid & lo.notna()),
        advance=_flag(close > prev, valid & prev.notna()),
        close_valid=valid,
    )


def _snapshot_for_dates(dates: Sequence[date], asofs: Sequence[date]) -> list[Optional[date]]:
    """각 날짜에 대해 asof ≤ date 인 최근 스냅샷(없으면 None). 과거 스냅샷만 참조 → 룩어헤드 없음."""
    a = np.array(sorted(asofs), dtype="datetime64[D]")
    d = np.array(list(dates), dtype="datetime64[D]")
    idx = np.searchsorted(a, d, side="right") - 1
    return [None if i < 0 else a[i].astype(object) for i in idx]


def _mean_or_none(block: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """행별 (유효 셀 평균, 유효 셀 수). 유효 셀 0 → NaN (0 대체 금지)."""
    n = block.notna().sum(axis=1)
    m = block.mean(axis=1, skipna=True)
    return m.where(n > 0), n


def _sum_or_none(block: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    n = block.notna().sum(axis=1)
    s = block.sum(axis=1, min_count=1)
    return s.where(n > 0), n


def leadership_label(large: Optional[float], mid: Optional[float]) -> Optional[str]:
    """스펙 규칙(상수 LEADERSHIP_*): large>0.4 & mid<0.25 → large_cap_only / large>0.3 & mid>0.3 → broad / else mixed.
    large 또는 mid 결측 → None."""
    if large is None or mid is None or pd.isna(large) or pd.isna(mid):
        return None
    if large > LEADERSHIP_LARGE_ONLY["large_gt"] and mid < LEADERSHIP_LARGE_ONLY["mid_lt"]:
        return "large_cap_only"
    if large > LEADERSHIP_BROAD["large_gt"] and mid > LEADERSHIP_BROAD["mid_gt"]:
        return "broad"
    return "mixed"


def breadth_impulse(above_20d_ratio: pd.Series) -> pd.Series:
    """impulse_t = mean(r[t-4..t]) − mean(r[t-19..t-5]); 20일 중 하나라도 결측이면 None."""
    r = above_20d_ratio.astype(float)
    recent = r.rolling(IMPULSE_RECENT_DAYS, min_periods=IMPULSE_RECENT_DAYS).mean()
    prior = r.shift(IMPULSE_RECENT_DAYS).rolling(IMPULSE_PRIOR_DAYS, min_periods=IMPULSE_PRIOR_DAYS).mean()
    return recent - prior


def breadth_impulse_z(impulse: pd.Series) -> pd.Series:
    """z_t = (impulse_t − mean) / std(ddof=1), 기준 분포 = **당일 제외** 직전 120 거래일 impulse.
    유효 표본 < 60 또는 std==0 → None."""
    x = impulse.astype(float)
    hist = x.shift(1).rolling(IMPULSE_Z_WINDOW_DAYS, min_periods=IMPULSE_Z_MIN_SAMPLES)
    mu = hist.mean()
    sd = hist.std(ddof=1)
    z = (x - mu) / sd
    return z.where(sd.notna() & (sd > 0) & x.notna())


def compute_breadth_panel(
    ohlcv_adj: pd.DataFrame,
    constituents_monthly: pd.DataFrame,
    *,
    output_start: Optional[date] = OUTPUT_START,
    calendar: Optional[Sequence[date]] = None,
    engine_ver: str = ENGINE_VER,
) -> pd.DataFrame:
    """일별 breadth 패널 (GOLD_BREADTH_PANEL 컬럼).

    - ohlcv_adj: bronze 수정주가 OHLCV(전 구성종목 이력, price_adjusted=True 만).
    - constituents_monthly: build_constituents_monthly 출력 (asof, code, tier).
    - 내부 계산은 스냅샷이 존재하는 전 구간에서 수행하고(impulse·z 의 과거 표본 확보), 출력은 output_start 이후만.
      output_start=None 이면 전 구간 출력.
    - 룩어헤드 없음: 날짜 t 의 모든 값은 t 이하의 가격·t 이하 asof 스냅샷만 사용.
    """
    _validate_adjusted(ohlcv_adj)
    if constituents_monthly.empty:
        raise BreadthInputError("constituents_monthly is empty")
    cm = constituents_monthly.copy()
    cm["asof"] = pd.to_datetime(cm["asof"]).dt.date
    cm["code"] = cm["code"].astype(str)
    if "tier" not in cm.columns:
        cm["tier"] = None

    close = _pivot_close(ohlcv_adj, calendar)
    ind = _stock_indicators(close)
    dates: list[date] = list(close.index)
    asofs = sorted(cm["asof"].unique())
    snap = _snapshot_for_dates(dates, asofs)

    members_by_asof: dict[date, list[str]] = {a: sorted(g["code"].unique()) for a, g in cm.groupby("asof")}
    tier_by_asof: dict[date, dict[str, list[str]]] = {}
    for a, g in cm.groupby("asof"):
        tier_by_asof[a] = {t: sorted(g.loc[g["tier"] == t, "code"].unique()) for t in TIER_NAMES}

    idx = pd.Index(dates, name="date")
    out = pd.DataFrame(index=idx)
    out["constituents_asof"] = pd.Series(snap, index=idx, dtype="object")
    for col in ("n_available", "above_20d_ratio", "above_60d_ratio", "new_high_252", "new_low_252", "adv_ratio",
                "large_above20", "mid_above20", "small_above20"):
        out[col] = np.nan

    # 스냅샷별 구간 처리 — 그 구간의 날짜들에 그 asof 의 멤버만 적용
    snap_arr = pd.Series(snap, index=idx, dtype="object")
    for a in asofs:
        rows = snap_arr.index[snap_arr == a]
        if len(rows) == 0:
            continue
        members = [c for c in members_by_asof[a] if c in close.columns]
        # 가격 파일에 아예 없는 멤버는 전 구간 결측 → 열이 없으니 분모에서 자동 제외 (n_available 로 드러남)
        if not members:
            continue
        cv = ind.close_valid.loc[rows, members]
        out.loc[rows, "n_available"] = cv.sum(axis=1).astype(float)
        out.loc[rows, "above_20d_ratio"] = _mean_or_none(ind.above20.loc[rows, members])[0]
        out.loc[rows, "above_60d_ratio"] = _mean_or_none(ind.above60.loc[rows, members])[0]
        out.loc[rows, "new_high_252"] = _sum_or_none(ind.new_high.loc[rows, members])[0]
        out.loc[rows, "new_low_252"] = _sum_or_none(ind.new_low.loc[rows, members])[0]
        out.loc[rows, "adv_ratio"] = _mean_or_none(ind.advance.loc[rows, members])[0]
        for t, col in (("large", "large_above20"), ("mid", "mid_above20"), ("small", "small_above20")):
            tm = [c for c in tier_by_asof[a].get(t, []) if c in close.columns]
            if tm:
                out.loc[rows, col] = _mean_or_none(ind.above20.loc[rows, tm])[0]

    # 스냅샷이 없는 날(첫 asof 이전)은 전부 결측
    no_snap = out["constituents_asof"].isna()
    out.loc[no_snap, ["n_available", "above_20d_ratio", "above_60d_ratio", "new_high_252", "new_low_252",
                      "adv_ratio", "large_above20", "mid_above20", "small_above20"]] = np.nan

    out["leadership"] = [leadership_label(l, m) for l, m in zip(out["large_above20"], out["mid_above20"])]
    out["breadth_impulse"] = breadth_impulse(out["above_20d_ratio"])
    out["breadth_impulse_z"] = breadth_impulse_z(out["breadth_impulse"])
    out["engine_ver"] = engine_ver

    out = out.reset_index()
    if output_start is not None:
        out = out[out["date"] >= output_start].reset_index(drop=True)

    # dtype 정리 (결측은 pandas NA → parquet null)
    out["n_available"] = out["n_available"].round().astype("Int32")
    out["new_high_252"] = out["new_high_252"].round().astype("Int32")
    out["new_low_252"] = out["new_low_252"].round().astype("Int32")
    out["leadership"] = out["leadership"].astype("string")
    out["engine_ver"] = out["engine_ver"].astype("string")
    return out[PANEL_COLUMNS]


def panel_to_arrow(panel: pd.DataFrame) -> pa.Table:
    """NaN → null 로 저장 (from_pandas 기본). 스키마 고정."""
    return pa.Table.from_pandas(panel[PANEL_COLUMNS], schema=GOLD_BREADTH_PANEL, preserve_index=False)


# ---------------------------------------------------------------------------
# 요약 (보고용)
# ---------------------------------------------------------------------------

def summarize_panel(panel: pd.DataFrame) -> dict:
    p = panel
    none_ratio = {c: float(p[c].isna().mean()) if len(p) else None
                  for c in PANEL_COLUMNS if c not in ("date", "engine_ver")}
    lead = p["leadership"].value_counts(dropna=False)
    lead_dist = {("None" if pd.isna(k) else str(k)): int(v) for k, v in lead.items()}
    nh = p["new_high_252"].dropna()
    nl = p["new_low_252"].dropna()
    na = p["n_available"].dropna()

    def _argmax_date(s: pd.Series) -> Optional[str]:
        if s.empty:
            return None
        i = s.astype(float).idxmax()
        return str(p.loc[i, "date"])

    def _first_valid(col: str) -> Optional[str]:
        s = p[col].dropna()
        return None if s.empty else str(p.loc[s.index[0], "date"])

    return {
        "rows": int(len(p)),
        "date_range": [str(p["date"].min()), str(p["date"].max())] if len(p) else None,
        "n_snapshots": int(p["constituents_asof"].nunique(dropna=True)),
        "n_available": {"min": int(na.min()), "median": float(na.median()), "max": int(na.max())} if len(na) else None,
        "none_ratio": none_ratio,
        "first_valid": {c: _first_valid(c) for c in ("above_20d_ratio", "above_60d_ratio", "new_high_252",
                                                     "breadth_impulse", "breadth_impulse_z")},
        "leadership_dist": lead_dist,
        "new_high_252": {"max": int(nh.max()), "max_date": _argmax_date(nh), "mean": float(nh.mean())} if len(nh) else None,
        "new_low_252": {"max": int(nl.max()), "max_date": _argmax_date(nl), "mean": float(nl.mean())} if len(nl) else None,
        "above_20d_ratio": {"mean": float(p["above_20d_ratio"].mean()), "min": float(p["above_20d_ratio"].min()),
                            "max": float(p["above_20d_ratio"].max())} if p["above_20d_ratio"].notna().any() else None,
        "breadth_impulse_z": {"mean": float(p["breadth_impulse_z"].mean()), "std": float(p["breadth_impulse_z"].std()),
                              "min": float(p["breadth_impulse_z"].min()), "max": float(p["breadth_impulse_z"].max())}
        if p["breadth_impulse_z"].notna().any() else None,
        "engine_ver": str(p["engine_ver"].iloc[0]) if len(p) else None,
    }
