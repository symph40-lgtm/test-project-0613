"""부품 9 — Post-Shock Acceptance (PSA). WORKORDER AM-7 · 계획서 `docs/mtpro-t5-plan.md` §4(정의)·§12.4(기준시점 잠금)·§7(스키마).

입력(bronze, 읽기 전용): ohlcv_adj (date, code, open, high, low, close, volume, price_adjusted=True) — 스코프 = code
  (KOSPI200 · 005930 · 000660). 지수 volume은 **비율(vol_norm)에만** 쓰인다.

champion 사양(사전 등록 — 측정 후 변경 금지, 대안은 challenger·shadow만):
  - r_t = close_t/close_{t−1} − 1, gap_t = open_t/close_{t−1} − 1.
  - σ20 = std(r_{t−20..t−1}) (ddof=1, **충격일 t 제외**, 과거 전용, 유효 표본 20 미만 → None) / σ20_gap 동일.
  - 충격 검출(t 마감 후): |r_t| > K_SIGMA·σ20 **또는** |gap_t| > K_GAP·σ20_gap. trigger ∈ {ret, gap, both}.
    방향 = sign(r_t); 갭 조건만 충족 시 sign(gap_t). k_sigma = 실측 |r_t|/σ20 (σ20 없으면 None).
  - 관찰창 W=5 세션(t+1..t+5). "세션" = **그 스코프의 bronze 거래일 순서**(행 순서). 최종 지표(t+5 마감):
      level_hold = (min close_{t+1..t+5} − close_{t−1}) / (close_t − close_{t−1})  (양 충격; 음 충격은 max close, 대칭),
                   클립 [−1, 1.5]; 분모 0 → None
      rebreak    = any(low_{t+1..t+5} < low_t)  (음 충격: any(high > high_t))
      range_norm = mean(TR_{t+3..t+5}) / mean(TR_{t−20..t−1})   (TR = Wilder true range)
      vol_norm   = mean(vol_{t+3..t+5}) / mean(vol_{t−20..t−1}) (volume 없으면 None)
    psa_score = mean(z(level_hold), −z(rebreak), −z(range_norm), −z(vol_norm)) — 가용 평균(≥1개);
      z 기준 분포 = **같은 스코프의 과거 final 충격**(available_at ≤ t−1, shock_date ∈ 직전 120 세션) — 표본<10 → None, 클립 ±3.
    psa_z = psa_score × direction (양 충격 유지·음 충격 회복 = +).
  - **available_at = 세션 t+5의 날짜(마감)**. 그 전 status=pending, 모든 지표·psa_z None. pending의 available_at은 None
    (bronze 순서 기준이라 미래 세션 날짜를 알 수 없다 — 해석 기록).
  - 창(t+1..t+5) 안에 새 충격 → 각각 독립 레코드, **양쪽** overlap_shock=True (값은 그대로 확정).
  - `psa_state_at(events, asof, scope)`: 상위 결합이 쓰는 **유일한 접점** — status=final ∧ available_at ≤ asof 인 psa_z 만
    EWMA(반감기 10 세션) + freshness. pending은 어떤 값이 들어 있어도 절대 포함하지 않는다.
  - challenger PSA-EARLY(W=3, t+3 부분 관찰)·PSA-K2(k=2.0)·PSA-W7(W=7)은 같은 엔진의 파라미터 변형, shadow 산출 전용
    (`gold/challengers/psa_*.parquet`, 결합 미사용).
룩어헤드 없음: 날짜 d 시점의 상태는 d 이하 자료만. `asof` 로 자료를 절단하면 그 시점의 pending/final 이 재현된다.
결측은 None(0 대체 금지).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import date
from typing import Any, Iterable, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa

from mtpro.schema import assert_same_adjustment

ENGINE_VER = "psa-0.1"

# ---- 사전 등록 상수 (config psa.constants 와 일치 테스트) ----------------------------------------
K_SIGMA = 2.5                      # |r_t| > 2.5·σ20
K_GAP = 2.0                        # |gap_t| > 2.0·σ20_gap
SIGMA_WINDOW_DAYS = 20             # σ20 창 = t−20..t−1 (t 제외)
SIGMA_MIN_SAMPLES = 20             # 유효 표본 20 미만 → None
WINDOW_SESSIONS = 5                # 관찰창 W = t+1..t+5
SETTLE_SESSIONS = 3                # range/vol 분자 = 창의 마지막 3세션 (t+3..t+5)
LEVEL_HOLD_CLIP = (-1.0, 1.5)
Z_REF_WINDOW_DAYS = 120            # z 기준 분포 = 직전 120 세션(t−1까지)의 과거 final 충격
Z_REF_MIN_SAMPLES = 10             # 표본 < 10 → None
Z_CLIP = 3.0                       # §3 공통 규정 클립 ±3
EWMA_HALFLIFE_DAYS = 10            # psa_state_at EWMA 반감기(세션), freshness = 0.5^(d/10)
DEFAULT_SCOPES = ("KOSPI200", "005930", "000660")
TRIGGERS = ("ret", "gap", "both")
STATUSES = ("pending", "final")
CHALLENGER_NAMES = ("PSA-EARLY", "PSA-K2", "PSA-W7")


@dataclass(frozen=True)
class PsaParams:
    k_sigma: float = K_SIGMA
    k_gap: float = K_GAP
    sigma_window: int = SIGMA_WINDOW_DAYS
    sigma_min_samples: int = SIGMA_MIN_SAMPLES
    window: int = WINDOW_SESSIONS
    settle: int = SETTLE_SESSIONS
    level_hold_clip: tuple[float, float] = LEVEL_HOLD_CLIP
    z_ref_window: int = Z_REF_WINDOW_DAYS
    z_ref_min_samples: int = Z_REF_MIN_SAMPLES
    z_clip: float = Z_CLIP

    def __post_init__(self) -> None:
        if self.window < 1 or self.settle < 1 or self.settle > self.window:
            raise ValueError(f"invalid window/settle {self.window}/{self.settle}")


PSA_CHAMPION = PsaParams()
# challenger = champion 파라미터의 단일 변형 (shadow 전용). PSA-EARLY: W=3 → 부분 관찰(t+1..t+3, 정착 = 마지막 3세션 = 창 전체).
CHALLENGERS: dict[str, PsaParams] = {
    "PSA-EARLY": replace(PSA_CHAMPION, window=3),
    "PSA-K2": replace(PSA_CHAMPION, k_sigma=2.0),
    "PSA-W7": replace(PSA_CHAMPION, window=7),
}

GOLD_PSA_EVENTS = pa.schema([
    ("shock_id", pa.string()),            # f"{scope}:{shock_date}"
    ("scope", pa.string()),
    ("shock_date", pa.date32()),
    ("direction", pa.int8()),             # +1 / −1
    ("k_sigma", pa.float64()),            # 실측 |r_t|/σ20 (σ20 None → None)
    ("trigger", pa.string()),             # ret | gap | both
    ("status", pa.string()),              # pending | final
    ("available_at", pa.date32()),        # 세션 t+W 날짜 (pending → None)
    ("level_hold", pa.float64()),
    ("rebreak", pa.bool_()),
    ("range_norm", pa.float64()),
    ("vol_norm", pa.float64()),
    ("psa_score", pa.float64()),          # 부호 곱하기 전 (가용 z 평균)
    ("psa_z", pa.float64()),              # psa_score × direction
    ("overlap_shock", pa.bool_()),
    ("engine_ver", pa.string()),
])
EVENT_COLUMNS = GOLD_PSA_EVENTS.names
GOLD_PSA_CHALLENGER = pa.schema(list(GOLD_PSA_EVENTS) + [pa.field("challenger", pa.string())])
FINAL_METRICS = ("level_hold", "rebreak", "range_norm", "vol_norm", "psa_score", "psa_z")


class PsaInputError(ValueError):
    """loud-failure: 입력 결손·스키마 위반은 조용히 넘어가지 않는다."""


# ---------------------------------------------------------------------------
# 입력 준비
# ---------------------------------------------------------------------------

def _validate_adjusted(ohlcv: pd.DataFrame) -> None:
    if "price_adjusted" not in ohlcv.columns:
        raise PsaInputError("ohlcv missing required column 'price_adjusted' (C-2)")
    flags = [bool(x) for x in ohlcv["price_adjusted"].dropna().unique()]
    if not flags:
        raise PsaInputError("ohlcv price_adjusted column is empty")
    assert_same_adjustment(*flags)
    if flags != [True]:
        raise AssertionError("C-2: PSA price metrics require price_adjusted=True source")


def _scope_frame(ohlcv: pd.DataFrame, scope: str, asof: Optional[date]) -> pd.DataFrame:
    df = ohlcv[ohlcv["code"].astype(str) == scope].copy()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    if asof is not None:
        df = df[df["date"] <= asof]
    df = df.drop_duplicates("date", keep="last").sort_values("date").reset_index(drop=True)
    for c in ("open", "high", "low", "close"):
        if c not in df.columns:
            raise PsaInputError(f"ohlcv missing column {c!r}")
        df[c] = df[c].astype(float)
    df["volume"] = df["volume"].astype(float) if "volume" in df.columns else np.nan
    return df[["date", "open", "high", "low", "close", "volume"]]


def sessions_from_ohlcv(ohlcv: pd.DataFrame, scope: Optional[str] = None) -> list[date]:
    """세션 목록 = bronze 거래일(중복 제거·정렬). scope 지정 시 그 스코프의 행만."""
    df = ohlcv if scope is None else ohlcv[ohlcv["code"].astype(str) == scope]
    return sorted(pd.to_datetime(df["date"]).dt.date.unique())


# ---------------------------------------------------------------------------
# 시계열 원재료
# ---------------------------------------------------------------------------

def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """Wilder TR = max(high−low, |high−close_{t−1}|, |low−close_{t−1}|); 어느 하나 결측(첫 행 포함) → NaN."""
    prev = np.concatenate([[np.nan], close[:-1]])
    stacked = np.vstack([high - low, np.abs(high - prev), np.abs(low - prev)])
    tr = np.max(stacked, axis=0)                     # NaN 전파 (nanmax 아님 — 부분 결측은 None)
    return tr


def _prior_std(x: np.ndarray, window: int, min_samples: int) -> np.ndarray:
    """σ_t = std(x_{t−window..t−1}) (ddof=1) — 당일 제외. 창 안 유효 표본 < min_samples → NaN."""
    s = pd.Series(x, dtype=float).shift(1).rolling(window, min_periods=min_samples).std(ddof=1)
    return s.to_numpy()


def _prior_mean(x: np.ndarray, window: int) -> np.ndarray:
    """mean(x_{t−window..t−1}) — 창 전부 유효해야 산출(엄격), 아니면 NaN."""
    s = pd.Series(x, dtype=float).shift(1).rolling(window, min_periods=window).mean()
    return s.to_numpy()


def _f(v: Any) -> Optional[float]:
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


def _mean_all_valid(a: np.ndarray) -> Optional[float]:
    if len(a) == 0 or np.isnan(a).any():
        return None
    return float(np.mean(a))


def _z(value: Optional[float], ref: Sequence[float], min_samples: int, clip: float) -> Optional[float]:
    if value is None:
        return None
    vals = np.array([v for v in ref if v is not None and not (isinstance(v, float) and math.isnan(v))], dtype=float)
    if len(vals) < min_samples:
        return None
    sd = float(np.std(vals, ddof=1))
    if not np.isfinite(sd) or sd <= 0:
        return None
    return float(np.clip((value - float(np.mean(vals))) / sd, -clip, clip))


# ---------------------------------------------------------------------------
# 충격 검출·지표
# ---------------------------------------------------------------------------

@dataclass
class _Shock:
    idx: int
    date: date
    direction: int
    k_sigma: Optional[float]
    trigger: str
    final: bool
    avail_idx: Optional[int]
    level_hold: Optional[float] = None
    rebreak: Optional[bool] = None
    range_norm: Optional[float] = None
    vol_norm: Optional[float] = None
    psa_score: Optional[float] = None
    psa_z: Optional[float] = None
    overlap: bool = False


def _detect(df: pd.DataFrame, p: PsaParams) -> list[_Shock]:
    close = df["close"].to_numpy(dtype=float)
    open_ = df["open"].to_numpy(dtype=float)
    n = len(close)
    prev = np.concatenate([[np.nan], close[:-1]])
    r = close / prev - 1.0
    gap = open_ / prev - 1.0
    sig = _prior_std(r, p.sigma_window, p.sigma_min_samples)
    sig_gap = _prior_std(gap, p.sigma_window, p.sigma_min_samples)
    out: list[_Shock] = []
    for i in range(n):
        ret_hit = bool(np.isfinite(r[i]) and np.isfinite(sig[i]) and sig[i] > 0 and abs(r[i]) > p.k_sigma * sig[i])
        gap_hit = bool(np.isfinite(gap[i]) and np.isfinite(sig_gap[i]) and sig_gap[i] > 0 and abs(gap[i]) > p.k_gap * sig_gap[i])
        if not (ret_hit or gap_hit):
            continue
        direction = int(np.sign(r[i])) if ret_hit else int(np.sign(gap[i]))
        if direction == 0:                                   # 갭만 충족인데 gap==0 은 불가능, r==0 은 ret_hit 불가 — 방어
            continue
        trig = "both" if (ret_hit and gap_hit) else ("ret" if ret_hit else "gap")
        k = float(abs(r[i]) / sig[i]) if (np.isfinite(sig[i]) and sig[i] > 0 and np.isfinite(r[i])) else None
        final = i + p.window <= n - 1
        out.append(_Shock(idx=i, date=df["date"].iloc[i], direction=direction, k_sigma=k, trigger=trig,
                          final=final, avail_idx=(i + p.window) if final else None))
    return out


@dataclass
class _Arrays:
    close: np.ndarray
    high: np.ndarray
    low: np.ndarray
    vol: np.ndarray
    tr: np.ndarray
    tr_den: np.ndarray      # mean(TR_{t−20..t−1})
    vol_den: np.ndarray     # mean(vol_{t−20..t−1})


def _arrays(df: pd.DataFrame, p: PsaParams) -> _Arrays:
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    vol = df["volume"].to_numpy(dtype=float)
    tr = _true_range(high, low, close)
    return _Arrays(close, high, low, vol, tr, _prior_mean(tr, p.sigma_window), _prior_mean(vol, p.sigma_window))


def _metrics(a: _Arrays, s: _Shock, p: PsaParams) -> None:
    """final 충격의 원지표(level_hold·rebreak·range_norm·vol_norm). 창은 t+1..t+W, 정착 = 창의 마지막 settle 세션."""
    i, W = s.idx, p.window
    close, high, low, vol, tr = a.close, a.high, a.low, a.vol, a.tr
    win = slice(i + 1, i + W + 1)
    settle = slice(i + W - p.settle + 1, i + W + 1)

    # level_hold
    if i >= 1 and np.isfinite(close[i]) and np.isfinite(close[i - 1]) and not np.isnan(close[win]).any():
        den = close[i] - close[i - 1]
        if den != 0:
            ext = np.min(close[win]) if s.direction > 0 else np.max(close[win])
            s.level_hold = float(np.clip((ext - close[i - 1]) / den, *p.level_hold_clip))
    # rebreak
    if s.direction > 0:
        if np.isfinite(low[i]) and not np.isnan(low[win]).any():
            s.rebreak = bool(np.any(low[win] < low[i]))
    else:
        if np.isfinite(high[i]) and not np.isnan(high[win]).any():
            s.rebreak = bool(np.any(high[win] > high[i]))
    # range_norm / vol_norm — 분모 = t−20..t−1 전부 유효(엄격), 분자 = 정착 세션 전부 유효
    tr_den = a.tr_den[i]
    tr_num = _mean_all_valid(tr[settle])
    if tr_num is not None and np.isfinite(tr_den) and tr_den > 0:
        s.range_norm = float(tr_num / tr_den)
    v_den = a.vol_den[i]
    v_num = _mean_all_valid(vol[settle])
    if v_num is not None and np.isfinite(v_den) and v_den > 0:
        s.vol_norm = float(v_num / v_den)


def _score(shocks: list[_Shock], p: PsaParams) -> None:
    """psa_score·psa_z — z 기준 = 같은 스코프의 과거 final 충격(available_at ≤ t−1 ∧ shock_idx ≥ t−z_ref_window)."""
    for s in shocks:
        if not s.final:
            continue
        ref = [o for o in shocks if o.final and o.avail_idx is not None and o.avail_idx <= s.idx - 1
               and o.idx >= s.idx - p.z_ref_window]
        comps = [
            _z(s.level_hold, [o.level_hold for o in ref], p.z_ref_min_samples, p.z_clip),
            _neg(_z(None if s.rebreak is None else float(s.rebreak),
                    [None if o.rebreak is None else float(o.rebreak) for o in ref], p.z_ref_min_samples, p.z_clip)),
            _neg(_z(s.range_norm, [o.range_norm for o in ref], p.z_ref_min_samples, p.z_clip)),
            _neg(_z(s.vol_norm, [o.vol_norm for o in ref], p.z_ref_min_samples, p.z_clip)),
        ]
        avail = [c for c in comps if c is not None]
        if avail:
            s.psa_score = float(np.mean(avail))
            s.psa_z = float(s.psa_score * s.direction)


def _neg(x: Optional[float]) -> Optional[float]:
    return None if x is None else -x


def _mark_overlap(shocks: list[_Shock], p: PsaParams) -> None:
    """앞선 충격 e1의 창(t1+1..t1+W) 안에 새 충격 e2 → 양쪽 overlap_shock=True (계획서 §4 '각각 독립 레코드, overlap_shock=True')."""
    for a in range(len(shocks)):
        for b in range(a + 1, len(shocks)):
            if shocks[b].idx - shocks[a].idx <= p.window:
                shocks[a].overlap = True
                shocks[b].overlap = True
            else:
                break


def compute_psa_events(
    ohlcv_adj: pd.DataFrame,
    *,
    scopes: Iterable[str] = DEFAULT_SCOPES,
    asof: Optional[date] = None,
    params: PsaParams = PSA_CHAMPION,
    engine_ver: str = ENGINE_VER,
) -> pd.DataFrame:
    """스코프별 PSA 이벤트 테이블 (GOLD_PSA_EVENTS 컬럼). asof 지정 시 date ≤ asof 자료만 사용(그 시점의 pending/final 재현)."""
    _validate_adjusted(ohlcv_adj)
    for c in ("date", "code", "close"):
        if c not in ohlcv_adj.columns:
            raise PsaInputError(f"ohlcv missing column {c!r}")
    rows: list[dict] = []
    for scope in scopes:
        df = _scope_frame(ohlcv_adj, scope, asof)
        if df.empty:
            continue
        shocks = _detect(df, params)
        arrays = _arrays(df, params)
        for s in shocks:
            if s.final:
                _metrics(arrays, s, params)
        _score(shocks, params)
        _mark_overlap(shocks, params)
        for s in shocks:
            rows.append({
                "shock_id": f"{scope}:{s.date.isoformat()}",
                "scope": scope,
                "shock_date": s.date,
                "direction": s.direction,
                "k_sigma": s.k_sigma,
                "trigger": s.trigger,
                "status": "final" if s.final else "pending",
                "available_at": df["date"].iloc[s.avail_idx] if s.final else None,
                "level_hold": s.level_hold if s.final else None,
                "rebreak": s.rebreak if s.final else None,
                "range_norm": s.range_norm if s.final else None,
                "vol_norm": s.vol_norm if s.final else None,
                "psa_score": s.psa_score if s.final else None,
                "psa_z": s.psa_z if s.final else None,
                "overlap_shock": bool(s.overlap),
                "engine_ver": engine_ver,
            })
    out = pd.DataFrame(rows, columns=EVENT_COLUMNS)
    return _typed(out)


def _typed(out: pd.DataFrame) -> pd.DataFrame:
    out = out.copy()
    out["direction"] = out["direction"].astype("Int8")
    for c in ("k_sigma", "level_hold", "range_norm", "vol_norm", "psa_score", "psa_z"):
        out[c] = pd.to_numeric(out[c], errors="coerce").astype("Float64")
    out["rebreak"] = out["rebreak"].astype("boolean")
    out["overlap_shock"] = out["overlap_shock"].astype("boolean")
    for c in ("shock_id", "scope", "trigger", "status", "engine_ver"):
        out[c] = out[c].astype("string")
    return out


def compute_challengers(
    ohlcv_adj: pd.DataFrame,
    *,
    scopes: Iterable[str] = DEFAULT_SCOPES,
    asof: Optional[date] = None,
    names: Iterable[str] = CHALLENGER_NAMES,
    engine_ver: str = ENGINE_VER,
) -> dict[str, pd.DataFrame]:
    """challenger shadow 산출 (결합 미사용). 각 표에 `challenger` 열 추가."""
    out: dict[str, pd.DataFrame] = {}
    for name in names:
        if name not in CHALLENGERS:
            raise PsaInputError(f"unknown challenger {name!r} (registered: {CHALLENGER_NAMES})")
        ev = compute_psa_events(ohlcv_adj, scopes=scopes, asof=asof, params=CHALLENGERS[name],
                                engine_ver=f"{engine_ver}+{name}")
        ev["challenger"] = pd.Series([name] * len(ev), dtype="string")
        out[name] = ev
    return out


def events_to_arrow(events: pd.DataFrame) -> pa.Table:
    return pa.Table.from_pandas(events[EVENT_COLUMNS], schema=GOLD_PSA_EVENTS, preserve_index=False)


def challenger_to_arrow(events: pd.DataFrame) -> pa.Table:
    return pa.Table.from_pandas(events[EVENT_COLUMNS + ["challenger"]], schema=GOLD_PSA_CHALLENGER, preserve_index=False)


# ---------------------------------------------------------------------------
# 상위 결합 접점 — date 시점 상태 (final ∧ available_at ≤ date 만)
# ---------------------------------------------------------------------------

def psa_state_at(
    events: pd.DataFrame,
    asof: date,
    scope: str,
    *,
    sessions: Optional[Sequence[date]] = None,
    halflife: float = EWMA_HALFLIFE_DAYS,
) -> dict[str, Any]:
    """asof 시점 PSA 상태: status=final ∧ available_at ≤ asof ∧ psa_z 유효 인 관측의 EWMA(반감기 halflife 세션) + freshness.

    - pending 은 **어떤 값이 들어 있어도** 포함하지 않는다(상위 결합 유일 접점, MT_s(s ≤ t+4) 불사용 규칙).
    - 거리 = available_at → asof 세션 수(sessions 제공 시), 없으면 달력일(distance_unit 에 기록).
    - 반환: psa_state(None = 관측 0), n_obs, freshness, last_available_at, distance_unit, n_final_without_z.
    """
    if halflife <= 0:
        raise ValueError("halflife must be > 0")
    if not set(events["status"].dropna().unique()) <= set(STATUSES):
        raise PsaInputError(f"unknown status values {sorted(set(events['status'].dropna().unique()) - set(STATUSES))}")
    ev = events[(events["scope"].astype(str) == scope) & (events["status"] == "final")].copy()
    ev = ev[ev["available_at"].notna()]
    ev["available_at"] = pd.to_datetime(ev["available_at"]).dt.date
    ev = ev[ev["available_at"] <= asof]
    n_final_without_z = int(ev["psa_z"].isna().sum())
    ev = ev[ev["psa_z"].notna()].sort_values("available_at")
    if ev.empty:
        return {"psa_state": None, "n_obs": 0, "freshness": None, "last_available_at": None,
                "distance_unit": "sessions" if sessions is not None else "calendar_days",
                "n_final_without_z": n_final_without_z}
    if sessions is not None:
        sess = sorted({pd.Timestamp(d).date() for d in sessions})
        pos_asof = int(np.searchsorted(np.array(sess, dtype="datetime64[D]"), np.datetime64(asof), side="right")) - 1
        pos_obs = np.searchsorted(np.array(sess, dtype="datetime64[D]"),
                                  np.array(list(ev["available_at"]), dtype="datetime64[D]"), side="right") - 1
        dist = (pos_asof - pos_obs).astype(float)
        unit = "sessions"
    else:
        dist = np.array([(asof - d).days for d in ev["available_at"]], dtype=float)
        unit = "calendar_days"
    dist = np.maximum(dist, 0.0)
    w = np.power(0.5, dist / halflife)
    z = ev["psa_z"].to_numpy(dtype=float)
    return {
        "psa_state": float(np.sum(w * z) / np.sum(w)),
        "n_obs": int(len(z)),
        "freshness": float(np.power(0.5, float(dist.min()) / halflife)),
        "last_available_at": ev["available_at"].iloc[-1],
        "distance_unit": unit,
        "n_final_without_z": n_final_without_z,
    }


# ---------------------------------------------------------------------------
# 요약 (보고용)
# ---------------------------------------------------------------------------

def _dist(s: pd.Series) -> Optional[dict]:
    x = pd.to_numeric(s, errors="coerce").dropna().astype(float)
    if x.empty:
        return None
    q = x.quantile([0.1, 0.5, 0.9])
    return {"n": int(len(x)), "mean": float(x.mean()), "std": float(x.std(ddof=1)) if len(x) > 1 else None,
            "min": float(x.min()), "p10": float(q.iloc[0]), "median": float(q.iloc[1]), "p90": float(q.iloc[2]),
            "max": float(x.max())}


def summarize_events(events: pd.DataFrame) -> dict:
    out: dict[str, Any] = {"rows": int(len(events)), "engine_ver": str(events["engine_ver"].iloc[0]) if len(events) else None,
                           "scopes": {}}
    for scope, g in events.groupby("scope", sort=True):
        fin = g[g["status"] == "final"]
        out["scopes"][str(scope)] = {
            "n_shocks": int(len(g)),
            "n_final": int(len(fin)),
            "n_pending": int((g["status"] == "pending").sum()),
            "n_pos": int((g["direction"] == 1).sum()),
            "n_neg": int((g["direction"] == -1).sum()),
            "trigger": {k: int(v) for k, v in g["trigger"].value_counts().items()},
            "n_overlap": int(g["overlap_shock"].fillna(False).astype(bool).sum()),
            "date_range": [str(g["shock_date"].min()), str(g["shock_date"].max())] if len(g) else None,
            "k_sigma": _dist(g["k_sigma"]),
            "level_hold": _dist(fin["level_hold"]),
            "rebreak_rate": float(fin["rebreak"].dropna().astype(float).mean()) if fin["rebreak"].notna().any() else None,
            "range_norm": _dist(fin["range_norm"]),
            "vol_norm": _dist(fin["vol_norm"]),
            "psa_z": _dist(fin["psa_z"]),
            "psa_z_coverage_of_final": float(fin["psa_z"].notna().mean()) if len(fin) else None,
            "first_psa_z_date": str(fin.loc[fin["psa_z"].notna(), "shock_date"].min()) if fin["psa_z"].notna().any() else None,
        }
    return out
