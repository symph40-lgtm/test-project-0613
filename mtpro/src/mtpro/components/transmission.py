"""부품 10 Semi Transmission (T5-2, 계획서 §3.4 + §12.3 **방법 A** = 섹터 기준선 + 잔차 충격 다변량 OLS).

재료: 미국 4자산 j ∈ {SOXX, NVDA, MU, TSM} 일봉(bronze us_daily, yfinance auto_adjust). 정렬 = 등급C와 동일
(gradec.align_prev_us_session 재사용: 세션 d ≤ t−1 엄격, 미국 휴장 재사용 → None, stale/missing → None) — 자산별로 각각 정렬.

    z_j(t)      = 자산 j 야간 수익률(정렬값)의 z — 과거 120 국내 거래일(t−1까지), 표본<60 None, 클립 ±3 (§3 공통·§12.4)
    1단계 직교화: j ∈ {NVDA, MU, TSM}: resid_j(t) = z_j(t) − b_j·z_SOXX(t),
                  b_j = 과거 120 국내 거래일(t−1까지) OLS(절편 포함) 기울기, 표본<60 None
    2단계(종목별 독립, close→close A-1R): r_i ~ β_SOXX·z_SOXX + β_NVDA·resid_NVDA + β_MU·resid_MU + β_TSM·resid_TSM  (+절편)
                  **하나의 다변량 OLS**, 60 국내 거래일 창([t−59, t], 완전 관측만), 표본<40 None.
                  raw 4변수(z_SOXX·z_NVDA·z_MU·z_TSM) 동시 투입 금지 — 설계행렬은 [SOXX, resid×3] (테스트로 고정).
    비대칭:      같은 60일 창에서 z_SOXX>0 인 날만(표본≥25) / z_SOXX<0 인 날만(표본≥25) 각각 같은 다변량 OLS 의 SOXX 계수
                  = β_up / β_down → transmission_asym = β_up − β_down → z(120일 t−1까지, 표본<60 None, 클립 ±3)
    change20:    Δβ(t) = β(t) − β(t−20 행) → 자기 과거 120 행(t−1까지) Δβ 분포의 z(표본<60 None, 클립 ±3) — 각 β 마다

종목 i ∈ {005930, 000660} = Reaction family 입력(role=component). KOSPI200 은 지수 수익률로 동일 산출(role=diagnostic).
가중 합성안(.4/.2/.2/.2)은 challenger TR-B(미구현·shadow). 결측 None(0 대체 금지). 행 가용 시점 = t 마감 이후.
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
from mtpro.components.gradec import align_prev_us_session, ols_slope, reactions_from_ohlcv
from mtpro.components.rolling import is_finite, past_z
from mtpro.ingest.us_daily import asset_frame

ENGINE_VER = "transmission-0.1"
METHOD = "A"                                   # §12.3 champion: SOXX 기준선 + 잔차 충격 다변량 OLS
TIME_AXIS = "A-1R"
REACTION_BASIS = "close_to_close"
BASE_ASSET = "SOXX"
RESID_ASSETS: tuple[str, ...] = ("NVDA", "MU", "TSM")
ASSETS: tuple[str, ...] = (BASE_ASSET,) + RESID_ASSETS
DESIGN_COLUMNS: tuple[str, ...] = ("z_soxx", "resid_nvda", "resid_mu", "resid_tsm")   # 회귀 설계행렬(절편 제외) — 고정
SCOPES_COMPONENT: tuple[str, ...] = ("005930", "000660")
SCOPES_DIAGNOSTIC: tuple[str, ...] = ("KOSPI200",)
SCOPES: tuple[str, ...] = SCOPES_COMPONENT + SCOPES_DIAGNOSTIC

GOLD_TRANSMISSION_PANEL_PATH = settings.GOLD / "transmission_panel.parquet"

GOLD_TRANSMISSION_PANEL = pa.schema(
    [("date", pa.date32()), ("scope", pa.string()), ("role", pa.string())]
    + [(f"session_date_{a.lower()}", pa.date32()) for a in ASSETS]
    + [(f"align_status_{a.lower()}", pa.string()) for a in ASSETS]
    + [(f"x_{a.lower()}", pa.float64()) for a in ASSETS]           # 정렬된 야간 수익률(%)
    + [(f"z_{a.lower()}", pa.float64()) for a in ASSETS]
    + [(f"b_{a.lower()}", pa.float64()) for a in RESID_ASSETS]     # 직교화 기울기
    + [(f"resid_{a.lower()}", pa.float64()) for a in RESID_ASSETS]
    + [("r_close", pa.float64()), ("beta_n", pa.int32()),
       ("beta_soxx", pa.float64())]
    + [(f"beta_resid_{a.lower()}", pa.float64()) for a in RESID_ASSETS]
    + [(f"beta_change20_z_{a.lower()}", pa.float64()) for a in ASSETS]
    + [("n_up", pa.int32()), ("n_down", pa.int32()), ("beta_up", pa.float64()), ("beta_down", pa.float64()),
       ("transmission_asym", pa.float64()), ("transmission_asym_z", pa.float64()),
       ("reaction_basis", pa.string()), ("time_axis", pa.string()), ("method", pa.string()), ("engine_ver", pa.string())]
)


@dataclass(frozen=True)
class TransmissionParams:
    """사전 등록 상수 (config/mtpro.yaml transmission.constants 와 일치 테스트)."""

    z_window_days: int = 120                  # z_j 창 (t−1까지)
    z_min_samples: int = 60
    z_clip_abs: float = 3.0
    orth_window_days: int = 120               # 1단계 b_j OLS 창 (t−1까지)
    orth_min_samples: int = 60
    beta_window_days: int = 60                # 2단계 다변량 OLS 창 [t−59, t]
    beta_min_samples: int = 40
    asym_min_samples: int = 25                # β_up/β_down 각 표본 하한
    change_days: int = 20                     # β(t) − β(t−20)
    change_z_window_days: int = 120           # Δβ 분포 z 창 (t−1까지)
    change_z_min_samples: int = 60
    max_stale_calendar_days: int = 7          # 세션 정렬 stale (grade_c 동일)


def load_params(config_path: Optional[Path] = None, **overrides) -> TransmissionParams:
    p = config_path or (settings.CONFIG_DIR / "mtpro.yaml")
    cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
    c = (cfg.get("transmission", {}) or {}).get("constants", {}) or {}
    base = TransmissionParams()
    kw = {f: type(getattr(base, f))(c[f]) for f in base.__dataclass_fields__ if f in c}
    kw.update(overrides)
    return replace(base, **kw) if kw else base


# ---------------------------------------------------------------------------
# 정렬·순수 계산기
# ---------------------------------------------------------------------------

def align_assets(domestic_dates: Sequence, us: pd.DataFrame, max_stale_calendar_days: int = 7, assets: Sequence[str] = ASSETS) -> pd.DataFrame:
    """국내 거래일 t → 자산별 직전 미국 세션(d ≤ t−1 엄격) 수익률. 등급C 정렬기를 자산마다 재사용.
    Returns DataFrame[date, session_date_j, align_status_j, x_j ...]."""
    out: Optional[pd.DataFrame] = None
    for a in assets:
        al = align_prev_us_session(domestic_dates, asset_frame(us, a), max_stale_calendar_days)
        k = a.lower()
        al = al.rename(columns={"sox_session_date": f"session_date_{k}", "sox_align_status": f"align_status_{k}", "sox_ret_prev": f"x_{k}"})
        out = al if out is None else out.merge(al, on="date", how="left")
    assert out is not None
    return out


def ols_multi(X: np.ndarray, y: np.ndarray) -> Optional[np.ndarray]:
    """절편 포함 다변량 OLS 계수(절편 제외 벡터). 표본 ≤ 파라미터 수·특이 → None."""
    if X.ndim != 2 or X.shape[0] != y.shape[0] or X.shape[0] <= X.shape[1] + 1:
        return None
    A = np.column_stack([np.ones(X.shape[0]), X])
    if np.linalg.matrix_rank(A) < A.shape[1]:
        return None
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    if not np.all(np.isfinite(coef)):
        return None
    return coef[1:]


def _opt(v) -> Optional[float]:
    return float(v) if is_finite(v) else None


# ---------------------------------------------------------------------------
# 패널
# ---------------------------------------------------------------------------

def build_scope_panel(scope: str, reactions: pd.DataFrame, aligned: pd.DataFrame, params: TransmissionParams, role: Optional[str] = None) -> pd.DataFrame:
    """scope 하나. reactions = [date, actual_ret](close→close %), aligned = align_assets 출력."""
    role = role or ("component" if scope in SCOPES_COMPONENT else "diagnostic")
    r = reactions.copy()
    r["date"] = pd.to_datetime(r["date"]).dt.normalize()
    a = aligned.copy()
    a["date"] = pd.to_datetime(a["date"]).dt.normalize()
    df = r.merge(a, on="date", how="left").sort_values("date").reset_index(drop=True)
    n = len(df)
    keys = [x.lower() for x in ASSETS]
    base = BASE_ASSET.lower()
    rk = [x.lower() for x in RESID_ASSETS]

    x = {k: [_opt(v) for v in df[f"x_{k}"].tolist()] for k in keys}
    z = {k: [past_z(x[k], i, params.z_window_days, params.z_min_samples, params.z_clip_abs) for i in range(n)] for k in keys}
    y = [_opt(v) for v in df["actual_ret"].tolist()]

    # 1단계 직교화 (t−1까지 120행 OLS 기울기)
    b = {k: [None] * n for k in rk}
    resid = {k: [None] * n for k in rk}
    for k in rk:
        for i in range(n):
            j0 = max(0, i - params.orth_window_days)
            ks = [m for m in range(j0, i) if z[k][m] is not None and z[base][m] is not None]
            if len(ks) >= params.orth_min_samples:
                s = ols_slope([z[base][m] for m in ks], [z[k][m] for m in ks])
                if s is not None:
                    b[k][i] = s
                    if z[k][i] is not None and z[base][i] is not None:
                        resid[k][i] = z[k][i] - s * z[base][i]

    # 2단계 다변량 OLS + 비대칭 (창 [t−59, t])
    design = [z[base]] + [resid[k] for k in rk]        # == DESIGN_COLUMNS 순서
    beta_n = [0] * n
    beta = {c: [None] * n for c in DESIGN_COLUMNS}
    n_up = [0] * n
    n_dn = [0] * n
    b_up: list[Optional[float]] = [None] * n
    b_dn: list[Optional[float]] = [None] * n
    asym: list[Optional[float]] = [None] * n
    for i in range(n):
        j0 = max(0, i - params.beta_window_days + 1)
        ks = [m for m in range(j0, i + 1) if y[m] is not None and all(col[m] is not None for col in design)]
        beta_n[i] = len(ks)
        if len(ks) < params.beta_min_samples:
            continue
        X = np.array([[col[m] for col in design] for m in ks], dtype=float)
        Y = np.array([y[m] for m in ks], dtype=float)
        coef = ols_multi(X, Y)
        if coef is None:
            continue
        for c, v in zip(DESIGN_COLUMNS, coef):
            beta[c][i] = float(v)
        up = X[:, 0] > 0
        dn = X[:, 0] < 0
        n_up[i], n_dn[i] = int(up.sum()), int(dn.sum())
        if n_up[i] >= params.asym_min_samples:
            cu = ols_multi(X[up], Y[up])
            b_up[i] = None if cu is None else float(cu[0])
        if n_dn[i] >= params.asym_min_samples:
            cd = ols_multi(X[dn], Y[dn])
            b_dn[i] = None if cd is None else float(cd[0])
        if b_up[i] is not None and b_dn[i] is not None:
            asym[i] = b_up[i] - b_dn[i]

    asym_z = [past_z(asym, i, params.z_window_days, params.z_min_samples, params.z_clip_abs) for i in range(n)]

    # change20 z
    change_z: dict[str, list] = {}
    for c, k in zip(DESIGN_COLUMNS, keys):
        s = beta[c]
        d20 = [None] * n
        for i in range(params.change_days, n):
            if s[i] is not None and s[i - params.change_days] is not None:
                d20[i] = s[i] - s[i - params.change_days]
        change_z[k] = [past_z(d20, i, params.change_z_window_days, params.change_z_min_samples, params.z_clip_abs) for i in range(n)]

    out = {"date": df["date"].dt.date, "scope": scope, "role": role}
    for k in keys:
        out[f"session_date_{k}"] = df[f"session_date_{k}"].tolist()
        out[f"align_status_{k}"] = df[f"align_status_{k}"].tolist()
        out[f"x_{k}"] = x[k]
        out[f"z_{k}"] = z[k]
    for k in rk:
        out[f"b_{k}"] = b[k]
        out[f"resid_{k}"] = resid[k]
    out["r_close"] = y
    out["beta_n"] = beta_n
    out["beta_soxx"] = beta["z_soxx"]
    for k in rk:
        out[f"beta_resid_{k}"] = beta[f"resid_{k}"]
    for k in keys:
        out[f"beta_change20_z_{k}"] = change_z[k]
    out.update({"n_up": n_up, "n_down": n_dn, "beta_up": b_up, "beta_down": b_dn, "transmission_asym": asym, "transmission_asym_z": asym_z,
                "reaction_basis": REACTION_BASIS, "time_axis": TIME_AXIS, "method": METHOD, "engine_ver": ENGINE_VER})
    return pd.DataFrame(out)


def build_panel(ohlcv: pd.DataFrame, us: pd.DataFrame, params: Optional[TransmissionParams] = None, scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    """전 scope 패널. scope 별 국내 거래일 = 그 scope 의 OHLCV 날짜. us = bronze us_daily(date, ticker, ret_pct)."""
    params = params or TransmissionParams()
    parts = []
    for sc in scopes:
        rx = reactions_from_ohlcv(ohlcv, sc, REACTION_BASIS)
        al = align_assets(rx["date"].tolist(), us, params.max_stale_calendar_days)
        parts.append(build_scope_panel(sc, rx, al, params))
    return pd.concat(parts, ignore_index=True)


def write_gold(panel: pd.DataFrame, path: Path = GOLD_TRANSMISSION_PANEL_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pandas(panel[[f.name for f in GOLD_TRANSMISSION_PANEL]], schema=GOLD_TRANSMISSION_PANEL, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def read_gold(path: Path = GOLD_TRANSMISSION_PANEL_PATH) -> pd.DataFrame:
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


def summarize(panel: pd.DataFrame, params: Optional[TransmissionParams] = None) -> dict:
    params = params or TransmissionParams()
    out: dict = {}
    keys = [x.lower() for x in ASSETS]
    rk = [x.lower() for x in RESID_ASSETS]
    num = [f"z_{k}" for k in keys] + [f"resid_{k}" for k in rk] + ["beta_soxx"] + [f"beta_resid_{k}" for k in rk] + \
          [f"beta_change20_z_{k}" for k in keys] + ["beta_up", "beta_down", "transmission_asym", "transmission_asym_z"]
    for sc, g in panel.groupby("scope", sort=False):
        g = g.copy()
        for c in num + ["beta_n", "n_up", "n_down"]:
            g[c] = pd.to_numeric(g[c], errors="coerce")
        n = len(g)
        rec = {
            "rows": int(n), "role": str(g["role"].iloc[0]), "date_range": [str(g["date"].min()), str(g["date"].max())],
            "align_status": {k: {s: int(v) for s, v in g[f"align_status_{k}"].value_counts().items()} for k in keys},
            "none_ratio": {c: float(g[c].isna().mean()) for c in num},
            "beta_n_ge_min_ratio": float((g["beta_n"] >= params.beta_min_samples).mean()) if n else None,
            "beta_soxx": _q(g["beta_soxx"]),
            **{f"beta_resid_{k}": _q(g[f"beta_resid_{k}"]) for k in rk},
            "b_orth": {k: _q(g[f"b_{k}"]) for k in rk},
            "beta_up": _q(g["beta_up"]), "beta_down": _q(g["beta_down"]),
            "n_up": _q(g["n_up"]), "n_down": _q(g["n_down"]),
            "transmission_asym": _q(g["transmission_asym"]),
            "transmission_asym_z": _q(g["transmission_asym_z"]),
            "asym_z_clipped_share": (float((g["transmission_asym_z"].abs() >= params.z_clip_abs).mean()) if g["transmission_asym_z"].notna().any() else None),
            **{f"beta_change20_z_{k}": _q(g[f"beta_change20_z_{k}"]) for k in keys},
            "resid_corr_with_z_soxx": {k: (float(g[[f"resid_{k}", "z_soxx"]].dropna().corr().iloc[0, 1])
                                          if g[[f"resid_{k}", "z_soxx"]].dropna().shape[0] > 2 else None) for k in rk},
        }
        out[sc] = rec
    return out
