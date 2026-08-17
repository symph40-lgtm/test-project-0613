"""부품 4 — Flow Impact (WORKORDER_MTPRO_v10.1 §2.1 소급 트랙, T1-1 승인 제안, config `flow` 블록).

입력(bronze, 읽기 전용):
  - investor_flow.parquet  : 투자자별 순매수 (scope 005930 | 000660 | KOSPI 시장 전체), KRW
  - ohlcv_unadj.parquet    : 비수정 거래대금(price_adjusted=False) — 정규화 **분모 전용**
  - ohlcv_adj.parquet      : 수정주가 종가(price_adjusted=True) — 수익률 **전용** (KOSPI200 = 지수 1028)
  - (index_unit = PIT_CONSTITUENT_SUM 인 경우) investor_flow_constituents + constituents → flow_reconcile.pit_constituent_sum

출력: gold/flow_panel.parquet (schema.GOLD_FLOW_PANEL) — 컬럼: date, scope, foreign_norm, institution_norm,
  flow_beta_foreign, flow_beta_inst, expected_from_flow, flow_impact_residual_z, flow_trend_z, n_beta_obs, beta_extreme_flag, engine_ver.

정의(사전 등록 — 측정 후 변경 금지):
  - foreign_norm = foreign / mean20(trading_value)  (과거 20거래일, 당일 포함, 20개 전부 있어야 산출). institution_norm 동일.
  - daily_return = adjusted close pct_change (수정주가만; C-2 — 분모의 비수정 가격은 어떤 가격 식에도 넣지 않는다).
  - flow_beta: 최근 120거래일(과거만, 당일 포함) OLS  ret ~ 1 + foreign_norm + institution_norm. 완전 관측 <60 → None.
    expected_from_flow = 적합값(당일), residual = ret − expected,
    flow_impact_residual_z = residual / std(residual, 최근 120거래일 당일 포함, 유효 ≥60, ddof=1).
    beta_extreme_flag = |β_foreign|>1 or |β_inst|>1 (T1 검증 항목).
  - flow_trend_z: 최근 5일 foreign_norm 의 OLS 기울기(np.polyfit, 5개 전부 유효) → 기준 분포 = **당일 제외** 직전 120거래일의 기울기
    (유효 ≥60, ddof=1). AM-2 취지(자기 정규화 방지)로 당일 제외.
  - 결측은 None (0 대체 금지). 룩어헤드 없음: 날짜 t 의 모든 값은 t 이하 행만 사용 (tests/test_flow.py 에서 미래 행 변조 검증).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from mtpro import settings
from mtpro.schema import GOLD_FLOW_PANEL, assert_same_adjustment

ENGINE_VER = "flow-0.1"

# ---- 사전 등록 상수 (config flow.params 로 덮어쓸 수 있음; 기본값이 정본) ----
MEAN_TV_DAYS = 20
BETA_WINDOW_DAYS = 120
BETA_MIN_OBS = 60
RESID_Z_WINDOW_DAYS = 120
RESID_Z_MIN_OBS = 60
TREND_DAYS = 5
TREND_REF_WINDOW_DAYS = 120
TREND_REF_MIN_OBS = 60
BETA_EXTREME_ABS = 1.0

SCOPE_SOURCES = {           # scope → (flow scope in investor_flow, trading_value code in ohlcv_unadj, return code in ohlcv_adj)
    "005930": ("005930", "005930", "005930"),
    "000660": ("000660", "000660", "000660"),
    "KOSPI200": ("KOSPI", "KOSPI", "KOSPI200"),
}
P_FLOW_PANEL = settings.GOLD / "flow_panel.parquet"


def load_config(path: Path | None = None) -> dict:
    p = path or (settings.CONFIG_DIR / "mtpro.yaml")
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def _rolling_ols_scope(ret: np.ndarray, fn: np.ndarray, inn: np.ndarray, window: int, min_obs: int):
    """각 t 에 대해 [t-window+1, t] 창의 완전 관측으로 OLS. 반환 (b_f, b_i, expected, n_obs)."""
    n = len(ret)
    bf = np.full(n, np.nan)
    bi = np.full(n, np.nan)
    exp_ = np.full(n, np.nan)
    nobs = np.zeros(n, dtype=int)
    valid = np.isfinite(ret) & np.isfinite(fn) & np.isfinite(inn)
    for t in range(n):
        lo = max(0, t - window + 1)
        m = valid[lo:t + 1]
        k = int(m.sum())
        nobs[t] = k
        if k < min_obs:
            continue
        X = np.column_stack([np.ones(k), fn[lo:t + 1][m], inn[lo:t + 1][m]])
        y = ret[lo:t + 1][m]
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)
        bf[t], bi[t] = coef[1], coef[2]
        if np.isfinite(fn[t]) and np.isfinite(inn[t]):
            exp_[t] = coef[0] + coef[1] * fn[t] + coef[2] * inn[t]
    return bf, bi, exp_, nobs


def _trend_slope(fn: np.ndarray, days: int) -> np.ndarray:
    n = len(fn)
    out = np.full(n, np.nan)
    x = np.arange(days, dtype=float)
    for t in range(days - 1, n):
        seg = fn[t - days + 1:t + 1]
        if np.all(np.isfinite(seg)):
            out[t] = np.polyfit(x, seg, 1)[0]
    return out


def compute_flow_scope(df: pd.DataFrame, scope: str, params: dict | None = None) -> pd.DataFrame:
    """단일 scope 계산. df 컬럼: date, foreign, institution, trading_value(비수정), close_adj(수정) — date 오름차순·유일.
    결측은 NaN/None 으로 들어와야 하며 0 으로 대체하지 않는다."""
    p = {**_defaults(), **(params or {})}
    d = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    tv = pd.to_numeric(d["trading_value"], errors="coerce").astype(float)
    mean_tv = tv.rolling(p["mean_tv_days"], min_periods=p["mean_tv_days"]).mean()
    mean_tv = mean_tv.where(mean_tv > 0)
    fn = (pd.to_numeric(d["foreign"], errors="coerce") / mean_tv).astype(float)
    inn = (pd.to_numeric(d["institution"], errors="coerce") / mean_tv).astype(float)
    close = pd.to_numeric(d["close_adj"], errors="coerce").astype(float)
    ret = close.pct_change(fill_method=None)

    bf, bi, exp_, nobs = _rolling_ols_scope(ret.to_numpy(), fn.to_numpy(), inn.to_numpy(), p["beta_window_days"], p["beta_min_obs"])
    resid = ret.to_numpy() - exp_
    resid_s = pd.Series(resid)
    resid_std = resid_s.rolling(p["resid_z_window_days"], min_periods=p["resid_z_min_obs"]).std(ddof=1)
    resid_z = (resid_s / resid_std.where(resid_std > 0)).to_numpy()

    slope = pd.Series(_trend_slope(fn.to_numpy(), p["trend_days"]))
    ref = slope.shift(1).rolling(p["trend_ref_window_days"], min_periods=p["trend_ref_min_obs"])
    ref_std = ref.std(ddof=1)
    trend_z = ((slope - ref.mean()) / ref_std.where(ref_std > 0)).to_numpy()

    beta_ok = np.isfinite(bf) & np.isfinite(bi)
    flag = pd.array([None] * len(d), dtype="boolean")
    flag[beta_ok] = (np.abs(bf[beta_ok]) > p["beta_extreme_abs"]) | (np.abs(bi[beta_ok]) > p["beta_extreme_abs"])

    out = pd.DataFrame({
        "date": d["date"].values, "scope": scope,
        "foreign_norm": fn.to_numpy(), "institution_norm": inn.to_numpy(),
        "flow_beta_foreign": bf, "flow_beta_inst": bi, "expected_from_flow": exp_,
        "flow_impact_residual_z": resid_z, "flow_trend_z": trend_z,
        "n_beta_obs": nobs, "beta_extreme_flag": flag, "engine_ver": ENGINE_VER,
    })
    for c in ("foreign_norm", "institution_norm", "flow_beta_foreign", "flow_beta_inst", "expected_from_flow", "flow_impact_residual_z", "flow_trend_z"):
        out[c] = out[c].astype(float).where(np.isfinite(out[c].astype(float)), None)   # NaN/inf → None (0 대체 금지)
    return out


def _defaults() -> dict:
    return {"mean_tv_days": MEAN_TV_DAYS, "beta_window_days": BETA_WINDOW_DAYS, "beta_min_obs": BETA_MIN_OBS,
            "resid_z_window_days": RESID_Z_WINDOW_DAYS, "resid_z_min_obs": RESID_Z_MIN_OBS, "trend_days": TREND_DAYS,
            "trend_ref_window_days": TREND_REF_WINDOW_DAYS, "trend_ref_min_obs": TREND_REF_MIN_OBS, "beta_extreme_abs": BETA_EXTREME_ABS}


def assemble_scope_input(flow_df: pd.DataFrame, unadj_df: pd.DataFrame, adj_df: pd.DataFrame,
                         flow_scope: str, tv_code: str, ret_code: str) -> pd.DataFrame:
    """bronze 3종 → compute_flow_scope 입력. 기준 축 = 수정주가(ret_code) 거래일. C-2 검사 포함."""
    a = adj_df[adj_df["code"] == ret_code]
    u = unadj_df[unadj_df["code"] == tv_code]
    f = flow_df[flow_df["scope"] == flow_scope]
    # C-2: 수익률(가격 식)에 들어가는 close 는 전부 adjusted=True 여야 하고(혼용 시 assert), 분모 거래대금 원천은 전부 비수정.
    # 비수정 가격은 어떤 가격 식에도 넣지 않는다 (trading_value 만 사용).
    if len(a):
        assert_same_adjustment(*[bool(x) for x in a["price_adjusted"].unique()])
        if not bool(a["price_adjusted"].iloc[0]):
            raise AssertionError("C-2: return source must be price_adjusted=True")
    if len(u) and u["price_adjusted"].astype(bool).any():
        raise AssertionError("C-2: trading_value denominator source must be price_adjusted=False")
    base = pd.DataFrame({"date": pd.to_datetime(a["date"]).dt.date, "close_adj": a["close"].astype(float).values}).sort_values("date")
    tvs = pd.DataFrame({"date": pd.to_datetime(u["date"]).dt.date, "trading_value": u["trading_value"].astype(float).values})
    fl = pd.DataFrame({"date": pd.to_datetime(f["date"]).dt.date, "foreign": f["foreign"].astype(float).values, "institution": f["institution"].astype(float).values})
    out = base.merge(tvs, on="date", how="left").merge(fl, on="date", how="left")
    return out.drop_duplicates("date").reset_index(drop=True)


def build_flow_panel(cfg: dict | None = None, *, flow_df: pd.DataFrame | None = None, unadj_df: pd.DataFrame | None = None,
                     adj_df: pd.DataFrame | None = None, write: bool = True, out_path: Path = P_FLOW_PANEL,
                     panel_start=None) -> pd.DataFrame:
    """전 scope 패널 산출(+gold 저장). KOSPI200 스코프의 수급 소스는 config flow.index_unit 판정(C-1)에 따른다.
    계산은 수정주가 축 전체(2022~)에서 하되 출력은 panel_start(기본 = 소급 트랙 시작 2023-01-03) 이후 행만 남긴다
    (그 이전은 수급 원천 자체가 없어 전부 None — 워밍업 결측 비율을 왜곡하지 않기 위함)."""
    from mtpro.ingest import krx, store
    cfg = cfg or load_config()
    fcfg = cfg.get("flow", {})
    params = fcfg.get("params") or {}
    flow_df = flow_df if flow_df is not None else store.read(krx.P_INVESTOR_FLOW)
    unadj_df = unadj_df if unadj_df is not None else store.read(krx.P_OHLCV_UNADJ)
    adj_df = adj_df if adj_df is not None else store.read(krx.P_OHLCV_ADJ)
    if flow_df is None or unadj_df is None or adj_df is None:
        raise RuntimeError("bronze inputs missing — run jobs/ingest_krx.py first")
    index_unit = fcfg.get("index_unit", "KOSPI_MARKET")
    if index_unit == "PIT_CONSTITUENT_SUM":
        from mtpro.components.flow_reconcile import pit_constituent_sum
        summed = pit_constituent_sum()                        # date, foreign, institution (합산)
        summed = summed.assign(scope="PIT_SUM", other_corp=None, individual=None, total=None)
        flow_df = pd.concat([flow_df, summed], ignore_index=True)
        sources = {**SCOPE_SOURCES, "KOSPI200": ("PIT_SUM", "KOSPI", "KOSPI200")}
    else:
        sources = SCOPE_SOURCES
    scopes = [str(s) for s in cfg.get("scopes", list(sources))]
    parts = []
    for sc in scopes:
        fs, tvc, rc = sources[sc]
        inp = assemble_scope_input(flow_df, unadj_df, adj_df, fs, tvc, rc)
        parts.append(compute_flow_scope(inp, sc, params))
    panel = pd.concat(parts, ignore_index=True)
    start = panel_start if panel_start is not None else krx.FLOW_START
    panel = panel[pd.to_datetime(panel["date"]).dt.date >= start].reset_index(drop=True)
    if write:
        store.write(panel, GOLD_FLOW_PANEL, out_path)
    return panel


def summarize_panel(panel: pd.DataFrame) -> dict:
    """스코프별 행 수·None 비율·|β|>1 비율·잔차 z 95% 범위 (보고용)."""
    out = {}
    for sc, g in panel.groupby("scope"):
        z = pd.to_numeric(g["flow_impact_residual_z"], errors="coerce").dropna()
        flag = g["beta_extreme_flag"].dropna().astype(bool)
        out[sc] = {
            "rows": int(len(g)),
            "range": [str(g["date"].min()), str(g["date"].max())],
            "none_ratio": {c: round(float(g[c].isna().mean()), 3) for c in ("foreign_norm", "flow_beta_foreign", "flow_impact_residual_z", "flow_trend_z")},
            "beta_extreme_ratio": round(float(flag.mean()), 3) if len(flag) else None,
            "beta_extreme_days": int(flag.sum()) if len(flag) else 0,
            "resid_z_p2_5_p97_5": [round(float(z.quantile(0.025)), 3), round(float(z.quantile(0.975)), 3)] if len(z) else None,
            "resid_z_std": round(float(z.std()), 3) if len(z) else None,
            "beta_foreign_median": round(float(pd.to_numeric(g["flow_beta_foreign"], errors="coerce").median()), 4) if g["flow_beta_foreign"].notna().any() else None,
            "beta_inst_median": round(float(pd.to_numeric(g["flow_beta_inst"], errors="coerce").median()), 4) if g["flow_beta_inst"].notna().any() else None,
        }
    return out
