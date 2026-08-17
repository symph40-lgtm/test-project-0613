"""부품 0~2 **등급C 모드** (소급 트랙, T3-C) — WORKORDER_MTPRO_v10.1 §2.1.

    등급C = "방향만 아는 이벤트 + 일봉 반응. Expected Reaction 일봉 기준 / ERR 일봉 종가 기준, Implicit only"

재료(부품 0, T1-3): **매 국내 거래일**의 "전일밤 ^SOX 수익률" — 국내 t일 09:00 KST 이전에 끝난 가장 최근 미국 세션의 수익률.
    t0_mode = "A1_open" (개장 전 재료 → t0 = 당일 09:00 시가, 갭은 MT 입력 제외 = 불변 규칙 5). asset_scope 3개(국내).

시차·휴장 정렬 규칙 (``align_prev_us_session``; 룩어헤드 금지):
    미국 세션 d(NY 달력)는 16:00 ET = 익일(d+1) 05:00/06:00 KST 종료. 따라서 국내 t일 09:00 이전에 끝난 세션은 **d ≤ t-1**
    (달력 날짜 기준 엄격 부등호). d = t 인 세션(t일 밤 미국장)은 t+1 새벽에 끝나므로 t일 값에 섞이면 **룩어헤드 위반**.
    - status "ok":     세션 d = max{d < t}, 직전 국내 거래일이 쓰지 않은 새 세션 → sox_ret_prev = ret(d)
    - status "reused": 미국 휴장 등으로 직전 국내 거래일이 이미 쓴 세션과 동일 → 새 재료 없음 → sox_ret_prev None
                       (같은 세션을 두 국내 거래일이 반응 재료로 중복 사용하는 것을 막는다)
    - status "stale":  (t - d) > max_stale_calendar_days → 데이터 결손 의심 → None
    - status "missing": d 없음(적재 시작 이전) 또는 ret None → None
    KRX 휴장(미국 개장)으로 건너뛴 미국 세션은 측정하지 않는다(사양: "가장 최근 세션" 하나만).

부품 1 (Implicit, 일봉): 정당화 반응 justified_pct = clip(β_SOX, [0.3, 3.0]) × sox_ret_prev.
    β_SOX = 과거 beta_window_days(60) 국내 거래일 롤링 OLS(절편 포함) 기울기, 대상 반응 ~ 전일밤 SOX 수익률.
    **과거만**(t 이전 행만; t의 반응은 미포함), 유효 표본 < 40 → None. |justified| < 0.3% → "재료 없는 날" → ERR None(제외).
    반응(actual_ret)의 기준은 reaction_basis:
        "open_to_close" (기본, A-1·규칙 5: 갭 제외, t0=09:00 시가 → 종가 = A-1 t5) 또는 "close_to_close" (전일 종가 → 종가, 갭 포함).
    expected_std = core.errata.expected_std_rolling(event_type="GRADEC_SOX", 잔차 이력 = 과거 재료일의 err_pct, window=err_z_window_days) — 재구현 아님.

부품 2: err_pct = actual_ret − justified_pct, err_z = err_pct / expected_std.
    good = sox_ret_prev > 0 (surprise 방향), bad = sox_ret_prev < 0. good_acceptance_z / bad_resilience_z =
    core.errata.asymmetry(최근 asym_window_days(20) 국내 거래일의 good ERR_z / bad ERR_z, min_n=2, halflife=15) — 표본 부족 None.
    good_beta / bad_beta = 같은 20일 창 good/bad 재료일에서 actual ≈ β·justified (원점 통과 OLS), 절단 [0.3, 2.0], 표본 < 3 → None.

패널 행의 가용 시점(available_at) = t일 종가 이후 (당일 반응이 들어가므로). 결측은 None (0 대체 금지).
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.core.errata import asymmetry, err_z_std_check, expected_std_rolling
from mtpro.schema import assert_t0_mode

ENGINE_VER = "gradec-0.1"
EVENT_TYPE = "GRADEC_SOX"
GRADE = "C"
T0_MODE = "A1_open"
SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")
REACTION_BASES: tuple[str, ...] = ("open_to_close", "close_to_close")

GOLD_GRADEC_PANEL_PATH = settings.GOLD / "gradec_panel.parquet"
OHLCV_ADJ_PATH = settings.BRONZE / "ohlcv_adj.parquet"

GOLD_GRADEC_PANEL = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),
    ("sox_session_date", pa.date32()),      # 재료로 쓴 미국 세션 날짜(NY 달력), 감사용
    ("sox_align_status", pa.string()),      # ok | reused | stale | missing
    ("sox_ret_prev", pa.float64()),
    ("beta_sox_raw", pa.float64()),         # 절단 전 β (감사용)
    ("beta_sox", pa.float64()),             # 절단 [0.3, 3.0] 후 (계산에 쓴 값)
    ("justified_pct", pa.float64()),
    ("expected_std", pa.float64()),
    ("actual_ret", pa.float64()),
    ("err_pct", pa.float64()),
    ("err_z", pa.float64()),
    ("no_material_flag", pa.bool_()),       # |justified| < min → True (ERR 제외). justified None 이면 None
    ("good_acceptance_z", pa.float64()), ("bad_resilience_z", pa.float64()),
    ("good_n", pa.int32()), ("bad_n", pa.int32()),
    ("good_beta", pa.float64()), ("bad_beta", pa.float64()),
    ("grade", pa.string()), ("t0_mode", pa.string()), ("reaction_basis", pa.string()),
    ("engine_ver", pa.string()),
])


@dataclass(frozen=True)
class GradeCParams:
    """사전 등록 상수. config/mtpro.yaml grade_c 블록 4개 + 이 모듈의 보조 상수(발주자 확인 요청, 측정 후 변경 금지)."""

    beta_window_days: int = 60            # config grade_c.beta_window_days
    min_justified_abs_pct: float = 0.3    # config grade_c.min_justified_abs_pct
    err_z_window_days: int = 120          # config grade_c.err_z_window_days → expected_std rolling window
    beta_min_samples: int = 40            # 발주 지시: 표본 < 40 → β None
    beta_clip: tuple[float, float] = (0.3, 3.0)
    expected_std_floor: float = 0.1       # % 단위 하한 (A-1: 유일한 상수)
    expected_std_min_samples: int = 20    # 잔차 표본 < 20 → expected_std None → err_z None
    asym_window_days: int = 20            # 최근 20 국내 거래일
    asym_min_n: int = 2                   # A-4
    asym_halflife: float = 15.0
    gb_beta_clip: tuple[float, float] = (0.3, 2.0)
    gb_beta_min_n: int = 3                # good/bad beta 표본 < 3 → None
    max_stale_calendar_days: int = 7      # 세션 정렬: t - d > 7일이면 결손 의심 → None
    reaction_basis: str = "open_to_close"

    def __post_init__(self) -> None:
        if self.reaction_basis not in REACTION_BASES:
            raise ValueError(f"reaction_basis must be one of {REACTION_BASES}")


def load_params(config_path: Optional[Path] = None, **overrides) -> GradeCParams:
    """config/mtpro.yaml grade_c 블록을 읽어 GradeCParams 생성. overrides 로 실행 옵션(reaction_basis 등) 지정."""
    p = config_path or (settings.CONFIG_DIR / "mtpro.yaml")
    cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
    gc = cfg.get("grade_c", {}) or {}
    base = GradeCParams(
        beta_window_days=int(gc.get("beta_window_days", 60)),
        min_justified_abs_pct=float(gc.get("min_justified_abs_pct", 0.3)),
        err_z_window_days=int(gc.get("err_z_window_days", 120)),
    )
    return replace(base, **overrides) if overrides else base


# ---------------------------------------------------------------------------
# 시차·휴장 정렬 (부품 0 등급C)
# ---------------------------------------------------------------------------

def _to_date_series(values: Iterable) -> pd.Series:
    return pd.to_datetime(pd.Series(list(values))).dt.normalize()


def align_prev_us_session(domestic_dates: Sequence[date], sox: pd.DataFrame, max_stale_calendar_days: int = 7) -> pd.DataFrame:
    """국내 거래일 t → 09:00 KST 이전에 끝난 가장 최근 미국 세션(d < t, 엄격)의 수익률.

    Args:
        domestic_dates: 국내 거래일(오름차순, 중복 없음).
        sox: 열 date(미국 세션 NY 날짜), ret_pct. 그 외 열 무시.
        max_stale_calendar_days: (t - d) 초과 시 "stale" → None.

    Returns:
        DataFrame[date, sox_session_date, sox_ret_prev, sox_align_status] (입력 순서).
        status: ok | reused(직전 국내 거래일과 같은 세션 → None) | stale | missing.
    """
    dom = _to_date_series(domestic_dates)
    if dom.empty:
        return pd.DataFrame(columns=["date", "sox_session_date", "sox_ret_prev", "sox_align_status"])
    if not dom.is_monotonic_increasing or dom.duplicated().any():
        raise ValueError("domestic_dates must be strictly increasing")
    s = pd.DataFrame({"sox_session_date": _to_date_series(sox["date"]), "ret": pd.to_numeric(sox["ret_pct"], errors="coerce").values})
    s = s.dropna(subset=["sox_session_date"]).sort_values("sox_session_date").drop_duplicates("sox_session_date", keep="last")
    left = pd.DataFrame({"date": dom})
    # allow_exact_matches=False → d < t (엄격). t일 미국 세션(d = t)은 절대 붙지 않는다.
    m = pd.merge_asof(left, s, left_on="date", right_on="sox_session_date", direction="backward", allow_exact_matches=False)

    status = np.full(len(m), "ok", dtype=object)
    ret = m["ret"].astype(float).to_numpy()
    sess = m["sox_session_date"]
    missing = sess.isna().to_numpy() | np.isnan(ret)
    status[missing] = "missing"
    age = (m["date"] - sess).dt.days.to_numpy(dtype=float)
    stale = (~missing) & (age > max_stale_calendar_days)
    status[stale] = "stale"
    # 직전 국내 거래일과 같은 세션 → 새 재료 없음
    reused = (~missing) & (~stale) & (sess.eq(sess.shift(1)) & sess.notna()).to_numpy()
    status[reused] = "reused"
    ret = np.where(status == "ok", ret, np.nan)

    out = pd.DataFrame({
        "date": m["date"].dt.date,
        "sox_session_date": [d.date() if pd.notna(d) else None for d in sess],
        "sox_ret_prev": [None if np.isnan(v) else float(v) for v in ret],
        "sox_align_status": status,
    })
    return out


# ---------------------------------------------------------------------------
# 반응 시계열 (bronze OHLCV → actual_ret)
# ---------------------------------------------------------------------------

def reactions_from_ohlcv(ohlcv: pd.DataFrame, code: str, basis: str) -> pd.DataFrame:
    """bronze OHLCV(수정주가, price_adjusted=True 필수 — C-2)에서 scope 의 일봉 반응(%).

    open_to_close: (close/open − 1)·100  — A-1: t0=09:00 시가, 갭 제외.
    close_to_close: (close/close_prev − 1)·100 — 갭 포함(비교용).
    Returns: DataFrame[date, actual_ret] (오름차순). 계산 불가(0·NaN)는 None.
    """
    if basis not in REACTION_BASES:
        raise ValueError(f"basis must be one of {REACTION_BASES}")
    d = ohlcv[ohlcv["code"].astype(str) == str(code)].copy()
    if d.empty:
        raise ValueError(f"no OHLCV rows for code {code!r}")
    if "price_adjusted" in d.columns and not bool(d["price_adjusted"].astype(bool).all()):
        raise AssertionError(f"C-2 violation: {code} OHLCV must be price_adjusted=True for return calculation")
    d["date"] = pd.to_datetime(d["date"]).dt.normalize()
    d = d.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    close = pd.to_numeric(d["close"], errors="coerce")
    if basis == "open_to_close":
        opn = pd.to_numeric(d["open"], errors="coerce")
        r = (close / opn.where(opn > 0) - 1.0) * 100.0
    else:
        prev = close.shift(1)
        r = (close / prev.where(prev > 0) - 1.0) * 100.0
    return pd.DataFrame({"date": d["date"].dt.date, "actual_ret": [None if pd.isna(v) else float(v) for v in r]})


# ---------------------------------------------------------------------------
# 순수 계산기
# ---------------------------------------------------------------------------

def _finite(v) -> bool:
    return v is not None and not (isinstance(v, float) and np.isnan(v))


def ols_slope(x: Sequence[float], y: Sequence[float]) -> Optional[float]:
    """절편 포함 OLS 기울기. 분산 0·표본 <2 → None."""
    xa = np.asarray(x, dtype=float)
    ya = np.asarray(y, dtype=float)
    if xa.size < 2 or ya.size != xa.size:
        return None
    vx = float(np.var(xa, ddof=1))
    if not np.isfinite(vx) or vx <= 0:
        return None
    return float(np.cov(xa, ya, ddof=1)[0, 1] / vx)


def slope_through_origin(x: Sequence[float], y: Sequence[float]) -> Optional[float]:
    """y ≈ β·x (원점 통과). Σx² = 0 → None."""
    xa = np.asarray(x, dtype=float)
    ya = np.asarray(y, dtype=float)
    if xa.size == 0 or ya.size != xa.size:
        return None
    den = float(np.dot(xa, xa))
    if not np.isfinite(den) or den <= 0:
        return None
    return float(np.dot(xa, ya) / den)


def _clip(v: Optional[float], lo: float, hi: float) -> Optional[float]:
    return None if v is None else float(min(hi, max(lo, v)))


def build_scope_panel(scope: str, aligned: pd.DataFrame, reactions: pd.DataFrame, params: GradeCParams) -> pd.DataFrame:
    """scope 하나의 등급C 패널. 모든 롤링 통계는 t 이전 행만(β·expected_std) 또는 t 포함 최근 창(asymmetry·good/bad beta)."""
    assert_t0_mode(T0_MODE, scope)
    a = aligned.copy()
    a["date"] = pd.to_datetime(a["date"]).dt.normalize()
    r = reactions.copy()
    r["date"] = pd.to_datetime(r["date"]).dt.normalize()
    df = a.merge(r, on="date", how="left").sort_values("date").reset_index(drop=True)

    n = len(df)
    xs = [v if _finite(v) else None for v in df["sox_ret_prev"].tolist()]
    ys = [v if _finite(v) else None for v in df["actual_ret"].tolist()]

    beta_raw: list[Optional[float]] = [None] * n
    beta: list[Optional[float]] = [None] * n
    just: list[Optional[float]] = [None] * n
    nomat: list[Optional[bool]] = [None] * n
    estd: list[Optional[float]] = [None] * n
    errp: list[Optional[float]] = [None] * n
    errz: list[Optional[float]] = [None] * n
    g_acc: list[Optional[float]] = [None] * n
    b_res: list[Optional[float]] = [None] * n
    g_n: list[int] = [0] * n
    b_n: list[int] = [0] * n
    g_beta: list[Optional[float]] = [None] * n
    b_beta: list[Optional[float]] = [None] * n
    resid_hist: list[float] = []            # 과거 재료일 err_pct (시간순) — t 계산 후 append (t 자신은 미포함)
    direction: list[Optional[str]] = [None] * n

    lo_b, hi_b = params.beta_clip
    lo_g, hi_g = params.gb_beta_clip
    for i in range(n):
        x = xs[i]
        y = ys[i]
        # --- β_SOX: 과거 window 행(t 미포함) 중 x·y 모두 있는 표본
        j0 = max(0, i - params.beta_window_days)
        px = [xs[k] for k in range(j0, i) if xs[k] is not None and ys[k] is not None]
        py = [ys[k] for k in range(j0, i) if xs[k] is not None and ys[k] is not None]
        if len(px) >= params.beta_min_samples:
            b = ols_slope(px, py)
            beta_raw[i] = b
            beta[i] = _clip(b, lo_b, hi_b)
        # --- 정당화 반응 / 재료 없는 날
        if beta[i] is not None and x is not None:
            just[i] = beta[i] * x
            nomat[i] = abs(just[i]) < params.min_justified_abs_pct
        material = just[i] is not None and nomat[i] is False
        # --- expected_std (A-1 재사용): 과거 잔차 이력만
        estd[i] = expected_std_rolling({EVENT_TYPE: resid_hist}, EVENT_TYPE, window=params.err_z_window_days,
                                       floor=params.expected_std_floor, min_samples=params.expected_std_min_samples)
        # --- ERR
        if material and y is not None:
            errp[i] = y - just[i]
            if estd[i] is not None:
                errz[i] = errp[i] / estd[i]
            direction[i] = "good" if x > 0 else ("bad" if x < 0 else None)
            resid_hist.append(errp[i])
        # --- 비대칭 (A-4 재사용): 최근 asym_window_days 국내 거래일(t 포함)
        w0 = max(0, i - params.asym_window_days + 1)
        good_z = [errz[k] for k in range(w0, i + 1) if direction[k] == "good" and errz[k] is not None]
        bad_z = [errz[k] for k in range(w0, i + 1) if direction[k] == "bad" and errz[k] is not None]
        asy = asymmetry(good_z, bad_z, min_n=params.asym_min_n, halflife=params.asym_halflife)
        g_acc[i], b_res[i], g_n[i], b_n[i] = asy["good_acceptance_z"], asy["bad_resilience_z"], asy["good_n"], asy["bad_n"]
        # --- good/bad beta: actual ≈ β·justified (원점 통과), 같은 창
        for lab, store in (("good", g_beta), ("bad", b_beta)):
            ks = [k for k in range(w0, i + 1) if direction[k] == lab and errp[k] is not None]
            if len(ks) >= params.gb_beta_min_n:
                store[i] = _clip(slope_through_origin([just[k] for k in ks], [ys[k] for k in ks]), lo_g, hi_g)

    out = pd.DataFrame({
        "date": df["date"].dt.date,
        "scope": scope,
        "sox_session_date": df["sox_session_date"].tolist(),
        "sox_align_status": df["sox_align_status"].tolist(),
        "sox_ret_prev": xs,
        "beta_sox_raw": beta_raw,
        "beta_sox": beta,
        "justified_pct": just,
        "expected_std": estd,
        "actual_ret": ys,
        "err_pct": errp,
        "err_z": errz,
        "no_material_flag": nomat,
        "good_acceptance_z": g_acc,
        "bad_resilience_z": b_res,
        "good_n": g_n,
        "bad_n": b_n,
        "good_beta": g_beta,
        "bad_beta": b_beta,
        "grade": GRADE,
        "t0_mode": T0_MODE,
        "reaction_basis": params.reaction_basis,
        "engine_ver": ENGINE_VER,
    })
    return out


def build_panel(ohlcv: pd.DataFrame, sox: pd.DataFrame, params: GradeCParams, scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    """전 scope 패널. scope 별 국내 거래일 = 그 scope 의 OHLCV 날짜."""
    parts = []
    for sc in scopes:
        rx = reactions_from_ohlcv(ohlcv, sc, params.reaction_basis)
        al = align_prev_us_session(rx["date"].tolist(), sox, params.max_stale_calendar_days)
        parts.append(build_scope_panel(sc, al, rx, params))
    return pd.concat(parts, ignore_index=True)


def write_gold(panel: pd.DataFrame, path: Path = GOLD_GRADEC_PANEL_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = pa.Table.from_pandas(panel[[f.name for f in GOLD_GRADEC_PANEL]], schema=GOLD_GRADEC_PANEL, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def read_gold(path: Path = GOLD_GRADEC_PANEL_PATH) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


# ---------------------------------------------------------------------------
# 요약 리포트
# ---------------------------------------------------------------------------

def summarize(panel: pd.DataFrame, params: Optional[GradeCParams] = None) -> dict:
    """scope 별: 행 수·정렬 상태 분포·재료 없는 날 비율·None 비율·|err_z|<5 비율·std(err_z)·good/bad 표본 도달 비율."""
    params = params or GradeCParams()
    out: dict = {}
    num_cols = ("sox_ret_prev", "beta_sox_raw", "beta_sox", "justified_pct", "expected_std", "actual_ret", "err_pct",
                "err_z", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta", "good_n", "bad_n")
    for sc, g in panel.groupby("scope", sort=False):
        g = g.copy()
        for c in num_cols:
            g[c] = pd.to_numeric(g[c], errors="coerce")
        n = len(g)
        just_def = g["justified_pct"].notna()
        nm = g["no_material_flag"]
        ez = pd.to_numeric(g["err_z"], errors="coerce")
        ez_v = ez.dropna()
        status_counts = g["sox_align_status"].value_counts().to_dict()
        rec = {
            "rows": int(n),
            "date_range": [str(g["date"].min()), str(g["date"].max())],
            "align_status": {k: int(v) for k, v in status_counts.items()},
            "beta_defined": int(g["beta_sox"].notna().sum()),
            "justified_defined": int(just_def.sum()),
            "no_material_days": int((nm == True).sum()),  # noqa: E712
            "no_material_ratio_of_defined": (float((nm == True).sum()) / float(just_def.sum())) if just_def.sum() else None,  # noqa: E712
            "err_pct_defined": int(g["err_pct"].notna().sum()),
            "err_z_defined": int(ez_v.size),
            "none_ratio": {c: float(g[c].isna().mean()) for c in
                           ("sox_ret_prev", "beta_sox", "justified_pct", "expected_std", "err_pct", "err_z",
                            "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta")},
            "abs_err_z_lt5_ratio": (float((ez_v.abs() < 5).mean()) if ez_v.size else None),
            "err_z_std": (float(ez_v.std(ddof=1)) if ez_v.size >= 2 else None),
            "err_z_std_in_[0.7,1.3]": err_z_std_check(ez_v.tolist()),
            "good_reached_ratio": float((g["good_n"] >= params.asym_min_n).mean()) if n else None,
            "bad_reached_ratio": float((g["bad_n"] >= params.asym_min_n).mean()) if n else None,
            "good_beta_defined_ratio": float(g["good_beta"].notna().mean()) if n else None,
            "bad_beta_defined_ratio": float(g["bad_beta"].notna().mean()) if n else None,
            "beta_sox_clipped_share": (float(((g["beta_sox_raw"] < params.beta_clip[0]) | (g["beta_sox_raw"] > params.beta_clip[1])).sum()
                                             / g["beta_sox_raw"].notna().sum()) if g["beta_sox_raw"].notna().sum() else None),
        }
        out[sc] = rec
    return out
