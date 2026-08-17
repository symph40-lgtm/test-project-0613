"""부품 6~7 (부분) — Energy-Lite 조립 (WORKORDER_MTPRO_v10.1 §2.1 소급 트랙, T3-D, config `energy_lite` 블록).

    "부품 6~7 (부분): Energy-Lite = f(flow, breadth, 등급C ERR) — 가중치 사전 등록 후 측정"

이 모듈은 **조립만** 한다. 컴포넌트 계산은 상류(flow.py·breadth.py·gradec.py)에서 끝났고, Energy/Delta 산식은
core.errata.energy / core.errata.delta_from_history 를 **그대로 재사용**한다 (재구현 금지, A-6·AM-2 규칙 그대로).

입력(gold, 읽기 전용):
  - flow_panel.parquet    : (date, scope, flow_impact_residual_z, ...)          — 부품 4, 스코프별
  - breadth_panel.parquet : (date, breadth_impulse_z, ...)                       — 부품 5, **시장 공통(스코프 무관)** → 각 스코프에 동일 적용
  - gradec_panel.parquet  : (date, scope, good_acceptance_z, bad_resilience_z, good_beta, bad_beta, ...) — 등급C, 스코프별

컴포넌트 정의(사전 등록 — 모듈 상수, 측정 후 변경 금지):
  - flow        = flow_impact_residual_z
  - breadth     = breadth_impulse_z (시장 공통 값을 각 스코프에 동일 적용)
  - gradec_err  = mean(good_acceptance_z, bad_resilience_z) — 둘 중 **가용한 것의 평균**, 하나만 있으면 그 값, 둘 다 None 이면 None
                  (GRADEC_ERR_DEFINITION)
  세 컴포넌트는 상류에서 이미 z 화되어 있으므로(각각 과거 120 거래일 창; config energy_lite.z_window_days=120 과 일치)
  **여기서 추가 표준화를 하지 않는다.**

Energy-Lite:
  core.errata.energy(components, weights=WEIGHTS(config energy_lite.weights 와 일치, 테스트로 검증), min_components=MIN_COMPONENTS=2)
  → 각 z 에 tanh → 가중합 ×100 → 반올림 정수 [-100,100]. None 컴포넌트는 제외 후 가중치 재정규화(합=1),
    가용 < 2 이면 None (A-6 규칙의 Lite 특례: 컴포넌트가 3개뿐이라 min 2, 사전 등록).
Delta-Lite:
  core.errata.delta_from_history(그 스코프의 energy 이력 [.. t] (과거~당일만), recent=5, hist_window=60, scale=20, min_changes=5)
  → AM-2 규칙(기준 분포 = 최근 창 이전 변화량, DELTA_SD_FLOOR=1.0) [-100,100] 정수 또는 None.

부품 8 인터페이스(AM-5 ④): 패널 자체는 아래 GOLD_ENERGY_LITE_PANEL 컬럼만 저장하고, `mt_state_records(panel)` 가
mt_state 호환 dict(energy, delta, regime_probs=None, confidence=None, good_acceptance_z, bad_resilience_z, good_beta, bad_beta)를
돌려준다. regime_probs·confidence 는 전진 트랙(완전판 6~7) 범위이므로 소급 트랙에서는 None 자리만 예약한다.

룩어헤드 없음: 날짜 t 의 energy 는 t 행의 컴포넌트만, delta 는 t 이하 energy 이력만 쓴다 (tests/test_energy_lite.py 에서 미래 행 변조 검증).
결측은 None (0 대체 금지, 불변 규칙 3).
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.core.errata import delta_from_history, energy

ENGINE_VER = "energy_lite-0.1"

# ---- 사전 등록 상수 (config energy_lite 블록과 일치해야 함 — assert_config_matches 로 검증) --------------------
SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")
COMPONENT_NAMES: tuple[str, ...] = ("flow", "breadth", "gradec_err")
WEIGHTS: dict[str, float] = {"flow": 0.3333, "breadth": 0.3333, "gradec_err": 0.3334}   # 무정보 균등 (합 = 1.0)
MIN_COMPONENTS: int = 2                  # A-6 규칙(<3 → None)의 Lite 특례: 3컴포넌트뿐이라 가용 2 이상이면 산출
Z_WINDOW_DAYS: int = 120                 # 상류 컴포넌트 z 창(flow RESID_Z 120 · breadth IMPULSE_Z 120 · gradec err_z 120). Lite 는 재표준화 없음
DELTA_PARAMS: dict[str, float | int] = {"recent": 5, "hist_window": 60, "scale": 20.0, "min_changes": 5}   # delta_from_history 기본값 = AM-2

COMPONENT_SOURCES: dict[str, str] = {   # 컴포넌트 ← 상류 gold 컬럼 (사전 등록)
    "flow": "flow_panel.flow_impact_residual_z",
    "breadth": "breadth_panel.breadth_impulse_z (market-wide, applied to every scope)",
    "gradec_err": "gradec_panel: mean(good_acceptance_z, bad_resilience_z) over available; both None -> None",
}
GRADEC_ERR_DEFINITION: str = "mean(good_acceptance_z, bad_resilience_z | available); one available -> that value; both None -> None"

MT_STATE_FIELDS: tuple[str, ...] = (      # AM-5 ④ 부품 8 shadow 인터페이스 (mt_state)
    "energy", "delta", "regime_probs", "confidence",
    "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta",
)
MT_STATE_FORWARD_ONLY: tuple[str, ...] = ("regime_probs", "confidence")   # 완전판(전진 트랙) 범위 → 소급 트랙에서는 None

GOLD_ENERGY_LITE_PANEL = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),
    ("flow_z", pa.float64()),
    ("breadth_z", pa.float64()),
    ("gradec_err_z", pa.float64()),
    ("energy_lite", pa.int32()),
    ("delta_lite", pa.int32()),
    ("available_components", pa.list_(pa.string())),
    ("n_components", pa.int32()),
    ("good_acceptance_z", pa.float64()), ("bad_resilience_z", pa.float64()),
    ("good_beta", pa.float64()), ("bad_beta", pa.float64()),
    ("engine_ver", pa.string()),
])
PANEL_COLUMNS = GOLD_ENERGY_LITE_PANEL.names

P_FLOW_PANEL = settings.GOLD / "flow_panel.parquet"
P_BREADTH_PANEL = settings.GOLD / "breadth_panel.parquet"
P_GRADEC_PANEL = settings.GOLD / "gradec_panel.parquet"
P_ENERGY_LITE_PANEL = settings.GOLD / "energy_lite_panel.parquet"


class EnergyLiteInputError(ValueError):
    """loud-failure: 입력 결손·스키마 위반·config 불일치는 조용히 넘어가지 않는다."""


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def load_config(path: Path | None = None) -> dict:
    p = path or (settings.CONFIG_DIR / "mtpro.yaml")
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def assert_config_matches(cfg: Mapping) -> dict:
    """config `energy_lite` 블록이 모듈 상수(사전 등록)와 일치하는지 검증하고 블록을 돌려준다. 불일치 → EnergyLiteInputError."""
    block = cfg.get("energy_lite")
    if not block:
        raise EnergyLiteInputError("config missing 'energy_lite' block")
    w = {str(k): float(v) for k, v in (block.get("weights") or {}).items()}
    if set(w) != set(WEIGHTS):
        raise EnergyLiteInputError(f"energy_lite.weights keys {sorted(w)} != module {sorted(WEIGHTS)}")
    for k, v in WEIGHTS.items():
        if abs(w[k] - v) > 1e-12:
            raise EnergyLiteInputError(f"energy_lite.weights[{k}]={w[k]} != module {v}")
    if abs(sum(w.values()) - 1.0) > 1e-6:
        raise EnergyLiteInputError(f"energy_lite.weights sum {sum(w.values())} != 1")
    if int(block.get("min_components", -1)) != MIN_COMPONENTS:
        raise EnergyLiteInputError(f"energy_lite.min_components={block.get('min_components')} != module {MIN_COMPONENTS}")
    if int(block.get("z_window_days", -1)) != Z_WINDOW_DAYS:
        raise EnergyLiteInputError(f"energy_lite.z_window_days={block.get('z_window_days')} != module {Z_WINDOW_DAYS}")
    scopes = tuple(str(s) for s in (block.get("scopes") or ()))
    if scopes != SCOPES:
        raise EnergyLiteInputError(f"energy_lite.scopes={scopes} != module {SCOPES}")
    return dict(block)


# ---------------------------------------------------------------------------
# 컴포넌트 조립
# ---------------------------------------------------------------------------

def _is_missing(x: object) -> bool:
    if x is None:
        return True
    try:
        return bool(pd.isna(x))
    except (TypeError, ValueError):
        return False


def gradec_err_z(good_acceptance_z: Optional[float], bad_resilience_z: Optional[float]) -> Optional[float]:
    """GRADEC_ERR_DEFINITION: 가용한 것의 평균. 둘 다 None → None (0 대체 금지)."""
    vals = [float(v) for v in (good_acceptance_z, bad_resilience_z) if not _is_missing(v)]
    if not vals:
        return None
    return float(np.mean(vals))


def _require_cols(df: pd.DataFrame, cols: Iterable[str], name: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise EnergyLiteInputError(f"{name} missing columns {missing}")


def _dates(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s).dt.date


def assemble_components(
    flow_panel: pd.DataFrame,
    breadth_panel: pd.DataFrame,
    gradec_panel: pd.DataFrame,
    scopes: Sequence[str] = SCOPES,
) -> pd.DataFrame:
    """스코프별 일별 컴포넌트 표: (date, scope, flow_z, breadth_z, gradec_err_z, good_acceptance_z, bad_resilience_z, good_beta, bad_beta).

    - 날짜 축 = 세 입력의 날짜 합집합(스코프별로 flow ∪ gradec ∪ breadth). 어느 입력에 없는 날은 그 컴포넌트 None.
    - breadth 는 scope 열이 없어도(시장 공통) 되고, 있으면 무시하지 않고 오류를 낸다(스코프별 breadth 는 사양 밖).
    - 중복 (date, scope) 는 오류 (조용히 last 를 취하지 않는다).
    """
    _require_cols(flow_panel, ("date", "scope", "flow_impact_residual_z"), "flow_panel")
    _require_cols(breadth_panel, ("date", "breadth_impulse_z"), "breadth_panel")
    _require_cols(gradec_panel, ("date", "scope", "good_acceptance_z", "bad_resilience_z"), "gradec_panel")
    if "scope" in breadth_panel.columns:
        raise EnergyLiteInputError("breadth_panel is market-wide by spec; a 'scope' column is not expected")

    fl = flow_panel[["date", "scope", "flow_impact_residual_z"]].copy()
    fl["date"] = _dates(fl["date"])
    fl["scope"] = fl["scope"].astype(str)
    fl = fl.rename(columns={"flow_impact_residual_z": "flow_z"})

    br = breadth_panel[["date", "breadth_impulse_z"]].copy()
    br["date"] = _dates(br["date"])
    br = br.rename(columns={"breadth_impulse_z": "breadth_z"})
    if br["date"].duplicated().any():
        raise EnergyLiteInputError("breadth_panel has duplicate dates")

    gc_cols = ["date", "scope", "good_acceptance_z", "bad_resilience_z"] + \
              [c for c in ("good_beta", "bad_beta") if c in gradec_panel.columns]
    gc = gradec_panel[gc_cols].copy()
    gc["date"] = _dates(gc["date"])
    gc["scope"] = gc["scope"].astype(str)
    for opt in ("good_beta", "bad_beta"):
        if opt not in gc.columns:
            gc[opt] = np.nan

    parts: list[pd.DataFrame] = []
    for sc in scopes:
        f_sc = fl[fl["scope"] == sc].drop(columns="scope")
        g_sc = gc[gc["scope"] == sc].drop(columns="scope")
        for name, d in (("flow_panel", f_sc), ("gradec_panel", g_sc)):
            if d["date"].duplicated().any():
                raise EnergyLiteInputError(f"{name} has duplicate dates for scope {sc}")
        dates = sorted(set(f_sc["date"]) | set(g_sc["date"]) | set(br["date"]))
        base = pd.DataFrame({"date": dates})
        m = base.merge(f_sc, on="date", how="left").merge(br, on="date", how="left").merge(g_sc, on="date", how="left")
        m.insert(1, "scope", sc)
        parts.append(m)
    out = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(
        columns=["date", "scope", "flow_z", "breadth_z", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"])
    for c in ("flow_z", "breadth_z", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"):
        out[c] = pd.to_numeric(out[c], errors="coerce").astype(float)
    out["gradec_err_z"] = [gradec_err_z(g, b) for g, b in zip(out["good_acceptance_z"], out["bad_resilience_z"])]
    out["gradec_err_z"] = pd.to_numeric(out["gradec_err_z"], errors="coerce").astype(float)
    return out[["date", "scope", "flow_z", "breadth_z", "gradec_err_z",
                "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"]]


# ---------------------------------------------------------------------------
# Energy-Lite / Delta-Lite
# ---------------------------------------------------------------------------

def _opt(x: object) -> Optional[float]:
    return None if _is_missing(x) else float(x)   # type: ignore[arg-type]


def compute_energy_lite_panel(
    flow_panel: pd.DataFrame,
    breadth_panel: pd.DataFrame,
    gradec_panel: pd.DataFrame,
    *,
    weights: Mapping[str, float] = WEIGHTS,
    min_components: int = MIN_COMPONENTS,
    scopes: Sequence[str] = SCOPES,
    delta_params: Mapping[str, float | int] = DELTA_PARAMS,
    engine_ver: str = ENGINE_VER,
) -> pd.DataFrame:
    """스코프별 일별 Energy-Lite 패널 (GOLD_ENERGY_LITE_PANEL 컬럼).

    - energy_lite[t] = core.errata.energy({flow, breadth, gradec_err}[t], weights, min_components)["energy"]
    - delta_lite[t]  = core.errata.delta_from_history(energy_lite[..t] (해당 스코프, 날짜 오름차순, t 포함), **delta_params)
    - available_components / n_components 는 energy() 가 돌려준 가용 목록(컴포넌트 등록 순서).
    룩어헤드 없음: t 의 값은 t 이하 행만 사용.
    """
    if set(weights) != set(COMPONENT_NAMES):
        raise EnergyLiteInputError(f"weights keys must be {COMPONENT_NAMES}, got {sorted(weights)}")
    comps_df = assemble_components(flow_panel, breadth_panel, gradec_panel, scopes=scopes)
    w = {k: float(weights[k]) for k in COMPONENT_NAMES}
    dp = dict(delta_params)

    rows: list[dict] = []
    for sc in scopes:
        g = comps_df[comps_df["scope"] == sc].sort_values("date").reset_index(drop=True)
        hist: list[Optional[int]] = []
        for r in g.itertuples(index=False):
            comps = {"flow": _opt(r.flow_z), "breadth": _opt(r.breadth_z), "gradec_err": _opt(r.gradec_err_z)}
            res = energy(comps, w, min_components=min_components)
            e = res["energy"]
            hist.append(e)
            d = delta_from_history(hist, recent=int(dp["recent"]), hist_window=int(dp["hist_window"]),
                                   scale=float(dp["scale"]), min_changes=int(dp["min_changes"]))
            rows.append({
                "date": r.date, "scope": sc,
                "flow_z": r.flow_z, "breadth_z": r.breadth_z, "gradec_err_z": r.gradec_err_z,
                "energy_lite": e, "delta_lite": d,
                "available_components": list(res["available_components"]),
                "n_components": len(res["available_components"]),
                "good_acceptance_z": r.good_acceptance_z, "bad_resilience_z": r.bad_resilience_z,
                "good_beta": r.good_beta, "bad_beta": r.bad_beta,
                "engine_ver": engine_ver,
            })
    out = pd.DataFrame(rows, columns=PANEL_COLUMNS)
    out["energy_lite"] = out["energy_lite"].astype("Int32")
    out["delta_lite"] = out["delta_lite"].astype("Int32")
    out["n_components"] = out["n_components"].astype("Int32")
    for c in ("flow_z", "breadth_z", "gradec_err_z", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"):
        out[c] = pd.to_numeric(out[c], errors="coerce").astype(float)
    out["scope"] = out["scope"].astype("string")
    out["engine_ver"] = out["engine_ver"].astype("string")
    return out


# ---------------------------------------------------------------------------
# 부품 8 shadow 인터페이스 (AM-5 ④)
# ---------------------------------------------------------------------------

def mt_state_record(row: Mapping) -> dict:
    """패널 한 행 → mt_state 호환 dict. 소급 트랙에서 채울 수 없는 regime_probs·confidence 는 None 자리만."""
    e, d = row.get("energy_lite"), row.get("delta_lite")
    return {
        "energy": None if _is_missing(e) else int(e),   # type: ignore[arg-type]
        "delta": None if _is_missing(d) else int(d),    # type: ignore[arg-type]
        "regime_probs": None,
        "confidence": None,
        "good_acceptance_z": _opt(row.get("good_acceptance_z")),
        "bad_resilience_z": _opt(row.get("bad_resilience_z")),
        "good_beta": _opt(row.get("good_beta")),
        "bad_beta": _opt(row.get("bad_beta")),
    }


def mt_state_records(panel: pd.DataFrame) -> list[dict]:
    """패널 전체 → [{date, scope, **mt_state}] (키 집합 = MT_STATE_FIELDS ∪ {date, scope})."""
    out = []
    for r in panel.to_dict("records"):
        rec = {"date": r["date"], "scope": r["scope"]}
        rec.update(mt_state_record(r))
        out.append(rec)
    return out


# ---------------------------------------------------------------------------
# I/O · 요약
# ---------------------------------------------------------------------------

def panel_to_arrow(panel: pd.DataFrame) -> pa.Table:
    df = panel[PANEL_COLUMNS].copy()
    df["available_components"] = [list(v) if isinstance(v, (list, tuple, np.ndarray)) else []
                                  for v in df["available_components"]]
    return pa.Table.from_pandas(df, schema=GOLD_ENERGY_LITE_PANEL, preserve_index=False)


def write_gold(panel: pd.DataFrame, path: Path = P_ENERGY_LITE_PANEL) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(panel_to_arrow(panel), path)
    return path


def read_gold(path: Path = P_ENERGY_LITE_PANEL) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


def summarize_panel(panel: pd.DataFrame) -> dict:
    """스코프별: 행 수·구간·energy None 비율·energy 분포·|energy|≥80 비율·delta None 비율·delta ±100 도달 비율·
    컴포넌트 3개 전부 가용 비율·가용 개수 분포·컴포넌트별 None 비율. (Gate R1 측정 아님 — 서술 통계만.)"""
    out: dict = {}
    for sc, g in panel.groupby("scope", sort=False):
        n = len(g)
        e = pd.to_numeric(g["energy_lite"], errors="coerce").dropna()
        d = pd.to_numeric(g["delta_lite"], errors="coerce").dropna()
        nc = pd.to_numeric(g["n_components"], errors="coerce").fillna(0).astype(int)
        out[str(sc)] = {
            "rows": int(n),
            "date_range": [str(g["date"].min()), str(g["date"].max())] if n else None,
            "energy_none_ratio": float(1.0 - e.size / n) if n else None,
            "energy": {"min": int(e.min()), "median": float(e.median()), "max": int(e.max()),
                       "mean": float(e.mean()), "std": float(e.std(ddof=1)) if e.size >= 2 else None} if e.size else None,
            "abs_energy_ge80_ratio": float((e.abs() >= 80).mean()) if e.size else None,
            "delta_none_ratio": float(1.0 - d.size / n) if n else None,
            "delta": {"min": int(d.min()), "median": float(d.median()), "max": int(d.max())} if d.size else None,
            "delta_pm100_ratio": float((d.abs() >= 100).mean()) if d.size else None,
            "all3_components_ratio": float((nc == 3).mean()) if n else None,
            "n_components_dist": {int(k): int(v) for k, v in nc.value_counts().sort_index().items()},
            "component_none_ratio": {c: float(g[c].isna().mean()) for c in ("flow_z", "breadth_z", "gradec_err_z")},
            "first_energy_date": str(g.loc[g["energy_lite"].notna(), "date"].min()) if e.size else None,
            "first_delta_date": str(g.loc[g["delta_lite"].notna(), "date"].min()) if d.size else None,
        }
    return out
