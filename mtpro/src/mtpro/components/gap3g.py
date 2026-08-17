"""부품 3G — Gap Reaction / Gap Hold / Close Acceptance (T5-2, 계획서 §1 A-1R·§3.1·§3.2·§7).

시간축 **A-1R**(AM-6): 장 마감 후 상태 산출에 당일 실현 갭을 "최초 반응"으로 사용한다. 사전 예측 입력(부품 8·T2/R1/R2 접점)에는
갭 사용 금지 유지 — 이 패널의 행 가용 시점(available_at)은 **t 마감 이후**다.
**주의**: 이것은 A-1R 계열이다. 소급 Gate R1 의 gradec_panel(open→close, A-1)은 건드리지 않는다(결과 소급 변경 없음).

스코프 3(005930·000660·KOSPI200, bronze ohlcv_adj price_adjusted=True) 일별:
    gap_pct          = (open_t / close_{t−1} − 1)·100
    gap_hold         = (close_t − close_{t−1}) / (open_t − close_{t−1})   (|gap_pct| < 0.3% → None, 클립 [−1, 2])
                        1 = 갭 그대로 유지, >1 확장, <0 반전
    gap_hold_signed  = gap_hold × sign(gap_pct)                        (양의 갭 유지·음의 갭 되돌림 = +)  → gap_hold_z
    close_acceptance = (close_t − low_t)/(high_t − low_t)              (CLV ∈ [0,1], high=low → None)   → close_acceptance_z
    Gap Reaction ERR (등급C 재료 = 전일밤 ^SOX, 정렬 = gradec.align_prev_us_session 재사용: 세션 d ≤ t−1 엄격, reused → None):
        β_gap        = 과거 60 국내 거래일(t 미포함) 롤링 OLS(절편 포함) 기울기, gap_pct ~ sox_ret_prev, 표본<40 None, 클립 [0.3, 3.0]
        expected_gap = β_gap × sox_ret_prev ; |expected_gap| < 0.3% → 재료 없는 날(no_material_flag) → ERR None
        σ_gap        = 과거 120 국내 거래일(t−1까지) 재료일 잔차의 rolling std (core.errata.expected_std_rolling 재사용, floor 0.1%,
                       표본<60 None — §12.4 통일 규정)
        gap_reaction_err   = gap_pct − expected_gap ;  gap_reaction_err_z = err / σ_gap  (클립 없음 — 캘리브레이션 검사용 원값,
                             family 결합 시 §12.2-1 이 ±3 클립)
        expected_gap_source ∈ {gradeC, gradeA} — 등급A 값은 T5-6(Expected Reaction)이 채우는 인터페이스. 여기서는 gradeC 만.
    z = 스코프별 과거 전용 120 국내 거래일(t−1까지, 당일 제외), 유효 표본<60 None, 클립 ±3 (§3 공통·§12.4).

결측은 None (0 대체 금지). C-3: t0_mode 값은 A1_open 그대로(계획서 §7 — 3G는 갭을 "반응"으로 기록하되 t0_mode 불변).
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.components.gradec import align_prev_us_session, ols_slope
from mtpro.components.rolling import clip, is_finite, past_window, past_z
from mtpro.core.errata import err_z_std_check, expected_std_rolling
from mtpro.schema import assert_t0_mode

ENGINE_VER = "gap3g-0.1"
EVENT_TYPE = "GAP3G_SOX"
GRADE = "C"
T0_MODE = "A1_open"
TIME_AXIS = "A-1R"
SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")
EXPECTED_GAP_SOURCES: tuple[str, ...] = ("gradeC", "gradeA")

GOLD_GAP3G_PANEL_PATH = settings.GOLD / "gap3g_panel.parquet"
OHLCV_ADJ_PATH = settings.BRONZE / "ohlcv_adj.parquet"

GOLD_GAP3G_PANEL = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),
    ("prev_close", pa.float64()), ("open", pa.float64()), ("high", pa.float64()), ("low", pa.float64()), ("close", pa.float64()),
    ("gap_pct", pa.float64()),
    ("close_ret_pct", pa.float64()),          # close→close % (A-1R 반응, 참고)
    ("gap_hold", pa.float64()),               # |gap|<0.3% None, 클립 [−1,2]
    ("gap_hold_signed", pa.float64()),        # gap_hold × sign(gap)
    ("gap_hold_z", pa.float64()),
    ("close_acceptance", pa.float64()),       # CLV
    ("close_acceptance_z", pa.float64()),
    ("sox_session_date", pa.date32()), ("sox_align_status", pa.string()), ("sox_ret_prev", pa.float64()),
    ("beta_gap_raw", pa.float64()), ("beta_gap", pa.float64()),
    ("expected_gap", pa.float64()),
    ("expected_gap_source", pa.string()),     # gradeC | gradeA(T5-6) | None
    ("no_material_flag", pa.bool_()),         # |expected_gap| < 0.3% → True (ERR 제외). expected_gap None 이면 None
    ("sigma_gap", pa.float64()),
    ("gap_reaction_err", pa.float64()),
    ("gap_reaction_err_z", pa.float64()),
    ("grade", pa.string()), ("t0_mode", pa.string()), ("time_axis", pa.string()),
    ("price_adjusted", pa.bool_()), ("engine_ver", pa.string()),
])


@dataclass(frozen=True)
class Gap3GParams:
    """사전 등록 상수 (config/mtpro.yaml gap3g.constants 와 일치 테스트)."""

    min_gap_abs_pct: float = 0.3              # |gap| < 0.3% → gap_hold None (§1)
    gap_hold_clip: tuple[float, float] = (-1.0, 2.0)
    z_window_days: int = 120                  # §12.4: t−1까지 120 국내 거래일
    z_min_samples: int = 60
    z_clip_abs: float = 3.0                   # §3 공통 클립 ±3
    beta_gap_window_days: int = 60            # 등급C β 재추정(갭 기준) — grade_c 와 동일 상수
    beta_gap_min_samples: int = 40
    beta_gap_clip: tuple[float, float] = (0.3, 3.0)
    min_expected_gap_abs_pct: float = 0.3     # |expected_gap| < 0.3% → 재료 없는 날 → ERR None
    sigma_gap_window_days: int = 120          # 잔차 rolling std 창(t−1까지)
    sigma_gap_min_samples: int = 60           # §12.4 통일 규정(z 창 표본 규칙 적용 — 해석 기록)
    sigma_gap_floor: float = 0.1              # A-1 유일 상수 (%)
    max_stale_calendar_days: int = 7          # 세션 정렬 stale (grade_c 동일)


def load_params(config_path: Optional[Path] = None, **overrides) -> Gap3GParams:
    p = config_path or (settings.CONFIG_DIR / "mtpro.yaml")
    cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
    c = (cfg.get("gap3g", {}) or {}).get("constants", {}) or {}
    base = Gap3GParams()
    kw = {}
    for f in ("min_gap_abs_pct", "z_window_days", "z_min_samples", "z_clip_abs", "beta_gap_window_days", "beta_gap_min_samples",
              "min_expected_gap_abs_pct", "sigma_gap_window_days", "sigma_gap_min_samples", "sigma_gap_floor", "max_stale_calendar_days"):
        if f in c:
            kw[f] = type(getattr(base, f))(c[f])
    for f in ("gap_hold_clip", "beta_gap_clip"):
        if f in c:
            kw[f] = (float(c[f][0]), float(c[f][1]))
    kw.update(overrides)
    return replace(base, **kw) if kw else base


# ---------------------------------------------------------------------------
# OHLCV → 일별 원시 3G
# ---------------------------------------------------------------------------

def scope_ohlcv(ohlcv: pd.DataFrame, code: str) -> pd.DataFrame:
    """bronze OHLCV(price_adjusted=True 필수 — C-2)에서 scope 하나의 정렬된 [date, open, high, low, close, prev_close]."""
    d = ohlcv[ohlcv["code"].astype(str) == str(code)].copy()
    if d.empty:
        raise ValueError(f"no OHLCV rows for code {code!r}")
    if "price_adjusted" in d.columns and not bool(d["price_adjusted"].astype(bool).all()):
        raise AssertionError(f"C-2 violation: {code} OHLCV must be price_adjusted=True for gap/return calculation")
    d["date"] = pd.to_datetime(d["date"]).dt.normalize()
    d = d.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    out = pd.DataFrame({"date": d["date"]})
    for c in ("open", "high", "low", "close"):
        out[c] = pd.to_numeric(d[c], errors="coerce").astype(float)
    out["prev_close"] = out["close"].shift(1)
    return out


def _gap_hold(prev_close: float, opn: float, close: float, params: Gap3GParams) -> tuple[Optional[float], Optional[float]]:
    """(gap_pct, gap_hold). gap_hold: |gap|<min → None; 클립."""
    if not (is_finite(prev_close) and is_finite(opn) and is_finite(close)) or prev_close <= 0:
        return None, None
    gap_pct = (opn / prev_close - 1.0) * 100.0
    if abs(gap_pct) < params.min_gap_abs_pct:
        return gap_pct, None
    hold = (close - prev_close) / (opn - prev_close)
    return gap_pct, clip(hold, *params.gap_hold_clip)


def _clv(high: float, low: float, close: float) -> Optional[float]:
    if not (is_finite(high) and is_finite(low) and is_finite(close)):
        return None
    rng = high - low
    if rng <= 0:
        return None
    return float((close - low) / rng)


# ---------------------------------------------------------------------------
# 패널
# ---------------------------------------------------------------------------

def build_scope_panel(scope: str, px: pd.DataFrame, aligned: pd.DataFrame, params: Gap3GParams) -> pd.DataFrame:
    """scope 하나. px = scope_ohlcv 출력, aligned = align_prev_us_session 출력(같은 날짜열)."""
    assert_t0_mode(T0_MODE, scope)
    a = aligned.copy()
    a["date"] = pd.to_datetime(a["date"]).dt.normalize()
    df = px.merge(a, on="date", how="left").sort_values("date").reset_index(drop=True)
    n = len(df)

    prev_close = df["prev_close"].tolist()
    opn = df["open"].tolist()
    high = df["high"].tolist()
    low = df["low"].tolist()
    close = df["close"].tolist()
    sox = [v if is_finite(v) else None for v in df["sox_ret_prev"].tolist()]

    gap: list[Optional[float]] = [None] * n
    hold: list[Optional[float]] = [None] * n
    hold_s: list[Optional[float]] = [None] * n
    clv: list[Optional[float]] = [None] * n
    cret: list[Optional[float]] = [None] * n
    for i in range(n):
        g, h = _gap_hold(prev_close[i], opn[i], close[i], params)
        gap[i], hold[i] = g, h
        if h is not None and g is not None and g != 0:
            hold_s[i] = h * (1.0 if g > 0 else -1.0)
        clv[i] = _clv(high[i], low[i], close[i])
        if is_finite(prev_close[i]) and prev_close[i] > 0 and is_finite(close[i]):
            cret[i] = (close[i] / prev_close[i] - 1.0) * 100.0

    hold_z = [past_z(hold_s, i, params.z_window_days, params.z_min_samples, params.z_clip_abs) for i in range(n)]
    clv_z = [past_z(clv, i, params.z_window_days, params.z_min_samples, params.z_clip_abs) for i in range(n)]

    beta_raw: list[Optional[float]] = [None] * n
    beta: list[Optional[float]] = [None] * n
    exp_gap: list[Optional[float]] = [None] * n
    exp_src: list[Optional[str]] = [None] * n
    nomat: list[Optional[bool]] = [None] * n
    sigma: list[Optional[float]] = [None] * n
    err: list[Optional[float]] = [None] * n
    errz: list[Optional[float]] = [None] * n
    lo_b, hi_b = params.beta_gap_clip
    for i in range(n):
        # β_gap: 과거 window 행(t 미포함) 중 gap·sox 모두 있는 표본
        j0 = max(0, i - params.beta_gap_window_days)
        ks = [k for k in range(j0, i) if sox[k] is not None and gap[k] is not None]
        if len(ks) >= params.beta_gap_min_samples:
            b = ols_slope([sox[k] for k in ks], [gap[k] for k in ks])
            beta_raw[i] = b
            beta[i] = clip(b, lo_b, hi_b)
        if beta[i] is not None and sox[i] is not None:
            exp_gap[i] = beta[i] * sox[i]
            exp_src[i] = "gradeC"
            nomat[i] = abs(exp_gap[i]) < params.min_expected_gap_abs_pct
        material = exp_gap[i] is not None and nomat[i] is False
        # σ_gap: 과거 120 거래일(t−1까지) 재료일 잔차 — A-1 expected_std_rolling 재사용 (창 안 잔차 전부 = window)
        past_res = past_window(err, i, params.sigma_gap_window_days)
        sigma[i] = expected_std_rolling({EVENT_TYPE: past_res}, EVENT_TYPE, window=params.sigma_gap_window_days,
                                        floor=params.sigma_gap_floor, min_samples=params.sigma_gap_min_samples)
        if material and gap[i] is not None:
            err[i] = gap[i] - exp_gap[i]
            if sigma[i] is not None:
                errz[i] = err[i] / sigma[i]

    return pd.DataFrame({
        "date": df["date"].dt.date, "scope": scope,
        "prev_close": [v if is_finite(v) else None for v in prev_close],
        "open": opn, "high": high, "low": low, "close": close,
        "gap_pct": gap, "close_ret_pct": cret,
        "gap_hold": hold, "gap_hold_signed": hold_s, "gap_hold_z": hold_z,
        "close_acceptance": clv, "close_acceptance_z": clv_z,
        "sox_session_date": df["sox_session_date"].tolist(), "sox_align_status": df["sox_align_status"].tolist(), "sox_ret_prev": sox,
        "beta_gap_raw": beta_raw, "beta_gap": beta, "expected_gap": exp_gap, "expected_gap_source": exp_src,
        "no_material_flag": nomat, "sigma_gap": sigma, "gap_reaction_err": err, "gap_reaction_err_z": errz,
        "grade": GRADE, "t0_mode": T0_MODE, "time_axis": TIME_AXIS, "price_adjusted": True, "engine_ver": ENGINE_VER,
    })


def build_panel(ohlcv: pd.DataFrame, sox: pd.DataFrame, params: Optional[Gap3GParams] = None, scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    """전 scope 패널. scope 별 국내 거래일 = 그 scope 의 OHLCV 날짜. sox = bronze sox_daily(date, ret_pct)."""
    params = params or Gap3GParams()
    parts = []
    for sc in scopes:
        px = scope_ohlcv(ohlcv, sc)
        al = align_prev_us_session([d.date() for d in px["date"]], sox, params.max_stale_calendar_days)
        parts.append(build_scope_panel(sc, px, al, params))
    return pd.concat(parts, ignore_index=True)


def write_gold(panel: pd.DataFrame, path: Path = GOLD_GAP3G_PANEL_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pandas(panel[[f.name for f in GOLD_GAP3G_PANEL]], schema=GOLD_GAP3G_PANEL, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def read_gold(path: Path = GOLD_GAP3G_PANEL_PATH) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


# ---------------------------------------------------------------------------
# 요약
# ---------------------------------------------------------------------------

def _q(s: pd.Series) -> Optional[dict]:
    s = pd.to_numeric(s, errors="coerce").dropna()
    if s.empty:
        return None
    return {"n": int(s.size), "mean": float(s.mean()), "std": float(s.std(ddof=1)) if s.size > 1 else None,
            "p05": float(s.quantile(0.05)), "p25": float(s.quantile(0.25)), "p50": float(s.quantile(0.5)),
            "p75": float(s.quantile(0.75)), "p95": float(s.quantile(0.95)), "min": float(s.min()), "max": float(s.max())}


def summarize(panel: pd.DataFrame, params: Optional[Gap3GParams] = None) -> dict:
    params = params or Gap3GParams()
    out: dict = {}
    none_cols = ("gap_pct", "gap_hold", "gap_hold_signed", "gap_hold_z", "close_acceptance", "close_acceptance_z", "sox_ret_prev",
                 "beta_gap", "expected_gap", "sigma_gap", "gap_reaction_err", "gap_reaction_err_z")
    for sc, g in panel.groupby("scope", sort=False):
        g = g.copy()
        for c in none_cols + ("beta_gap_raw",):
            g[c] = pd.to_numeric(g[c], errors="coerce")
        n = len(g)
        gap = g["gap_pct"]
        ez = g["gap_reaction_err_z"].dropna()
        nm = g["no_material_flag"]
        braw = g["beta_gap_raw"].dropna()
        out[sc] = {
            "rows": int(n), "date_range": [str(g["date"].min()), str(g["date"].max())],
            "align_status": {k: int(v) for k, v in g["sox_align_status"].value_counts().items()},
            "none_ratio": {c: float(g[c].isna().mean()) for c in none_cols},
            "abs_gap_ge_min_ratio": float((gap.abs() >= params.min_gap_abs_pct).mean()) if n else None,
            "gap_pct": _q(gap),
            "gap_hold": _q(g["gap_hold"]),
            "gap_hold_share": {
                "reversed_lt0": float((g["gap_hold"] < 0).sum() / g["gap_hold"].notna().sum()) if g["gap_hold"].notna().sum() else None,
                "held_ge1": float((g["gap_hold"] >= 1).sum() / g["gap_hold"].notna().sum()) if g["gap_hold"].notna().sum() else None,
                "clipped": float(((g["gap_hold"] <= params.gap_hold_clip[0]) | (g["gap_hold"] >= params.gap_hold_clip[1])).sum()
                                 / g["gap_hold"].notna().sum()) if g["gap_hold"].notna().sum() else None,
            },
            "gap_hold_signed": _q(g["gap_hold_signed"]),
            "gap_hold_z": _q(g["gap_hold_z"]),
            "close_acceptance": _q(g["close_acceptance"]),
            "close_acceptance_z": _q(g["close_acceptance_z"]),
            "beta_gap_raw": _q(braw),
            "beta_gap_clipped_share": (float(((braw < params.beta_gap_clip[0]) | (braw > params.beta_gap_clip[1])).mean()) if braw.size else None),
            "expected_gap_defined": int(g["expected_gap"].notna().sum()),
            "no_material_days": int((nm == True).sum()),  # noqa: E712
            "no_material_ratio_of_defined": (float((nm == True).sum()) / float(g["expected_gap"].notna().sum())) if g["expected_gap"].notna().sum() else None,  # noqa: E712
            "err_z_defined": int(ez.size),
            "err_z": _q(ez),
            "abs_err_z_lt5_ratio": float((ez.abs() < 5).mean()) if ez.size else None,
            "err_z_std_in_[0.7,1.3]": err_z_std_check(ez.tolist()),
            "expected_gap_source": {k: int(v) for k, v in g["expected_gap_source"].value_counts(dropna=False).items()},
        }
    return out
