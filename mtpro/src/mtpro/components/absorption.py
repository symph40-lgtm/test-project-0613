"""부품 3 Shock Absorption — 장중 6점 (T5-6; WORKORDER §2.2 Amendment A-1 · 계획서 §1 "부품 3 장중 6점 A-1 유지" · §3.2 shock_absorption_z · §12.4).

시간축 **A-1** (갭 제외 — MT 의 측정 대상 = 갭 이후의 장중 소화 과정): t0 = 09:00 시가 앵커, t6 없음.
    t1 = 09:05, t3 = 09:30, t4 = 14:30, t5 = 종가 — 시점 가격 = "시작시각 < HH:MM 인 마지막 완성 1분봉의 종가"(봉 시각 = 봉 시작; 5분 넘게 비면 None),
    t2 = **재료 방향의 최대 이동**(시가 대비): 호재(direction +1) → max(high)/open−1, 악재(−1) → min(low)/open−1. (intake 검토 결함 기록 "호재는 high.max" 반영)
    각 t_k = (price_k / open_09:00 − 1)·100 (%).
    방향(그날 재료 부호) = 등급A surprise 부호(gold/expected_reaction_events, 같은 t0_kr·scope; 여러 건 부호 충돌 → None) → 없으면 등급C 전일밤 ^SOX 부호
    (gold/gap3g_panel.sox_ret_prev; reused/missing → None). 방향 None → 6점은 기록하되 t2·ratio·z None.
    absorption_ratio = 악재 1 − |t5|/|t2| , 호재 t5/t2 (t2 = 0 → None) — 계획서 §3.2 문구 그대로. (해석 기록: 악재인데 t5 > 0 으로 마감한 날은
    |t5| 때문에 ratio 가 1 아래로 내려간다 — 스펙 문구 유지, 부호 반영안은 발주자 결정 사항으로 보고.)
    half_life_min = t2 시점부터 되돌림이 |t2| 의 절반에 처음 닿는 봉까지의 분(진단 전용, 세션 내 없으면 None).
    close_acceptance(CLV)는 3G 와 중복 → 여기선 산출하지 않는다.
    shock_absorption_z = 스코프별 absorption_ratio 의 z, 과거 전용 120 세션(t−1 까지, 당일 제외), 유효 표본 < 60 None, 클립 ±3.
분봉 = data/bronze/minute (KIS, price_adjusted=False — 같은 날 안의 비율이라 수정 여부 무관, C-2 혼용 없음). 봉 수 < 300 → partial → 6점 산출 안 함.
결측은 None (0 대체 금지). 스코프 = 005930·000660 (KOSPI200 지수 분봉은 T5-6 범위 밖).
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.components.rolling import is_finite, past_z
from mtpro.schema import assert_t0_mode

ENGINE_VER = "absorption-0.1"
T0_MODE = "A1_open"
TIME_AXIS = "A-1"
SCOPES: tuple[str, ...] = ("005930", "000660")
SESSION_OPEN = "09:00"
SESSION_CLOSE = "15:30"
DIRECTION_GOOD, DIRECTION_BAD = 1, -1
GRADE_A, GRADE_C = "A", "C"
SRC_GRADE_A, SRC_GRADE_A_CONFLICT, SRC_GRADE_C, SRC_NONE = "gradeA_surprise_sign", "gradeA_conflict", "gradeC_sox_sign", None
STATE_OK, STATE_PARTIAL, STATE_MISSING, STATE_LATE_OPEN = "ok", "partial", "missing", "late_open"

GOLD_ABSORPTION_PANEL_PATH = settings.GOLD / "absorption_panel.parquet"

GOLD_ABSORPTION_PANEL = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),
    ("grade", pa.string()),                       # A | C | None
    ("direction", pa.int8()),                     # +1 호재 / −1 악재 / None
    ("material_source", pa.string()),             # gradeA_surprise_sign | gradeA_conflict | gradeC_sox_sign | None
    ("event_id", pa.string()),                    # 등급A 이벤트 id (여러 건이면 ';' 결합)
    ("sox_ret_prev", pa.float64()),               # 등급C 재료 (감사용)
    ("no_material_flag", pa.bool_()),             # gap3g 의 |expected_gap|<0.3% 표기 (등급C 방향의 강도 참고, 필터 아님)
    ("session_state", pa.string()),               # ok | partial | missing | late_open
    ("n_bars", pa.int32()),
    ("open0", pa.float64()),                      # 09:00 시가 앵커 (비수정)
    ("t1", pa.float64()), ("t2", pa.float64()), ("t3", pa.float64()), ("t4", pa.float64()), ("t5", pa.float64()),   # % vs open0
    ("t2_time", pa.string()),                     # HH:MM (극값 봉 시작)
    ("absorption_ratio", pa.float64()),
    ("half_life_min", pa.int32()),
    ("shock_absorption_z", pa.float64()),
    ("price_adjusted", pa.bool_()), ("t0_mode", pa.string()), ("time_axis", pa.string()), ("engine_ver", pa.string()),
])


@dataclass(frozen=True)
class AbsorptionParams:
    """사전 등록 상수 (config/mtpro.yaml intraday.absorption.constants 와 일치 테스트)."""

    t1: str = "09:05"
    t3: str = "09:30"
    t4: str = "14:30"
    z_window_days: int = 120
    z_min_samples: int = 60
    z_clip_abs: float = 3.0
    min_bars: int = 300
    max_price_gap_minutes: int = 5


def load_params(config_path: Optional[Path] = None, **overrides) -> AbsorptionParams:
    p = config_path or (settings.CONFIG_DIR / "mtpro.yaml")
    cfg = yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}
    c = ((cfg.get("intraday", {}) or {}).get("absorption", {}) or {}).get("constants", {}) or {}
    base = AbsorptionParams()
    kw: dict[str, Any] = {}
    for f in ("t1", "t3", "t4", "z_window_days", "z_min_samples", "z_clip_abs", "min_bars", "max_price_gap_minutes"):
        if f in c:
            kw[f] = type(getattr(base, f))(c[f])
    kw.update(overrides)
    return replace(base, **kw) if kw else base


# ---------------------------------------------------------------------------
# 순수 계산기 (하루치 봉)
# ---------------------------------------------------------------------------

def _mins(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _clean_bars(bars: pd.DataFrame) -> pd.DataFrame:
    b = bars.copy()
    b["time"] = b["time"].astype(str)
    b = b[b["time"].str.match(r"^\d{2}:\d{2}$")]
    b = b[(b["time"] >= SESSION_OPEN) & (b["time"] <= SESSION_CLOSE)]      # 정규장만 (프리·애프터 봉 제외)
    for c in ("open", "high", "low", "close"):
        b[c] = pd.to_numeric(b[c], errors="coerce")
    b = b.dropna(subset=["open", "high", "low", "close"])
    b = b[(b["open"] > 0) & (b["high"] > 0) & (b["low"] > 0) & (b["close"] > 0)]
    return b.sort_values("time").drop_duplicates("time", keep="last").reset_index(drop=True)


def price_at(bars: pd.DataFrame, hhmm: str, max_gap_minutes: int = 5) -> Optional[float]:
    """HH:MM 시점 가격 = 시작시각 < HH:MM 인 마지막 봉의 종가. 그 봉이 (HH:MM − max_gap) 보다 오래되면 None."""
    prev = bars[bars["time"] < hhmm]
    if prev.empty:
        return None
    last = prev.iloc[-1]
    if _mins(hhmm) - _mins(str(last["time"])) > max_gap_minutes:
        return None
    return float(last["close"])


def six_points(bars: pd.DataFrame, direction: Optional[int], params: Optional[AbsorptionParams] = None) -> dict[str, Any]:
    """하루치 봉 → open0, t1..t5(%), t2_time, n_bars, session_state. direction None → t2/t2_time None."""
    p = params or AbsorptionParams()
    b = _clean_bars(bars) if bars is not None else pd.DataFrame(columns=["time", "open", "high", "low", "close"])
    n = len(b)
    out: dict[str, Any] = {"open0": None, "t1": None, "t2": None, "t3": None, "t4": None, "t5": None, "t2_time": None, "n_bars": int(n),
                           "session_state": STATE_MISSING if n == 0 else (STATE_PARTIAL if n < p.min_bars else STATE_OK)}
    if n == 0 or n < p.min_bars:
        return out
    first = b.iloc[0]
    open0 = float(first["open"])
    if open0 <= 0:
        return out
    out["open0"] = open0
    late = str(first["time"]) > SESSION_OPEN
    if late:
        out["session_state"] = STATE_LATE_OPEN                    # 10:00 개장일 등: 09:05·09:30 은 개장 전 → t1·t3 None

    def pct(px: Optional[float]) -> Optional[float]:
        return None if px is None else (px / open0 - 1.0) * 100.0

    if not late:
        out["t1"] = pct(price_at(b, p.t1, p.max_price_gap_minutes))
        out["t3"] = pct(price_at(b, p.t3, p.max_price_gap_minutes))
    out["t4"] = pct(price_at(b, p.t4, p.max_price_gap_minutes))
    out["t5"] = pct(float(b.iloc[-1]["close"]))
    if direction == DIRECTION_GOOD:
        k = int(np.argmax(b["high"].to_numpy()))
        out["t2"] = pct(float(b["high"].iat[k]))
        out["t2_time"] = str(b["time"].iat[k])
    elif direction == DIRECTION_BAD:
        k = int(np.argmin(b["low"].to_numpy()))
        out["t2"] = pct(float(b["low"].iat[k]))
        out["t2_time"] = str(b["time"].iat[k])
    return out


def absorption_ratio(t2: Optional[float], t5: Optional[float], direction: Optional[int]) -> Optional[float]:
    """악재 1 − |t5|/|t2| , 호재 t5/t2. t2 = 0·결측·방향 없음 → None."""
    if direction not in (DIRECTION_GOOD, DIRECTION_BAD) or not is_finite(t2) or not is_finite(t5) or float(t2) == 0.0:
        return None
    if direction == DIRECTION_BAD:
        return 1.0 - abs(float(t5)) / abs(float(t2))
    return float(t5) / float(t2)


def half_life_minutes(bars: pd.DataFrame, open0: Optional[float], t2: Optional[float], t2_time: Optional[str],
                      direction: Optional[int]) -> Optional[int]:
    """t2 봉 이후 종가가 t2 의 절반까지 처음 되돌아온 봉까지의 분. 없으면 None."""
    if direction not in (DIRECTION_GOOD, DIRECTION_BAD) or not is_finite(t2) or float(t2) == 0.0 or not is_finite(open0) or not t2_time:
        return None
    b = _clean_bars(bars)
    after = b[b["time"] > t2_time]
    if after.empty:
        return None
    half = float(t2) / 2.0
    pcts = (after["close"].to_numpy(dtype=float) / float(open0) - 1.0) * 100.0
    hit = np.where(pcts >= half)[0] if direction == DIRECTION_BAD else np.where(pcts <= half)[0]
    if hit.size == 0:
        return None
    return int(_mins(str(after["time"].iat[int(hit[0])])) - _mins(t2_time))


# ---------------------------------------------------------------------------
# 재료 방향 표
# ---------------------------------------------------------------------------

def _sign(v: Any) -> Optional[int]:
    if not is_finite(v):
        return None
    x = float(v)
    return DIRECTION_GOOD if x > 0 else (DIRECTION_BAD if x < 0 else None)


def material_table(gap3g_panel: Optional[pd.DataFrame], er_events: Optional[pd.DataFrame], scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    """(date, scope) → grade·direction·material_source·event_id·sox_ret_prev·no_material_flag.
    등급A(expected_reaction_events: t0_kr·scope·surprise_z(없으면 surprise) 부호) 우선, 없거나 부호 0/None 이면 등급C(gap3g sox_ret_prev 부호)."""
    rows: dict[tuple[date, str], dict[str, Any]] = {}
    if gap3g_panel is not None and len(gap3g_panel):
        g = gap3g_panel[gap3g_panel["scope"].astype(str).isin([str(s) for s in scopes])]
        for r in g[["date", "scope", "sox_ret_prev", "no_material_flag"]].to_dict("records"):
            d = pd.Timestamp(r["date"]).date()
            sox = r.get("sox_ret_prev")
            nm = r.get("no_material_flag")
            rows[(d, str(r["scope"]))] = {
                "date": d, "scope": str(r["scope"]), "grade": GRADE_C if _sign(sox) is not None else None,
                "direction": _sign(sox), "material_source": SRC_GRADE_C if _sign(sox) is not None else SRC_NONE,
                "event_id": None, "sox_ret_prev": float(sox) if is_finite(sox) else None,
                "no_material_flag": (bool(nm) if nm is not None and nm == nm else None),
            }
    if er_events is not None and len(er_events):
        e = er_events[er_events["scope"].astype(str).isin([str(s) for s in scopes])].copy()
        e["date"] = pd.to_datetime(e["t0_kr"]).dt.date
        for (d, sc), grp in e.groupby(["date", "scope"], sort=True):
            signs = set()
            for r in grp.to_dict("records"):
                s = _sign(r.get("surprise_z")) if is_finite(r.get("surprise_z")) else _sign(r.get("surprise"))
                if s is not None:
                    signs.add(s)
            base = rows.get((d, str(sc)), {"date": d, "scope": str(sc), "grade": None, "direction": None, "material_source": SRC_NONE,
                                           "event_id": None, "sox_ret_prev": None, "no_material_flag": None})
            base["event_id"] = ";".join(sorted(grp["event_id"].astype(str)))
            if len(signs) == 1:
                base.update(grade=GRADE_A, direction=signs.pop(), material_source=SRC_GRADE_A)
            elif len(signs) > 1:
                base.update(grade=GRADE_A, direction=None, material_source=SRC_GRADE_A_CONFLICT)
            # signs 비어 있으면(부호 0/None) 등급C 로 둔다
            rows[(d, str(sc))] = base
    cols = ["date", "scope", "grade", "direction", "material_source", "event_id", "sox_ret_prev", "no_material_flag"]
    return pd.DataFrame(list(rows.values()), columns=cols).sort_values(["scope", "date"]).reset_index(drop=True) if rows else pd.DataFrame(columns=cols)


# ---------------------------------------------------------------------------
# 패널
# ---------------------------------------------------------------------------

def build_scope_panel(scope: str, minute: pd.DataFrame, material: pd.DataFrame, sessions: Sequence[date],
                      params: Optional[AbsorptionParams] = None) -> pd.DataFrame:
    """scope 하나. minute = BRONZE_MINUTE 행(그 scope, 여러 날), material = material_table 출력, sessions = 패널 행(세션, 오름차순).
    z 창은 sessions 순서로 센다(분봉 없는 세션도 한 행 — 값 None, 표본에서 제외)."""
    p = params or AbsorptionParams()
    assert_t0_mode(T0_MODE, scope)
    m = minute[minute["code"].astype(str) == str(scope)].copy() if minute is not None and len(minute) else pd.DataFrame(columns=["date", "time", "open", "high", "low", "close"])
    if len(m):
        m["date"] = pd.to_datetime(m["date"]).dt.date
    by_day = {d: g for d, g in m.groupby("date")} if len(m) else {}
    mat = material[material["scope"].astype(str) == str(scope)] if material is not None and len(material) else pd.DataFrame()
    mat_by = {pd.Timestamp(r["date"]).date(): r for r in mat.to_dict("records")} if len(mat) else {}

    recs: list[dict[str, Any]] = []
    for d in sorted(set(sessions)):
        mr = mat_by.get(d, {})
        direction = mr.get("direction")
        direction = int(direction) if is_finite(direction) else None
        bars = by_day.get(d)
        sp = six_points(bars, direction, p) if bars is not None else {"open0": None, "t1": None, "t2": None, "t3": None, "t4": None, "t5": None,
                                                                    "t2_time": None, "n_bars": 0, "session_state": STATE_MISSING}
        ratio = absorption_ratio(sp["t2"], sp["t5"], direction)
        hl = half_life_minutes(bars, sp["open0"], sp["t2"], sp["t2_time"], direction) if bars is not None else None
        recs.append({
            "date": d, "scope": str(scope), "grade": mr.get("grade"), "direction": direction, "material_source": mr.get("material_source"),
            "event_id": mr.get("event_id"), "sox_ret_prev": mr.get("sox_ret_prev"),
            "no_material_flag": mr.get("no_material_flag"), "session_state": sp["session_state"], "n_bars": int(sp["n_bars"]),
            "open0": sp["open0"], "t1": sp["t1"], "t2": sp["t2"], "t3": sp["t3"], "t4": sp["t4"], "t5": sp["t5"], "t2_time": sp["t2_time"],
            "absorption_ratio": ratio, "half_life_min": hl, "shock_absorption_z": None,
            "price_adjusted": False, "t0_mode": T0_MODE, "time_axis": TIME_AXIS, "engine_ver": ENGINE_VER,
        })
    ratios = [r["absorption_ratio"] for r in recs]
    for i, r in enumerate(recs):
        r["shock_absorption_z"] = past_z(ratios, i, p.z_window_days, p.z_min_samples, p.z_clip_abs)
    return pd.DataFrame(recs, columns=[f.name for f in GOLD_ABSORPTION_PANEL])


def build_panel(minute: pd.DataFrame, material: pd.DataFrame, sessions: Sequence[date], params: Optional[AbsorptionParams] = None,
                scopes: Sequence[str] = SCOPES) -> pd.DataFrame:
    parts = [build_scope_panel(sc, minute, material, sessions, params) for sc in scopes]
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=[f.name for f in GOLD_ABSORPTION_PANEL])


def write_gold(panel: pd.DataFrame, path: Path = GOLD_ABSORPTION_PANEL_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    d = panel.copy()
    for c in ("direction", "n_bars", "half_life_min"):
        d[c] = pd.to_numeric(d[c], errors="coerce").astype("Int64")
    d["no_material_flag"] = d["no_material_flag"].astype("boolean")
    tbl = pa.Table.from_pandas(d[[f.name for f in GOLD_ABSORPTION_PANEL]], schema=GOLD_ABSORPTION_PANEL, preserve_index=False)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(tbl, tmp)
    tmp.replace(path)
    return path


def read_gold(path: Path = GOLD_ABSORPTION_PANEL_PATH) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


# ---------------------------------------------------------------------------
# 요약
# ---------------------------------------------------------------------------

def _q(s: pd.Series) -> Optional[dict]:
    s = pd.to_numeric(s, errors="coerce").dropna()
    if s.empty:
        return None
    return {"n": int(s.size), "mean": float(s.mean()), "std": float(s.std(ddof=1)) if s.size > 1 else None,
            "p05": float(s.quantile(0.05)), "p50": float(s.quantile(0.5)), "p95": float(s.quantile(0.95)),
            "min": float(s.min()), "max": float(s.max())}


def summarize(panel: pd.DataFrame) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for sc, g in panel.groupby("scope", sort=False):
        d = pd.to_numeric(g["direction"], errors="coerce")
        out[str(sc)] = {
            "rows": int(len(g)), "date_range": [str(g["date"].min()), str(g["date"].max())],
            "session_state": {str(k): int(v) for k, v in g["session_state"].value_counts(dropna=False).items()},
            "grade": {str(k): int(v) for k, v in g["grade"].value_counts(dropna=False).items()},
            "direction": {"good": int((d == 1).sum()), "bad": int((d == -1).sum()), "none": int(d.isna().sum())},
            "no_material_days": int((g["no_material_flag"] == True).sum()),  # noqa: E712
            "t1": _q(g["t1"]), "t2": _q(g["t2"]), "t3": _q(g["t3"]), "t4": _q(g["t4"]), "t5": _q(g["t5"]),
            "absorption_ratio": _q(g["absorption_ratio"]),
            "absorption_ratio_good": _q(g.loc[d == 1, "absorption_ratio"]),
            "absorption_ratio_bad": _q(g.loc[d == -1, "absorption_ratio"]),
            "bad_closed_above_open": int(((d == -1) & (pd.to_numeric(g["t5"], errors="coerce") > 0)).sum()),
            "half_life_min": _q(g["half_life_min"]),
            "half_life_none_with_ratio": int((g["absorption_ratio"].notna() & g["half_life_min"].isna()).sum()),   # 세션 내 절반 되돌림 없음
            "shock_absorption_z": _q(g["shock_absorption_z"]),
            "z_defined": int(g["shock_absorption_z"].notna().sum()),
        }
    return out


__all__ = [
    "ENGINE_VER", "T0_MODE", "TIME_AXIS", "SCOPES", "GOLD_ABSORPTION_PANEL", "GOLD_ABSORPTION_PANEL_PATH", "AbsorptionParams",
    "load_params", "price_at", "six_points", "absorption_ratio", "half_life_minutes", "material_table", "build_scope_panel",
    "build_panel", "write_gold", "read_gold", "summarize",
]
