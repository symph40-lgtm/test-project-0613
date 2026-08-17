"""부품 5 diffusion 축 — Semiconductor diffusion (계획서 mtpro-t5-plan.md §3.3 `semi_diffusion_z` 행 · §12.4 통일 규정,
WORKORDER AM-8 정의 구분: diffusion = 반도체 종목군 **내** 확산 / Transmission(부품 10) = 미국→개별 종목, 별개 필드).

입력:
  - ohlcv_adj (bronze ohlcv_adj_constituents, price_adjusted=True 만 — C-2)
  - semi_group_monthly (silver, ingest.semi_group: asof·code — 월초 asof 동결 PIT 목록. 목록은 config 가 아니라 데이터로 관리)
  - market_above20 (gold breadth_panel.above_20d_ratio 재사용 — breadth.compute_breadth_panel 산출값, 시장 = KOSPI200 PIT 구성)

산식(사전 등록):
  - semi_above20_t   = mean_{i ∈ semi(asof ≤ t)} above_20d_i,t   (breadth._stock_indicators 의 above20 재사용, 유효 종목만; n_semi 기록, 0 → None)
  - diffusion_spread = semi_above20 − market_above20
  - semi_diffusion_z = z( spread_t − spread_{t−5} ; 기준 = t−1 까지 직전 120 거래일의 5일 변화, 표본<60 → None, std==0 → None )
    (클립 ±3 은 family 결합 단계(§3.5)에서 — 이 모듈은 원 z 를 그대로 기록. breadth_impulse_z 와 동일한 관례)
  - 진단 leader_gap  = mean(above20 of 005930·000660) − mean(above20 of semi 중 리더 제외)   (어느 쪽이든 유효 0 → None)
  - 진단 semi_impulse = breadth.breadth_impulse(semi_above20)  (부품 5 impulse 정의 동일: mean 최근 5 − mean 이전 15)
  - 결측 None (0 대체 금지). 룩어헤드 없음: 날짜 t 는 t 이하 가격·asof ≤ t 목록만.
"""
from __future__ import annotations

from datetime import date
from typing import Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa

from mtpro.components import breadth as B

ENGINE_VER = "semi_diffusion-0.1"

# ---- 사전 등록 상수 (config semi_diffusion.constants 와 일치 테스트) ------------------
SPREAD_CHANGE_DAYS = 5          # diffusion_spread 의 5일 변화
Z_WINDOW_DAYS = 120             # z 기준 분포 = t−1 까지 직전 120 거래일 (당일 제외, §12.4)
Z_MIN_SAMPLES = 60              # 표본 < 60 → None
LEADERS: tuple[str, ...] = ("005930", "000660")
OUTPUT_START = B.OUTPUT_START   # 2023-01-03 (breadth 와 동일)

GOLD_SEMI_DIFFUSION_PANEL = pa.schema([
    ("date", pa.date32()),
    ("semi_asof", pa.date32()),
    ("n_semi", pa.int32()),             # 그날 반도체 종목군 중 above_20d 유효 종목 수
    ("semi_above20", pa.float64()),
    ("market_above20", pa.float64()),
    ("diffusion_spread", pa.float64()),
    ("semi_diffusion_z", pa.float64()),
    ("leader_gap", pa.float64()),
    ("semi_impulse", pa.float64()),
    ("engine_ver", pa.string()),
])
PANEL_COLUMNS = GOLD_SEMI_DIFFUSION_PANEL.names


class SemiDiffusionInputError(ValueError):
    """loud-failure: 입력 결손·스키마 위반은 조용히 넘어가지 않는다."""


def z_past_only(x: pd.Series, window: int = Z_WINDOW_DAYS, min_samples: int = Z_MIN_SAMPLES) -> pd.Series:
    """z_t = (x_t − mean) / std(ddof=1), 기준 = **당일 제외** 직전 `window` 거래일의 x. 유효 표본 < min_samples 또는 std==0 → None."""
    s = x.astype(float)
    hist = s.shift(1).rolling(window, min_periods=min_samples)
    mu, sd = hist.mean(), hist.std(ddof=1)
    z = (s - mu) / sd
    return z.where(sd.notna() & (sd > 0) & s.notna())


def spread_change(spread: pd.Series, days: int = SPREAD_CHANGE_DAYS) -> pd.Series:
    """spread_t − spread_{t−days}; 어느 쪽이든 결측이면 None."""
    s = spread.astype(float)
    return s - s.shift(days)


