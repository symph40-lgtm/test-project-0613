"""등급A Expected Reaction — 부품 0~2 전진 트랙 (T5-6, 계획서 §3.1 ERR_signed 행·§2.2 검증 라벨·§11 T5-6·§12.4·WORKORDER 개념 고정 "종목 독립").

**종목(스코프) 독립**: 모든 추정(Implicit EWMA·Explicit OLS·shrinkage·expected_std·q)은 (scope) 단위. 스코프 간 pooling 없음 —
한 스코프의 반응 자료를 바꿔도 다른 스코프 결과는 불변(테스트로 고정). hierarchical shrinkage(종목 pooling)는 challenger `SHRINK-H`
자리만 등록(미구현). 이벤트 단위 값(surprise·surprise_z·피처)은 스코프에 무관한 재료라 공유한다(반응 pooling 아님).

입력
- 레지스트리(silver/consensus_registry): grade=="A"·동결·consensus_value·actual_value 있는 행. surprise = actual − consensus(유형별 단위 그대로).
  surprise_z = surprise / 유형별 과거 서프라이즈 rolling std(정오표 A-1 `expected_std_rolling` 재사용, window 20, floor 0 → std 0·표본<3 → None).
  "과거" = 그 유형에서 t0_kr 가 앞선 이벤트(엄격) — 룩어헤드 없음.
- 피처(이벤트 단위, t0_kr 09:00 이전 가용 자료만): surprise_z / vix_z(^VIX 종가, 세션 d ≤ t0_kr−1 최근값의 z, 과거 120 세션 t−1까지 표본<60 None, 클립 ±3)
  / sox_shift_z(전일밤 ^SOX 수익률 — gradec.align_prev_us_session 재사용(d ≤ t−1 엄격, reused → None) — 의 z, 같은 창) / rate_change_bp(^TNX 세션 d 종가 − 5세션 전 종가, ×100 bp).
- 반응 = **Gap Reaction**(A-1R): gold/gap3g_panel 의 gap_pct (t0_kr, scope). 없으면 None (그 이벤트는 표본·라벨에서 빠진다).

산출 (스코프별·이벤트별, 과거 이벤트만 사용 = t0_kr 엄격 이전)
- Implicit  = 같은 event_type · |Δsurprise_z| < 0.8 · 최근 5건의 gap_pct EWMA(반감기 30 — **해석: 달력일 age**, 이벤트 건수가 아님) ; 표본<3 → None
- Explicit  = 최근 120건 OLS(gap ~ 1 + surprise_z + vix_z + sox_shift_z + rate_change_bp) 와 전 이력 OLS 의 shrinkage:
              β = (1−α)·β_recent + α·β_full, α = 0.5(최근 30건 R² > 0.3) / 0.8(그 외) — **해석: α = 전 이력 쪽 가중**;
              R²_30 = β_recent 모형을 최근 min(30,n)건에 적용한 결정계수. 표본(최근 120건 중 피처 완비) < 20 → None. 현재 피처 결측 → None
- 결합       = attribution_quality q(정오표 A-5 `attribution_quality` 재사용, t0 = t0_kr 09:00 KST, A1_open, 같은 scope):
              q > 0.85 → 0.7E + 0.3I / q > 0.7 → 0.5/0.5 / 그 외 0.2E + 0.8I. 한쪽만 있으면 그 값(method 로 표기), 둘 다 없으면 None
- expected_std = expected_std_rolling(같은 scope·같은 event_type 의 과거 잔차 gap − expected_gap, window 20, floor 0.1%, 표본<3 None)
- err = gap − expected_gap ; err_z = err / expected_std (클립 없음 — 캘리브레이션 검사용 원값). direction = independence.direction_of(surprise_z)
- available_at = t0_kr 15:30 KST(장 마감 — A-1R: 갭은 마감 후 상태 산출에만 사용, 사전 예측 입력 금지)

결측은 None (0 대체 금지). 상수는 config/mtpro.yaml expected_reaction.constants 와 일치 테스트.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.components.gradec import align_prev_us_session
from mtpro.components.rolling import is_finite, past_z
from mtpro.core.errata import attribution_quality, err_z_std_check, expected_std_rolling
from mtpro.events import kr_calendar as KC
from mtpro.events.independence import direction_of
from mtpro.schema import assert_t0_mode

ENGINE_VER = "expected_reaction-0.1"
GRADE = "A"
T0_MODE = "A1_open"
REACTION_BASIS = "gap_reaction"                    # A-1R Gap Reaction = gap3g.gap_pct
TIME_AXIS = "A-1R"
SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")
FEATURES: tuple[str, ...] = ("surprise_z", "vix_z", "sox_shift_z", "rate_change_bp")
METHODS: tuple[str, ...] = ("combined", "explicit_only", "implicit_only")
CHALLENGERS: tuple[str, ...] = ("SHRINK-H",)     # hierarchical shrinkage(종목 pooling) — 등록만, shadow 미구현 (계획서 §10)

SESSION_CLOSE_KST = time(15, 30)

GOLD_EXPECTED_REACTION_PATH = settings.GOLD / "expected_reaction_events.parquet"

_TS = pa.timestamp("us", tz="UTC")
GOLD_EXPECTED_REACTION_EVENTS = pa.schema([
    ("event_id", pa.string()), ("event_type", pa.string()), ("scope", pa.string()),
    ("t0_kr", pa.date32()), ("scheduled_ts_utc", _TS),
    ("consensus_value", pa.float64()), ("actual_value", pa.float64()),
    ("surprise", pa.float64()), ("surprise_std", pa.float64()), ("surprise_z", pa.float64()),
    ("direction", pa.string()),                       # good | bad | neutral | None (independence.direction_of)
    ("feature_session_date", pa.date32()),            # 피처에 쓴 미국 세션 d (≤ t0_kr−1)
    ("vix_z", pa.float64()), ("sox_shift_z", pa.float64()), ("rate_change_bp", pa.float64()),
    ("gap_pct", pa.float64()),                        # 반응 (gap3g)
    ("expected_implicit", pa.float64()), ("expected_explicit", pa.float64()),
    ("expected_gap", pa.float64()), ("expected_std", pa.float64()),
    ("err", pa.float64()), ("err_z", pa.float64()),
    ("method", pa.string()),                          # combined | explicit_only | implicit_only | None
    ("n_implicit", pa.int32()), ("n_explicit", pa.int32()), ("n_explicit_full", pa.int32()),
    ("r2_recent", pa.float64()), ("alpha", pa.float64()), ("q", pa.float64()),
    ("w_explicit", pa.float64()), ("w_implicit", pa.float64()),
    ("available_at", _TS),
    ("grade", pa.string()), ("t0_mode", pa.string()), ("reaction_basis", pa.string()), ("time_axis", pa.string()),
    ("engine_ver", pa.string()),
])


@dataclass(frozen=True)
class ExpectedReactionParams:
    """사전 등록 상수 (config/mtpro.yaml expected_reaction.constants 와 일치 테스트)."""

    surprise_std_window: int = 20                 # 유형별 과거 서프라이즈 rolling std (A-1 재사용)
    surprise_std_min_samples: int = 3
    implicit_max_delta_surprise_z: float = 0.8    # |Δsurprise_z| < 0.8
    implicit_recent_n: int = 5                    # 최근 5건
    implicit_halflife_days: float = 30.0          # EWMA 반감기 (달력일 age — 해석 기록)
    implicit_min_samples: int = 3                 # 표본 < 3 → None
    explicit_recent_n: int = 120                  # 최근 120건 OLS
    explicit_min_samples: int = 20                # 표본 < 20 → None
    explicit_r2_recent_n: int = 30                # α 판정용 R² 창
    explicit_r2_threshold: float = 0.3
    alpha_informative: float = 0.5                # R² > 0.3 → α 0.5
    alpha_default: float = 0.8                    # 그 외 0.8
    q_high: float = 0.85
    q_mid: float = 0.7
    weights_high: tuple[float, float] = (0.7, 0.3)   # (explicit, implicit) q > 0.85
    weights_mid: tuple[float, float] = (0.5, 0.5)    # q > 0.7
    weights_low: tuple[float, float] = (0.2, 0.8)    # 그 외
    expected_std_window: int = 20                 # A-1 유형별 rolling std
    expected_std_floor: float = 0.1               # % (A-1 유일 상수)
    expected_std_min_samples: int = 3
    feature_z_window_days: int = 120              # §12.4: 세션 d−1 까지 120 세션
    feature_z_min_samples: int = 60
    feature_z_clip_abs: float = 3.0
    rate_change_sessions: int = 5                 # ^TNX 5세션 변화
    max_stale_calendar_days: int = 7


def load_params(config_path: Optional[Path] = None, **overrides) -> ExpectedReactionParams:
    p = config_path or (settings.CONFIG_DIR / "mtpro.yaml")
    cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
    c = (cfg.get("expected_reaction", {}) or {}).get("constants", {}) or {}
    base = ExpectedReactionParams()
    kw: dict[str, Any] = {}
    for f in ("surprise_std_window", "surprise_std_min_samples", "implicit_max_delta_surprise_z", "implicit_recent_n",
              "implicit_halflife_days", "implicit_min_samples", "explicit_recent_n", "explicit_min_samples", "explicit_r2_recent_n",
              "explicit_r2_threshold", "alpha_informative", "alpha_default", "q_high", "q_mid", "expected_std_window",
              "expected_std_floor", "expected_std_min_samples", "feature_z_window_days", "feature_z_min_samples", "feature_z_clip_abs",
              "rate_change_sessions", "max_stale_calendar_days"):
        if f in c:
            kw[f] = type(getattr(base, f))(c[f])
    for f in ("weights_high", "weights_mid", "weights_low"):
        if f in c:
            kw[f] = (float(c[f][0]), float(c[f][1]))
    kw.update(overrides)
    return replace(base, **kw) if kw else base


class ExpectedReactionError(RuntimeError):
    """입력 결함 (loud-failure)."""


# ---------------------------------------------------------------------------
# 1) 이벤트 표 (레지스트리 → 등급A 이벤트 단위)
# ---------------------------------------------------------------------------

def _f(v: Any) -> Optional[float]:
    return float(v) if is_finite(v) else None


def _as_date(v: Any) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if hasattr(v, "date") and callable(v.date):
        try:
            return v.date()
        except Exception:  # noqa: BLE001
            return None
    if isinstance(v, str):
        return date.fromisoformat(v[:10])
    return None


def _utc(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, pd.Timestamp):
        v = v.to_pydatetime()
    if not isinstance(v, datetime):
        return None
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.astimezone(timezone.utc)


def event_table(rows: Iterable[dict[str, Any]], cal: KC.KrCalendar | None = None) -> pd.DataFrame:
    """레지스트리 행 → 등급A 이벤트 표(이벤트 단위, t0_kr 오름차순).

    포함 조건: grade=="A" ∧ frozen ∧ consensus_value·actual_value 결측 없음. (등급C·미동결·actual 미입력은 여기서 조용히 빠지지 않고
    `dropped` 사유를 attrs["dropped"] 에 남긴다.) t0_kr 는 행에 있으면 그 값, 없으면 kr_calendar.next_open_after(scheduled_ts_utc).
    반환 열: event_id, event_type, scopes(list), scheduled_ts_utc, t0_kr, consensus_value, actual_value, actual_ts, available_at, schedule_status.
    """
    recs: list[dict[str, Any]] = []
    dropped: list[dict[str, str]] = []
    for r in rows:
        eid = str(r.get("event_id"))
        why = None
        if r.get("grade") != GRADE:
            why = f"grade={r.get('grade')}"
        elif not bool(r.get("frozen")):
            why = "not_frozen"
        elif not is_finite(r.get("consensus_value")):
            why = "consensus_missing"
        elif not is_finite(r.get("actual_value")):
            why = "actual_missing"
        if why:
            dropped.append({"event_id": eid, "reason": why})
            continue
        t0 = _as_date(r.get("t0_kr"))
        sched = _utc(r.get("scheduled_ts_utc"))
        if t0 is None:
            if sched is None:
                raise ExpectedReactionError(f"{eid}: scheduled_ts_utc required to derive t0_kr")
            t0 = (cal or KC.default_calendar()).next_open_after(sched)
        scopes = [str(s) for s in (r.get("asset_scope") or [])]
        recs.append({
            "event_id": eid, "event_type": str(r.get("event_type")), "scopes": scopes, "scheduled_ts_utc": sched, "t0_kr": t0,
            "consensus_value": float(r["consensus_value"]), "actual_value": float(r["actual_value"]),
            "actual_ts": _utc(r.get("actual_ts")), "available_at": _utc(r.get("available_at")),
            "schedule_status": r.get("schedule_status"),
        })
    df = pd.DataFrame(recs, columns=["event_id", "event_type", "scopes", "scheduled_ts_utc", "t0_kr", "consensus_value", "actual_value",
                                     "actual_ts", "available_at", "schedule_status"])
    if len(df):
        df = df.sort_values(["t0_kr", "scheduled_ts_utc", "event_id"], kind="stable").reset_index(drop=True)
    df.attrs["dropped"] = dropped
    return df


def add_surprise(events: pd.DataFrame, params: Optional[ExpectedReactionParams] = None) -> pd.DataFrame:
    """surprise = actual − consensus; surprise_std = 같은 유형의 **앞선**(t0_kr 엄격 이전) 서프라이즈 rolling std(A-1); surprise_z."""
    p = params or ExpectedReactionParams()
    df = events.copy()
    n = len(df)
    sur = [float(a) - float(c) for a, c in zip(df["actual_value"], df["consensus_value"])] if n else []
    std: list[Optional[float]] = [None] * n
    z: list[Optional[float]] = [None] * n
    for i in range(n):
        et, t0 = df["event_type"].iat[i], df["t0_kr"].iat[i]
        past = [sur[j] for j in range(n) if df["event_type"].iat[j] == et and df["t0_kr"].iat[j] < t0]
        s = expected_std_rolling({et: past}, et, window=p.surprise_std_window, floor=0.0, min_samples=p.surprise_std_min_samples)
        if s is not None and s > 0:
            std[i] = s
            z[i] = sur[i] / s
    df["surprise"] = sur
    df["surprise_std"] = std
    df["surprise_z"] = z
    df["direction"] = [direction_of(v) for v in z]
    return df


# ---------------------------------------------------------------------------
# 2) 피처 (이벤트 단위, t0_kr 09:00 이전 가용 자료만)
# ---------------------------------------------------------------------------

def _series(df: pd.DataFrame, value_col: str) -> tuple[list[date], list[Optional[float]]]:
    d = df[["date", value_col]].copy()
    d["date"] = pd.to_datetime(d["date"]).dt.date
    d = d.dropna(subset=["date"]).sort_values("date").drop_duplicates("date", keep="last")
    return list(d["date"]), [_f(v) for v in d[value_col].tolist()]


def _latest_idx_before(dates: Sequence[date], t: date) -> Optional[int]:
    """세션 d < t (엄격) 중 최근 인덱스."""
    i = bisect.bisect_left(dates, t) - 1
    return i if i >= 0 else None


def build_features(events: pd.DataFrame, vix: Optional[pd.DataFrame], sox: Optional[pd.DataFrame], tnx: Optional[pd.DataFrame],
                   params: Optional[ExpectedReactionParams] = None, sessions: Optional[Sequence[date]] = None) -> pd.DataFrame:
    """이벤트별 vix_z · sox_shift_z · rate_change_bp (+ feature_session_date). 입력 프레임: vix/tnx = [date, close], sox = [date, ret_pct].
    None 프레임이면 해당 피처 전부 None(조용히 0 대체하지 않는다).
    sessions = 국내 거래일 목록(sox 정렬의 "reused" 판정은 직전 **국내 거래일** 기준이므로 이벤트 날짜만이 아니라 전 세션이 필요) —
    None 이면 XKRX 기본 캘린더에서 이벤트 구간을 가져온다."""
    p = params or ExpectedReactionParams()
    df = events.copy()
    n = len(df)
    t0s = [d for d in df["t0_kr"]] if n else []
    vix_z: list[Optional[float]] = [None] * n
    sox_z: list[Optional[float]] = [None] * n
    rate: list[Optional[float]] = [None] * n
    fsd: list[Optional[date]] = [None] * n

    if n and vix is not None and len(vix):
        vd, vv = _series(vix, "close")
        for i, t in enumerate(t0s):
            k = _latest_idx_before(vd, t)
            if k is None or (t - vd[k]).days > p.max_stale_calendar_days:
                continue
            fsd[i] = vd[k]
            vix_z[i] = past_z(vv, k, p.feature_z_window_days, p.feature_z_min_samples, p.feature_z_clip_abs)
    if n and tnx is not None and len(tnx):
        td, tv = _series(tnx, "close")
        for i, t in enumerate(t0s):
            k = _latest_idx_before(td, t)
            if k is None or (t - td[k]).days > p.max_stale_calendar_days:
                continue
            j = k - p.rate_change_sessions
            if j >= 0 and is_finite(tv[k]) and is_finite(tv[j]):
                rate[i] = (float(tv[k]) - float(tv[j])) * 100.0
            if fsd[i] is None:
                fsd[i] = td[k]
    if n and sox is not None and len(sox):
        sd, sv = _series(sox, "ret_pct")
        if sessions is None:
            cal = KC.default_calendar()
            sessions = cal.sessions_between(min(t0s) - timedelta(days=14), max(t0s))
        dom = sorted(set(KC._as_date(d) for d in sessions) | set(t0s))
        al = align_prev_us_session(dom, pd.DataFrame({"date": sd, "ret_pct": sv}), p.max_stale_calendar_days)
        by_date = {r["date"]: r for r in al.to_dict("records")}
        idx = {d: k for k, d in enumerate(sd)}
        for i, t in enumerate(t0s):
            r = by_date.get(t)
            if r is None or r["sox_align_status"] != "ok" or r["sox_ret_prev"] is None:
                continue
            k = idx.get(r["sox_session_date"])
            if k is None:
                continue
            sox_z[i] = past_z(sv, k, p.feature_z_window_days, p.feature_z_min_samples, p.feature_z_clip_abs)
            if fsd[i] is None:
                fsd[i] = r["sox_session_date"]
    df["vix_z"] = vix_z
    df["sox_shift_z"] = sox_z
    df["rate_change_bp"] = rate
    df["feature_session_date"] = fsd
    return df


# ---------------------------------------------------------------------------
# 3) 순수 추정기 (스코프 하나의 과거 이벤트만 받는다)
# ---------------------------------------------------------------------------

def implicit_expected(cur_t0: date, cur_type: str, cur_sz: Optional[float], history: Sequence[dict[str, Any]],
                      params: Optional[ExpectedReactionParams] = None) -> tuple[Optional[float], int]:
    """같은 유형·|Δsurprise_z|<0.8·최근 n건 gap 의 EWMA(달력일 반감기). 반환 (값|None, 매칭 표본 수)."""
    p = params or ExpectedReactionParams()
    if cur_sz is None:
        return None, 0
    cands = [h for h in history
             if h["event_type"] == cur_type and is_finite(h.get("surprise_z")) and is_finite(h.get("gap_pct"))
             and abs(float(h["surprise_z"]) - float(cur_sz)) < p.implicit_max_delta_surprise_z]
    cands.sort(key=lambda h: (h["t0_kr"], h["event_id"]))
    cands = cands[-p.implicit_recent_n:]
    if len(cands) < p.implicit_min_samples:
        return None, len(cands)
    ages = np.asarray([(cur_t0 - h["t0_kr"]).days for h in cands], dtype=float)
    w = 0.5 ** (ages / p.implicit_halflife_days)
    y = np.asarray([float(h["gap_pct"]) for h in cands], dtype=float)
    return float(np.sum(w * y) / np.sum(w)), len(cands)


def _design(rows: Sequence[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray]:
    X = np.asarray([[1.0] + [float(r[f]) for f in FEATURES] for r in rows], dtype=float)
    y = np.asarray([float(r["gap_pct"]) for r in rows], dtype=float)
    return X, y


def _ols(X: np.ndarray, y: np.ndarray) -> Optional[np.ndarray]:
    if X.shape[0] <= X.shape[1]:
        return None
    beta, _, rank, _ = np.linalg.lstsq(X, y, rcond=None)
    if rank < X.shape[1] or not np.all(np.isfinite(beta)):
        return None
    return beta


def _r2(X: np.ndarray, y: np.ndarray, beta: np.ndarray) -> Optional[float]:
    if y.size < 2:
        return None
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    if ss_tot <= 0:
        return None
    ss_res = float(np.sum((y - X @ beta) ** 2))
    return 1.0 - ss_res / ss_tot


def explicit_expected(cur: dict[str, Any], history: Sequence[dict[str, Any]],
                      params: Optional[ExpectedReactionParams] = None) -> dict[str, Any]:
    """최근 120건 OLS + 전 이력 OLS shrinkage. 반환 dict(value, n_recent, n_full, r2_recent, alpha)."""
    p = params or ExpectedReactionParams()
    out: dict[str, Any] = {"value": None, "n_recent": 0, "n_full": 0, "r2_recent": None, "alpha": None}
    train = [h for h in history if is_finite(h.get("gap_pct")) and all(is_finite(h.get(f)) for f in FEATURES)]
    train.sort(key=lambda h: (h["t0_kr"], h["event_id"]))
    recent = train[-p.explicit_recent_n:]
    out["n_recent"], out["n_full"] = len(recent), len(train)
    if len(recent) < p.explicit_min_samples:
        return out
    if not all(is_finite(cur.get(f)) for f in FEATURES):
        return out
    Xr, yr = _design(recent)
    b_recent = _ols(Xr, yr)
    if b_recent is None:
        return out
    Xf, yf = _design(train)
    b_full = _ols(Xf, yf)
    if b_full is None:
        return out
    m = min(p.explicit_r2_recent_n, len(recent))
    r2 = _r2(Xr[-m:], yr[-m:], b_recent)
    alpha = p.alpha_informative if (r2 is not None and r2 > p.explicit_r2_threshold) else p.alpha_default
    beta = (1.0 - alpha) * b_recent + alpha * b_full
    x = np.asarray([1.0] + [float(cur[f]) for f in FEATURES], dtype=float)
    out.update(value=float(x @ beta), r2_recent=r2, alpha=alpha)
    return out


def combine(explicit: Optional[float], implicit: Optional[float], q: Optional[float],
            params: Optional[ExpectedReactionParams] = None) -> tuple[Optional[float], Optional[str], Optional[float], Optional[float]]:
    """q 규칙 결합. 반환 (expected, method, w_explicit, w_implicit)."""
    p = params or ExpectedReactionParams()
    e_ok, i_ok = is_finite(explicit), is_finite(implicit)
    if e_ok and i_ok:
        if q is None:
            raise ExpectedReactionError("attribution_quality q required to combine explicit and implicit")
        we, wi = p.weights_high if q > p.q_high else (p.weights_mid if q > p.q_mid else p.weights_low)
        return we * float(explicit) + wi * float(implicit), "combined", we, wi
    if e_ok:
        return float(explicit), "explicit_only", 1.0, 0.0
    if i_ok:
        return float(implicit), "implicit_only", 0.0, 1.0
    return None, None, None, None


def attribution_q(events: pd.DataFrame, scope: str) -> dict[str, float]:
    """정오표 A-5 재사용: 같은 scope 이벤트, t0 = t0_kr 09:00 KST, A1_open → {event_id: q}."""
    evs = [{"event_id": r["event_id"], "t0": KC.kst(r["t0_kr"]), "t0_mode": T0_MODE, "asset_scope": scope}
           for r in events.to_dict("records") if scope in (r.get("scopes") or [])]
    return attribution_quality(evs) if evs else {}


# ---------------------------------------------------------------------------
# 4) 스코프별 산출 (독립)
# ---------------------------------------------------------------------------

def _reaction_map(reactions: Optional[pd.DataFrame], scope: str) -> dict[date, float]:
    if reactions is None or not len(reactions):
        return {}
    r = reactions[reactions["scope"].astype(str) == str(scope)]
    out: dict[date, float] = {}
    for d, g in zip(pd.to_datetime(r["date"]).dt.date, r["gap_pct"]):
        if is_finite(g):
            out[d] = float(g)
    return out


def _available_at(t0: date) -> datetime:
    return KC.kst(t0, SESSION_CLOSE_KST).astimezone(timezone.utc)


def build_scope_events(scope: str, events: pd.DataFrame, reactions: Optional[pd.DataFrame],
                       params: Optional[ExpectedReactionParams] = None) -> pd.DataFrame:
    """scope 하나. events = add_surprise ∘ build_features 출력(이벤트 단위). reactions = gap3g 패널(date, scope, gap_pct).
    이 함수는 다른 scope 의 반응을 절대 보지 않는다(스코프 독립)."""
    p = params or ExpectedReactionParams()
    assert_t0_mode(T0_MODE, scope)
    gaps = _reaction_map(reactions, scope)
    evs = [r for r in events.to_dict("records") if scope in (r.get("scopes") or [])]
    evs.sort(key=lambda r: (r["t0_kr"], r["scheduled_ts_utc"] or datetime.min.replace(tzinfo=timezone.utc), r["event_id"]))
    qmap = attribution_q(events, scope)

    done: list[dict[str, Any]] = []      # 산출 완료 행(과거 이력으로 재사용)
    out_rows: list[dict[str, Any]] = []
    for r in evs:
        t0 = r["t0_kr"]
        cur = dict(r)
        cur["gap_pct"] = gaps.get(t0)
        history = [h for h in done if h["t0_kr"] < t0]                       # 엄격 과거 (같은 t0 는 서로 이력이 아니다)
        imp, n_imp = implicit_expected(t0, cur["event_type"], cur.get("surprise_z"), history, p)
        ex = explicit_expected(cur, history, p)
        q = qmap.get(cur["event_id"])
        expected, method, we, wi = combine(ex["value"], imp, q, p)
        resid = [h["err"] for h in history if h["event_type"] == cur["event_type"] and is_finite(h.get("err"))]
        std = expected_std_rolling({cur["event_type"]: resid}, cur["event_type"], window=p.expected_std_window,
                                   floor=p.expected_std_floor, min_samples=p.expected_std_min_samples)
        err = errz = None
        if expected is not None and cur["gap_pct"] is not None:
            err = cur["gap_pct"] - expected
            if std is not None:
                errz = err / std
        row = {
            "event_id": cur["event_id"], "event_type": cur["event_type"], "scope": scope, "t0_kr": t0,
            "scheduled_ts_utc": cur.get("scheduled_ts_utc"),
            "consensus_value": cur["consensus_value"], "actual_value": cur["actual_value"],
            "surprise": cur.get("surprise"), "surprise_std": cur.get("surprise_std"), "surprise_z": cur.get("surprise_z"),
            "direction": cur.get("direction"), "feature_session_date": cur.get("feature_session_date"),
            "vix_z": cur.get("vix_z"), "sox_shift_z": cur.get("sox_shift_z"), "rate_change_bp": cur.get("rate_change_bp"),
            "gap_pct": cur["gap_pct"],
            "expected_implicit": imp, "expected_explicit": ex["value"], "expected_gap": expected, "expected_std": std,
            "err": err, "err_z": errz, "method": method,
            "n_implicit": int(n_imp), "n_explicit": int(ex["n_recent"]), "n_explicit_full": int(ex["n_full"]),
            "r2_recent": ex["r2_recent"], "alpha": ex["alpha"], "q": q, "w_explicit": we, "w_implicit": wi,
            "available_at": _available_at(t0),
            "grade": GRADE, "t0_mode": T0_MODE, "reaction_basis": REACTION_BASIS, "time_axis": TIME_AXIS, "engine_ver": ENGINE_VER,
        }
        out_rows.append(row)
        done.append({**cur, "expected_gap": expected, "err": err})
    return pd.DataFrame(out_rows, columns=[f.name for f in GOLD_EXPECTED_REACTION_EVENTS])


def build_events(events: pd.DataFrame, reactions: Optional[pd.DataFrame], params: Optional[ExpectedReactionParams] = None,
                 scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    """전 scope. 스코프별로 독립 호출해 이어 붙인다(pooling 없음)."""
    parts = [build_scope_events(sc, events, reactions, params) for sc in scopes]
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=[f.name for f in GOLD_EXPECTED_REACTION_EVENTS])
    return df


# ---------------------------------------------------------------------------
# 5) gap3g 인터페이스 (expected_gap_source=gradeA) — 순수 함수, 파일은 건드리지 않는다
# ---------------------------------------------------------------------------

def overlay_gap3g(gap3g_panel: pd.DataFrame, er_events: pd.DataFrame) -> pd.DataFrame:
    """gap3g 패널 사본에 등급A Expected Reaction 을 얹는다: 같은 (date, scope) 의 expected_gap·gap_reaction_err·gap_reaction_err_z·sigma_gap 을
    등급A 값으로 바꾸고 expected_gap_source="gradeA", grade="A", no_material_flag=False. 등급A 값이 None 이면 그 행은 등급C 그대로.
    같은 날 등급A 이벤트가 둘이면(SAME_DAY_MULTI) 둘 다 같은 expected 가 아니므로 **첫 이벤트(정렬 순)** 를 쓰고 `gradeA_event_id` 에 기록."""
    out = gap3g_panel.copy()
    if "gradeA_event_id" not in out.columns:
        out["gradeA_event_id"] = None
    if er_events is None or not len(er_events):
        return out
    er = er_events[er_events["expected_gap"].notna()].copy()
    if not len(er):
        return out
    er["date"] = pd.to_datetime(er["t0_kr"]).dt.date
    er = er.sort_values(["date", "scope", "event_id"]).drop_duplicates(["date", "scope"], keep="first")
    key = {(d, str(s)): r for d, s, r in zip(er["date"], er["scope"], er.to_dict("records"))}
    dates = pd.to_datetime(out["date"]).dt.date
    for i, (d, s) in enumerate(zip(dates, out["scope"].astype(str))):
        r = key.get((d, s))
        if r is None:
            continue
        out.iat[i, out.columns.get_loc("expected_gap")] = r["expected_gap"]
        out.iat[i, out.columns.get_loc("expected_gap_source")] = "gradeA"
        out.iat[i, out.columns.get_loc("grade")] = GRADE
        out.iat[i, out.columns.get_loc("no_material_flag")] = False
        out.iat[i, out.columns.get_loc("sigma_gap")] = r["expected_std"]
        out.iat[i, out.columns.get_loc("gap_reaction_err")] = r["err"]
        out.iat[i, out.columns.get_loc("gap_reaction_err_z")] = r["err_z"]
        out.iat[i, out.columns.get_loc("gradeA_event_id")] = r["event_id"]
    return out


# ---------------------------------------------------------------------------
# 6) I/O · 요약
# ---------------------------------------------------------------------------

def write_gold(df: pd.DataFrame, path: Path = GOLD_EXPECTED_REACTION_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = [f.name for f in GOLD_EXPECTED_REACTION_EVENTS]
    d = df.copy() if len(df) else pd.DataFrame(columns=cols)
    for c in cols:
        if c not in d.columns:
            d[c] = None
    for c in ("scheduled_ts_utc", "available_at"):
        d[c] = pd.to_datetime(d[c], utc=True) if len(d) else d[c]
    for c in ("n_implicit", "n_explicit", "n_explicit_full"):
        d[c] = pd.to_numeric(d[c], errors="coerce").astype("Int64") if len(d) else d[c]
    tbl = pa.Table.from_pandas(d[cols], schema=GOLD_EXPECTED_REACTION_EVENTS, preserve_index=False)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(tbl, tmp)
    tmp.replace(path)
    return path


def read_gold(path: Path = GOLD_EXPECTED_REACTION_PATH) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


def summarize(df: pd.DataFrame, dropped: Sequence[dict[str, str]] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"engine_ver": ENGINE_VER, "rows": int(len(df)), "n_events": int(df["event_id"].nunique()) if len(df) else 0,
                           "challengers_registered": list(CHALLENGERS), "dropped_registry_rows": list(dropped or [])}
    per: dict[str, Any] = {}
    for sc in (sorted(df["scope"].unique()) if len(df) else []):
        g = df[df["scope"] == sc]
        ez = pd.to_numeric(g["err_z"], errors="coerce").dropna()
        per[sc] = {
            "events": int(len(g)),
            "with_gap": int(g["gap_pct"].notna().sum()),
            "expected_defined": int(g["expected_gap"].notna().sum()),
            "method": {str(k): int(v) for k, v in g["method"].value_counts(dropna=False).items()},
            "err_z_defined": int(ez.size),
            "err_z_mean": float(ez.mean()) if ez.size else None,
            "err_z_std": float(ez.std(ddof=1)) if ez.size > 1 else None,
            "err_z_std_in_[0.7,1.3]": err_z_std_check(ez.tolist()),
            "direction": {str(k): int(v) for k, v in g["direction"].value_counts(dropna=False).items()},
        }
    out["scopes"] = per
    return out


__all__ = [
    "ENGINE_VER", "GRADE", "T0_MODE", "REACTION_BASIS", "SCOPES", "FEATURES", "METHODS", "CHALLENGERS",
    "GOLD_EXPECTED_REACTION_EVENTS", "GOLD_EXPECTED_REACTION_PATH", "ExpectedReactionParams", "ExpectedReactionError",
    "load_params", "event_table", "add_surprise", "build_features", "implicit_expected", "explicit_expected", "combine",
    "attribution_q", "build_scope_events", "build_events", "overlay_gap3g", "write_gold", "read_gold", "summarize",
]