def compute_semi_diffusion_panel(
    ohlcv_adj: pd.DataFrame,
    semi_group_monthly: pd.DataFrame,
    market_above20: pd.Series,
    *,
    leaders: Sequence[str] = LEADERS,
    output_start: Optional[date] = OUTPUT_START,
    calendar: Optional[Sequence[date]] = None,
    engine_ver: str = ENGINE_VER,
) -> pd.DataFrame:
    """일별 semi diffusion 패널 (GOLD_SEMI_DIFFUSION_PANEL 컬럼).

    - ohlcv_adj: 반도체 종목군 + 리더 종목의 수정주가 이력 포함(전 구성종목 파일 그대로 넣어도 됨), price_adjusted=True 만.
    - semi_group_monthly: (asof, code) — asof ≤ t 인 최근 스냅샷이 t 의 종목군.
    - market_above20: index=date, breadth_panel.above_20d_ratio (KOSPI200 above_20d 비율). 날짜 미포함 → None.
    - 내부 계산은 전 구간, 출력은 output_start 이후(None 이면 전 구간).
    """
    B._validate_adjusted(ohlcv_adj)
    if semi_group_monthly is None or semi_group_monthly.empty:
        raise SemiDiffusionInputError("semi_group_monthly is empty")
    sg = semi_group_monthly.copy()
    sg["asof"] = pd.to_datetime(sg["asof"]).dt.date
    sg["code"] = sg["code"].astype(str)
    # survivorship_bias 열이 True 인 목록도 계산은 허용 — 보고 의무는 job(summary.survivorship_bias)에 있다.

    close = B._pivot_close(ohlcv_adj, calendar)
    ind = B._stock_indicators(close)
    above20 = ind.above20
    dates: list[date] = list(close.index)
    asofs = sorted(sg["asof"].unique())
    snap = B._snapshot_for_dates(dates, asofs)
    members_by_asof = {a: sorted(g["code"].unique()) for a, g in sg.groupby("asof")}
    leaders = [str(c) for c in leaders]

    idx = pd.Index(dates, name="date")
    out = pd.DataFrame(index=idx)
    out["semi_asof"] = pd.Series(snap, index=idx, dtype="object")
    for col in ("n_semi", "semi_above20", "leader_gap"):
        out[col] = np.nan

    snap_arr = out["semi_asof"]
    for a in asofs:
        rows = snap_arr.index[snap_arr == a]
        if len(rows) == 0:
            continue
        members = [c for c in members_by_asof[a] if c in above20.columns]
        if members:
            blk = above20.loc[rows, members]
            m, n = B._mean_or_none(blk)
            out.loc[rows, "semi_above20"] = m
            out.loc[rows, "n_semi"] = n.astype(float)
        else:
            out.loc[rows, "n_semi"] = 0.0
        lead_cols = [c for c in leaders if c in above20.columns]
        rest_cols = [c for c in members if c not in leaders]
        if lead_cols and rest_cols:
            lm, _ = B._mean_or_none(above20.loc[rows, lead_cols])
            rm, _ = B._mean_or_none(above20.loc[rows, rest_cols])
            out.loc[rows, "leader_gap"] = lm - rm      # 어느 쪽 NaN 이면 NaN

    no_snap = out["semi_asof"].isna()
    out.loc[no_snap, ["n_semi", "semi_above20", "leader_gap"]] = np.nan

    mk = pd.Series(market_above20).copy()
    mk.index = [pd.Timestamp(d).date() for d in mk.index]
    mk = mk[~mk.index.duplicated(keep="last")].astype(float)
    out["market_above20"] = mk.reindex(idx).values
    out["diffusion_spread"] = out["semi_above20"] - out["market_above20"]
    out["semi_diffusion_z"] = z_past_only(spread_change(out["diffusion_spread"]))
    out["semi_impulse"] = B.breadth_impulse(out["semi_above20"])
    out["engine_ver"] = engine_ver

    out = out.reset_index()
    if output_start is not None:
        out = out[out["date"] >= output_start].reset_index(drop=True)
    out["n_semi"] = out["n_semi"].round().astype("Int32")
    out["engine_ver"] = out["engine_ver"].astype("string")
    return out[PANEL_COLUMNS]


def panel_to_arrow(panel: pd.DataFrame) -> pa.Table:
    return pa.Table.from_pandas(panel[PANEL_COLUMNS], schema=GOLD_SEMI_DIFFUSION_PANEL, preserve_index=False)


def summarize_panel(panel: pd.DataFrame) -> dict:
    p = panel
    none_ratio = {c: float(p[c].isna().mean()) if len(p) else None for c in PANEL_COLUMNS if c not in ("date", "engine_ver")}

    def _first_valid(col: str) -> Optional[str]:
        s = p[col].dropna()
        return None if s.empty else str(p.loc[s.index[0], "date"])

    def _stats(col: str) -> Optional[dict]:
        s = p[col].dropna().astype(float)
        if s.empty:
            return None
        return {"mean": float(s.mean()), "std": float(s.std()), "min": float(s.min()),
                "p05": float(s.quantile(0.05)), "p50": float(s.quantile(0.5)), "p95": float(s.quantile(0.95)),
                "max": float(s.max()), "n": int(len(s))}

    ns = p["n_semi"].dropna()
    n_semi_by_asof = {str(a): int(g["n_semi"].dropna().max()) if g["n_semi"].notna().any() else None
                      for a, g in p.groupby("semi_asof")}
    return {
        "rows": int(len(p)),
        "date_range": [str(p["date"].min()), str(p["date"].max())] if len(p) else None,
        "n_snapshots": int(p["semi_asof"].nunique(dropna=True)),
        "n_semi": {"min": int(ns.min()), "median": float(ns.median()), "max": int(ns.max())} if len(ns) else None,
        "n_semi_by_asof": n_semi_by_asof,
        "none_ratio": none_ratio,
        "first_valid": {c: _first_valid(c) for c in ("semi_above20", "diffusion_spread", "semi_diffusion_z", "leader_gap", "semi_impulse")},
        "semi_above20": _stats("semi_above20"),
        "diffusion_spread": _stats("diffusion_spread"),
        "semi_diffusion_z": _stats("semi_diffusion_z"),
        "leader_gap": _stats("leader_gap"),
        "semi_impulse": _stats("semi_impulse"),
        "z_abs_gt3_ratio": float((p["semi_diffusion_z"].abs() > 3).mean()) if p["semi_diffusion_z"].notna().any() else None,
        "engine_ver": str(p["engine_ver"].iloc[0]) if len(p) else None,
    }
