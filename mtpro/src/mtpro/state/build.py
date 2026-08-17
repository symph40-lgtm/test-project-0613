"""mt_state 조립 (계획서 §7 gold/mt_state 스키마 + family_share·cap 필드 + families_used + available_at = t 마감, T5-5).

입력(gold, 읽기 전용): gap3g_panel · transmission_panel · flow_panel · breadth_panel · semi_diffusion_panel · psa_events.
출력: mt_state 패널(스코프·일), family 패널 3종(§7 reaction/price_accept/participation), challenger shadow 표.
룩어헤드 없음: 행 t 는 t 이하 자료만 (테스트 tests/test_state_lookahead.py — 미래 행 변조·psa available_at 규칙).
"""
from __future__ import annotations

import math
from datetime import date
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from mtpro import settings
from mtpro.state import energy as EN
from mtpro.state import families as FA
from mtpro.state import outputs as OU
from mtpro.state import upper_state as US
from mtpro.state.families import ENGINE_VER

SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")

P_GAP3G = settings.GOLD / "gap3g_panel.parquet"
P_TRANSMISSION = settings.GOLD / "transmission_panel.parquet"
P_FLOW = settings.GOLD / "flow_panel.parquet"
P_BREADTH = settings.GOLD / "breadth_panel.parquet"
P_SEMI = settings.GOLD / "semi_diffusion_panel.parquet"
P_PSA = settings.GOLD / "psa_events.parquet"
P_MT_STATE = settings.GOLD / "mt_state.parquet"
P_REACTION = settings.GOLD / "reaction_panel.parquet"
P_PRICE_ACCEPT = settings.GOLD / "price_accept_panel.parquet"
P_PARTICIPATION = settings.GOLD / "participation_panel.parquet"
P_CHALLENGERS = settings.GOLD / "challengers"

INPUT_FILES = {"gap3g": P_GAP3G, "transmission": P_TRANSMISSION, "flow": P_FLOW, "breadth": P_BREADTH, "semi_diffusion": P_SEMI, "psa": P_PSA}

GOLD_MT_STATE = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),
    ("energy", pa.int32()), ("energy_confidence", pa.float64()),
    ("delta_mt", pa.int32()),
    ("good_acceptance", pa.int32()), ("good_status", pa.string()), ("good_state_confidence", pa.int32()),
    ("good_evidence_n", pa.int32()), ("good_available_evidence", pa.list_(pa.string())),
    ("bad_resilience", pa.int32()), ("bad_status", pa.string()), ("bad_state_confidence", pa.int32()),
    ("bad_evidence_n", pa.int32()), ("bad_available_evidence", pa.list_(pa.string())),
    ("regime_p_winter", pa.float64()), ("regime_p_thaw", pa.float64()), ("regime_p_spring", pa.float64()), ("regime_p_cooling", pa.float64()),
    ("regime_label", pa.string()), ("transition", pa.bool_()), ("regime_fallback", pa.string()), ("regime_conf_penalty", pa.float64()),
    ("energy_ema20", pa.float64()), ("breadth_level_z", pa.float64()),
    ("divergence", pa.float64()), ("divergence_label", pa.string()), ("z_slope_energy", pa.float64()), ("z_slope_price", pa.float64()),
    ("text", pa.string()),
    ("families_used", pa.list_(pa.string())),
    ("family_score_R", pa.float64()), ("family_score_PA", pa.float64()), ("family_score_P", pa.float64()),
    ("family_conf_R", pa.float64()), ("family_conf_PA", pa.float64()), ("family_conf_P", pa.float64()),
    ("family_share_R", pa.float64()), ("family_share_PA", pa.float64()), ("family_share_P", pa.float64()),
    ("cap_applied", pa.bool_()), ("cap_family", pa.string()), ("cap_undefined", pa.bool_()),
    ("good_beta", pa.float64()), ("bad_beta", pa.float64()),
    ("engine_ver", pa.string()), ("available_at", pa.date32()),
])
MT_STATE_COLUMNS = GOLD_MT_STATE.names

GOLD_CHALLENGER = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()), ("challenger", pa.string()),
    ("value", pa.float64()), ("label", pa.string()), ("engine_ver", pa.string()),
])
GOLD_ENERGY_CHALLENGER = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()), ("challenger", pa.string()),
    ("energy", pa.int32()), ("energy_confidence", pa.float64()), ("families_used", pa.list_(pa.string())),
    ("family_score_R", pa.float64()), ("family_score_PA", pa.float64()), ("family_score_P", pa.float64()),
    ("family_share_R", pa.float64()), ("family_share_PA", pa.float64()), ("family_share_P", pa.float64()),
    ("cap_applied", pa.bool_()), ("cap_family", pa.string()), ("cap_undefined", pa.bool_()),
    ("engine_ver", pa.string()),
])

CHALLENGER_FILES: dict[str, str] = {
    "E-ORTH": "energy_orth.parquet", "E-EQ": "energy_eq.parquet", "E-NOCAP": "energy_nocap.parquet",
    "DMT-C1": "dmt_c1.parquet", "DMT-C2": "dmt_c2.parquet",
    "DIV-C1": "div_c1.parquet", "DIV-C2": "div_c2.parquet", "DIV-C3": "div_c3.parquet", "DIV-C4": "div_c4.parquet",
}


class MtStateInputError(ValueError):
    pass


# ---------------------------------------------------------------------------
# config 일치
# ---------------------------------------------------------------------------

def load_config(path: Optional[Path] = None) -> dict:
    p = path or (settings.CONFIG_DIR / "mtpro.yaml")
    return yaml.safe_load(Path(p).read_text(encoding="utf-8")) or {}


def assert_config_matches(cfg: Mapping) -> dict:
    """config energy_family · upper_state · outputs 블록 = 모듈 사전 등록 상수. 불일치 → MtStateInputError."""
    ef = cfg.get("energy_family") or {}
    us = cfg.get("upper_state") or {}
    ou = cfg.get("outputs") or {}
    if not ef or not us or not ou:
        raise MtStateInputError("config missing energy_family / upper_state / outputs block")

    def _eq(name: str, a: Any, b: Any) -> None:
        if isinstance(a, float) or isinstance(b, float):
            if abs(float(a) - float(b)) > 1e-12:
                raise MtStateInputError(f"{name}: config {a!r} != module {b!r}")
        elif a != b:
            raise MtStateInputError(f"{name}: config {a!r} != module {b!r}")

    w = {str(k): float(v) for k, v in (ef.get("weights") or {}).items()}
    _eq("energy_family.weights", w, EN.FAMILY_WEIGHTS)
    _eq("energy_family.min_families", int(ef["min_families"]), EN.MIN_FAMILIES)
    _eq("energy_family.cap_share", float(ef["cap_share"]), EN.CAP_SHARE)
    _eq("energy_family.cap_factor", float(ef["cap_factor"]), EN.CAP_FACTOR)
    _eq("energy_family.cap_eps", float(ef["cap_eps"]), EN.CAP_EPS)
    c = ef.get("constants") or {}
    _eq("energy_family.constants.z_clip_abs", float(c["z_clip_abs"]), FA.Z_CLIP_ABS)
    _eq("energy_family.constants.z_window_days", int(c["z_window_days"]), FA.Z_WINDOW_DAYS)
    _eq("energy_family.constants.z_min_samples", int(c["z_min_samples"]), FA.Z_MIN_SAMPLES)
    _eq("energy_family.constants.ewma_halflife_sessions", float(c["ewma_halflife_sessions"]), FA.EWMA_HALFLIFE_SESSIONS)
    _eq("energy_family.constants.freshness_halflife_sessions", float(c["freshness_halflife_sessions"]), FA.FRESHNESS_HALFLIFE_SESSIONS)
    _eq("energy_family.constants.obs_window_sessions", int(c["obs_window_sessions"]), FA.OBS_WINDOW_SESSIONS)
    _eq("energy_family.constants.beta_asym_window_sessions", int(c["beta_asym_window_sessions"]), FA.BETA_ASYM_WINDOW_SESSIONS)
    _eq("energy_family.constants.beta_asym_min_n", int(c["beta_asym_min_n"]), FA.BETA_ASYM_MIN_N)
    _eq("energy_family.constants.beta_asym_clip", tuple(float(x) for x in c["beta_asym_clip"]), FA.BETA_ASYM_CLIP)
    _eq("energy_family.min_avail", {str(k): int(v) for k, v in (ef.get("min_avail") or {}).items()}, FA.FAMILY_MIN_AVAIL)
    _eq("energy_family.components", {str(k): tuple(v) for k, v in (ef.get("components") or {}).items()}, FA.FAMILY_COMPONENTS)
    _eq("energy_family.transmission_component_scopes", tuple(str(s) for s in ef.get("transmission_component_scopes") or ()),
        FA.TRANSMISSION_COMPONENT_SCOPES)
    _eq("energy_family.challengers", tuple(ef.get("challengers") or ()), EN.ENERGY_CHALLENGERS)
    _eq("energy_family.orth_order", tuple(ef.get("orth_order") or ()), EN.ORTH_ORDER)

    _eq("upper_state.n_evidence", int(us["n_evidence"]), US.N_EVIDENCE)
    _eq("upper_state.min_evidence", int(us["min_evidence"]), US.MIN_EVIDENCE)
    _eq("upper_state.good_evidence", tuple(us.get("good_evidence") or ()), US.GOOD_EVIDENCE)
    _eq("upper_state.bad_evidence", tuple(us.get("bad_evidence") or ()), US.BAD_EVIDENCE)
    _eq("upper_state.reserved_evidence", tuple(us.get("reserved_evidence") or ()), US.RESERVED_EVIDENCE)
    _eq("upper_state.beta_neutral", float(us["beta_neutral"]), US.BETA_NEUTRAL)
    _eq("upper_state.ewma_halflife_sessions", float(us["ewma_halflife_sessions"]), FA.EWMA_HALFLIFE_SESSIONS)
    _eq("upper_state.obs_window_sessions", int(us["obs_window_sessions"]), FA.OBS_WINDOW_SESSIONS)

    d = ou.get("delta") or {}
    _eq("outputs.delta", {k: (float(v) if k == "scale" else int(v)) for k, v in d.items()}, OU.DELTA_PARAMS)
    dv = ou.get("divergence") or {}
    _eq("outputs.divergence.slope_days", int(dv["slope_days"]), OU.DIV_SLOPE_DAYS)
    _eq("outputs.divergence.z_window_days", int(dv["z_window_days"]), OU.DIV_Z_WINDOW_DAYS)
    _eq("outputs.divergence.z_min_samples", int(dv["z_min_samples"]), OU.DIV_Z_MIN_SAMPLES)
    _eq("outputs.divergence.label_threshold", float(dv["label_threshold"]), OU.DIV_LABEL_THRESHOLD)
    _eq("outputs.divergence.challengers", tuple(dv.get("challengers") or ()), OU.DIV_CHALLENGERS)
    rg = ou.get("regime") or {}
    _eq("outputs.regime.ema_span", int(rg["ema_span"]), OU.REGIME_EMA_SPAN)
    _eq("outputs.regime.ema_min_obs", int(rg["ema_min_obs"]), OU.REGIME_EMA_MIN_OBS)
    _eq("outputs.regime.margin", float(rg["margin"]), OU.REGIME_MARGIN)
    _eq("outputs.regime.required_days", int(rg["required_days"]), OU.REGIME_REQUIRED_DAYS)
    _eq("outputs.regime.breadth_level_source", str(rg["breadth_level_source"]), OU.BREADTH_LEVEL_SOURCE)
    tx = ou.get("text") or {}
    _eq("outputs.text.delta_threshold", float(tx["delta_threshold"]), OU.TEXT_DELTA_THRESHOLD)
    _eq("outputs.text.state_threshold", float(tx["state_threshold"]), OU.TEXT_STATE_THRESHOLD)
    _eq("outputs.text.regime_polarity", {str(k): int(v) for k, v in (tx.get("regime_polarity") or {}).items()}, OU.REGIME_POLARITY)
    _eq("outputs.delta_challengers", tuple(ou.get("delta_challengers") or ()), OU.DMT_CHALLENGERS)
    return {"energy_family": ef, "upper_state": us, "outputs": ou}


# ---------------------------------------------------------------------------
# 스코프 조립
# ---------------------------------------------------------------------------

def _num(v: Any) -> Optional[float]:
    return float(v) if FA.is_finite(v) else None


def build_scope(
    scope: str,
    gap3g: pd.DataFrame,
    transmission: Optional[pd.DataFrame],
    flow: pd.DataFrame,
    breadth: pd.DataFrame,
    semi: pd.DataFrame,
    psa_events: Optional[pd.DataFrame],
    *,
    start: Optional[date] = None,
    end: Optional[date] = None,
) -> dict[str, pd.DataFrame]:
    """scope 하나 → {"mt_state", "reaction", "price_accept", "participation", "challengers": {name: df}}.

    start/end 는 **출력 절단만** (계산은 입력 전 구간으로 — 과거 창은 잘리지 않는다)."""
    g3 = FA.scope_rows(gap3g, scope, ["gap_pct", "gap_hold", "gap_hold_z", "close_acceptance_z", "sox_ret_prev", "expected_gap",
                                     "expected_gap_source", "gap_reaction_err_z", "grade", "close"]
                       + (["surprise_sign"] if "surprise_sign" in gap3g.columns else []))
    if end is not None:
        g3 = g3[g3["date"] <= end].reset_index(drop=True)
    dates: list[date] = list(g3["date"])
    tr = None
    if transmission is not None and scope in FA.TRANSMISSION_COMPONENT_SCOPES:
        tr = FA.scope_rows(transmission, scope, ["transmission_asym_z"])
    fl = FA.scope_rows(flow, scope, ["flow_impact_residual_z"])
    br = FA.market_rows(breadth, ["breadth_impulse_z", "above_20d_ratio"])
    sm = FA.market_rows(semi, ["semi_diffusion_z"])
    if psa_events is not None and end is not None:
        psa_events = psa_events[pd.to_datetime(psa_events["available_at"]).dt.date <= end] if len(psa_events) else psa_events

    reaction = FA.build_reaction(g3, tr, scope)
    price_accept = FA.build_price_accept(g3, psa_events, scope)
    participation = FA.build_participation(dates, fl, br, sm, scope)
    upper = US.build_upper_state(reaction, g3, fl, psa_events, scope)

    n = len(dates)
    sR = [_num(v) for v in reaction["family_score_R"]]
    sPA = [_num(v) for v in price_accept["family_score_PA"]]
    sP = [_num(v) for v in participation["family_score_P"]]
    cR = [_num(v) for v in reaction["family_conf_R"]]
    cPA = [_num(v) for v in price_accept["family_conf_PA"]]
    cP = [_num(v) for v in participation["family_conf_P"]]

    # Energy (champion) + challengers
    ener: list[dict[str, Any]] = []
    eq: list[dict[str, Any]] = []
    nocap: list[dict[str, Any]] = []
    for i in range(n):
        scores = {"R": sR[i], "PA": sPA[i], "P": sP[i]}
        confs = {"R": cR[i], "PA": cPA[i], "P": cP[i]}
        ener.append(EN.combine_families(scores, confs))
        eq.append(EN.combine_families(scores, confs, weights=EN.EQ_WEIGHTS))
        nocap.append(EN.combine_families(scores, confs, cap=False))
    orth_scores = EN.orthogonalize_scores({"R": sR, "P": sP, "PA": sPA})
    orth = [EN.combine_families({"R": orth_scores["R"][i], "PA": orth_scores["PA"][i], "P": orth_scores["P"][i]},
                                {"R": cR[i], "PA": cPA[i], "P": cP[i]}) for i in range(n)]

    energy = [e["energy"] for e in ener]
    delta = [OU.delta_mt(energy[: i + 1]) for i in range(n)]
    ln_close = [math.log(float(v)) if FA.is_finite(v) and float(v) > 0 else None for v in g3["close"]]
    div = OU.divergence_series(energy, ln_close)
    bl_map = dict(zip(br["date"], OU.breadth_level_z([_num(v) for v in br["above_20d_ratio"]])))
    breadth_level = [bl_map.get(d) for d in dates]
    bad_res = [_num(v) for v in upper["bad_resilience"]]
    reg = OU.regime_series(energy, delta, bad_res, breadth_level)

    good_acc = [_num(v) for v in upper["good_acceptance"]]
    good_conf = [_num(v) for v in upper["good_state_confidence"]]
    bad_conf = [_num(v) for v in upper["bad_state_confidence"]]
    text = [OU.compose_text(reg["label"][i], reg["probs"][i], reg["transition"][i], energy=energy[i], delta=delta[i],
                            good_acceptance=good_acc[i], good_conf=good_conf[i], bad_resilience=bad_res[i], bad_conf=bad_conf[i],
                            divergence=div["divergence"][i], divergence_label=div["label"][i]) for i in range(n)]

    rows = []
    for i in range(n):
        e = ener[i]
        pr = reg["probs"][i] or {}
        rows.append({
            "date": dates[i], "scope": scope,
            "energy": e["energy"], "energy_confidence": e["energy_confidence"], "delta_mt": delta[i],
            "good_acceptance": upper["good_acceptance"][i], "good_status": upper["good_status"][i],
            "good_state_confidence": upper["good_state_confidence"][i], "good_evidence_n": upper["good_evidence_n"][i],
            "good_available_evidence": list(upper["good_available_evidence"][i]),
            "bad_resilience": upper["bad_resilience"][i], "bad_status": upper["bad_status"][i],
            "bad_state_confidence": upper["bad_state_confidence"][i], "bad_evidence_n": upper["bad_evidence_n"][i],
            "bad_available_evidence": list(upper["bad_available_evidence"][i]),
            "regime_p_winter": pr.get("winter"), "regime_p_thaw": pr.get("thaw"), "regime_p_spring": pr.get("spring"),
            "regime_p_cooling": pr.get("cooling"),
            "regime_label": reg["label"][i], "transition": reg["transition"][i], "regime_fallback": reg["fallback"][i],
            "regime_conf_penalty": reg["penalty"][i],
            "energy_ema20": reg["energy_ema20"][i], "breadth_level_z": breadth_level[i],
            "divergence": div["divergence"][i], "divergence_label": div["label"][i],
            "z_slope_energy": div["z_slope_e"][i], "z_slope_price": div["z_slope_p"][i],
            "text": text[i],
            "families_used": list(e["families_used"]),
            "family_score_R": sR[i], "family_score_PA": sPA[i], "family_score_P": sP[i],
            "family_conf_R": cR[i], "family_conf_PA": cPA[i], "family_conf_P": cP[i],
            "family_share_R": e["shares"].get("R"), "family_share_PA": e["shares"].get("PA"), "family_share_P": e["shares"].get("P"),
            "cap_applied": bool(e["cap_applied"]), "cap_family": e["cap_family"], "cap_undefined": bool(e["cap_undefined"]),
            "good_beta": _num(reaction["good_beta"][i]), "bad_beta": _num(reaction["bad_beta"][i]),
            "engine_ver": ENGINE_VER, "available_at": dates[i],
        })
    mt = pd.DataFrame(rows, columns=MT_STATE_COLUMNS)

    # challengers
    def _energy_ch(name: str, res: list[dict[str, Any]], scores_override: Optional[dict[str, list]] = None) -> pd.DataFrame:
        recs = []
        for i in range(n):
            r = res[i]
            sc = scores_override or {"R": sR, "PA": sPA, "P": sP}
            recs.append({"date": dates[i], "scope": scope, "challenger": name, "energy": r["energy"], "energy_confidence": r["energy_confidence"],
                         "families_used": list(r["families_used"]),
                         "family_score_R": sc["R"][i], "family_score_PA": sc["PA"][i], "family_score_P": sc["P"][i],
                         "family_share_R": r["shares"].get("R"), "family_share_PA": r["shares"].get("PA"), "family_share_P": r["shares"].get("P"),
                         "cap_applied": bool(r["cap_applied"]), "cap_family": r["cap_family"], "cap_undefined": bool(r["cap_undefined"]),
                         "engine_ver": f"{ENGINE_VER}+{name}"})
        return pd.DataFrame(recs, columns=GOLD_ENERGY_CHALLENGER.names)

    def _val_ch(name: str, values: Sequence[Optional[float]], labels: Optional[Sequence[Optional[str]]] = None) -> pd.DataFrame:
        return pd.DataFrame({"date": dates, "scope": scope, "challenger": name,
                             "value": [_num(v) for v in values],
                             "label": list(labels) if labels is not None else [None] * n,
                             "engine_ver": f"{ENGINE_VER}+{name}"}, columns=GOLD_CHALLENGER.names)

    ch: dict[str, pd.DataFrame] = {
        "E-ORTH": _energy_ch("E-ORTH", orth, orth_scores),
        "E-EQ": _energy_ch("E-EQ", eq),
        "E-NOCAP": _energy_ch("E-NOCAP", nocap),
        "DMT-C1": _val_ch("DMT-C1", OU.delta_c1(energy)),
        "DMT-C2": _val_ch("DMT-C2", [OU.delta_c2(energy[: i + 1]) for i in range(n)]),
    }
    for name, d in OU.divergence_challengers(energy, ln_close).items():
        ch[name] = _val_ch(name, d["divergence"], d["label"])

    out = {"mt_state": mt, "reaction": reaction, "price_accept": price_accept, "participation": participation, "upper": upper,
           "challengers": ch}
    if start is not None:
        for k in ("mt_state", "reaction", "price_accept", "participation", "upper"):
            out[k] = out[k][out[k]["date"] >= start].reset_index(drop=True)
        out["challengers"] = {k: v[v["date"] >= start].reset_index(drop=True) for k, v in ch.items()}
    return out


def build_all(
    gap3g: pd.DataFrame,
    transmission: Optional[pd.DataFrame],
    flow: pd.DataFrame,
    breadth: pd.DataFrame,
    semi: pd.DataFrame,
    psa_events: Optional[pd.DataFrame],
    *,
    scopes: Sequence[str] = SCOPES,
    start: Optional[date] = None,
    end: Optional[date] = None,
) -> dict[str, Any]:
    parts: dict[str, list[pd.DataFrame]] = {"mt_state": [], "reaction": [], "price_accept": [], "participation": [], "upper": []}
    ch: dict[str, list[pd.DataFrame]] = {}
    for sc in scopes:
        r = build_scope(sc, gap3g, transmission, flow, breadth, semi, psa_events, start=start, end=end)
        for k in parts:
            parts[k].append(r[k])
        for k, v in r["challengers"].items():
            ch.setdefault(k, []).append(v)
    out: dict[str, Any] = {k: pd.concat(v, ignore_index=True) for k, v in parts.items()}
    out["challengers"] = {k: pd.concat(v, ignore_index=True) for k, v in ch.items()}
    return out


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def _prep_dates(df: pd.DataFrame, cols: Sequence[str]) -> pd.DataFrame:
    df = df.copy()
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c]).dt.date
    return df


def write_mt_state(mt: pd.DataFrame, path: Path = P_MT_STATE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    df = mt[MT_STATE_COLUMNS].copy()
    df = df.astype(object).where(pd.notna(df), None)
    tbl = pa.Table.from_pandas(df, schema=GOLD_MT_STATE, preserve_index=False)
    pq.write_table(tbl, path)
    return path


def write_family_panels(res: Mapping[str, pd.DataFrame], gold_dir: Path = settings.GOLD) -> dict[str, Path]:
    gold_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for key, fname in (("reaction", "reaction_panel.parquet"), ("price_accept", "price_accept_panel.parquet"),
                       ("participation", "participation_panel.parquet"), ("upper", "upper_state_panel.parquet")):
        df = res[key].copy()
        for c in df.columns:
            if df[c].dtype == object and df[c].map(lambda v: isinstance(v, list)).any():
                df[c] = df[c].map(lambda v: list(v) if isinstance(v, list) else v)
        df["engine_ver"] = ENGINE_VER
        p = gold_dir / fname
        pq.write_table(pa.Table.from_pandas(df, preserve_index=False), p)
        out[key] = p
    return out


def write_challengers(ch: Mapping[str, pd.DataFrame], directory: Path = P_CHALLENGERS) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, df in ch.items():
        p = directory / CHALLENGER_FILES[name]
        schema = GOLD_ENERGY_CHALLENGER if name.startswith("E-") else GOLD_CHALLENGER
        d = df[schema.names].copy().astype(object).where(pd.notna(df[schema.names]), None)
        pq.write_table(pa.Table.from_pandas(d, schema=schema, preserve_index=False), p)
        out[name] = p
    return out


def read_inputs(files: Mapping[str, Path] = INPUT_FILES) -> dict[str, pd.DataFrame]:
    missing = [k for k, p in files.items() if not Path(p).exists()]
    if missing:
        raise MtStateInputError(f"missing gold inputs {missing}")
    return {k: pq.read_table(p).to_pandas() for k, p in files.items()}


# ---------------------------------------------------------------------------
# 요약 (보고용)
# ---------------------------------------------------------------------------

def _dist(s: pd.Series) -> Optional[dict]:
    x = pd.to_numeric(s, errors="coerce").dropna().astype(float)
    if x.empty:
        return None
    q = x.quantile([0.05, 0.25, 0.5, 0.75, 0.95])
    return {"n": int(len(x)), "mean": round(float(x.mean()), 3), "std": round(float(x.std(ddof=1)), 3) if len(x) > 1 else None,
            "min": float(x.min()), "p05": round(float(q.iloc[0]), 3), "p25": round(float(q.iloc[1]), 3), "p50": round(float(q.iloc[2]), 3),
            "p75": round(float(q.iloc[3]), 3), "p95": round(float(q.iloc[4]), 3), "max": float(x.max())}


def summarize(mt: pd.DataFrame, challengers: Optional[Mapping[str, pd.DataFrame]] = None) -> dict:
    out: dict[str, Any] = {"rows": int(len(mt)), "engine_ver": ENGINE_VER, "scopes": {}}
    for sc, g in mt.groupby("scope", sort=False):
        n = len(g)
        e = pd.to_numeric(g["energy"], errors="coerce")
        fam_used = g["families_used"].map(lambda v: tuple(v) if v is not None else ())
        text = g["text"].dropna()
        lab = g["regime_label"]
        d: dict[str, Any] = {
            "rows": int(n), "date_range": [str(g["date"].min()), str(g["date"].max())],
            "energy_none_ratio": round(float(e.isna().mean()), 4),
            "energy": _dist(e),
            "energy_confidence": _dist(g["energy_confidence"]),
            "families_used_freq": {"+".join(k) if k else "(none)": int(v) for k, v in fam_used.value_counts().items()},
            "n_families_3_ratio": round(float((fam_used.map(len) == 3).mean()), 4),
            "cap_applied_ratio_of_defined": (round(float(g.loc[e.notna(), "cap_applied"].astype(bool).mean()), 4) if e.notna().any() else None),
            "cap_family_freq": {str(k): int(v) for k, v in g["cap_family"].value_counts(dropna=True).items()},
            "cap_undefined_n": int(g["cap_undefined"].astype(bool).sum()),
            "family_share": {f: _dist(g[f"family_share_{f}"]) for f in ("R", "PA", "P")},
            "family_score": {f: _dist(g[f"family_score_{f}"]) for f in ("R", "PA", "P")},
            "family_conf": {f: _dist(g[f"family_conf_{f}"]) for f in ("R", "PA", "P")},
            "family_none_ratio": {f: round(float(pd.to_numeric(g[f"family_score_{f}"], errors="coerce").isna().mean()), 4) for f in ("R", "PA", "P")},
            "delta_mt": _dist(g["delta_mt"]),
            "delta_none_ratio": round(float(pd.to_numeric(g["delta_mt"], errors="coerce").isna().mean()), 4),
            "good_acceptance": _dist(g["good_acceptance"]),
            "good_none_ratio": round(float(pd.to_numeric(g["good_acceptance"], errors="coerce").isna().mean()), 4),
            "good_status_freq": {str(k): int(v) for k, v in g["good_status"].value_counts(dropna=False).items()},
            "good_state_confidence": _dist(g["good_state_confidence"]),
            "good_evidence_n": _dist(g["good_evidence_n"]),
            "good_available_evidence_freq": {str(k): int(v) for k, v in g["good_available_evidence"].map(lambda v: "+".join(v)).value_counts().head(8).items()},
            "bad_resilience": _dist(g["bad_resilience"]),
            "bad_none_ratio": round(float(pd.to_numeric(g["bad_resilience"], errors="coerce").isna().mean()), 4),
            "bad_status_freq": {str(k): int(v) for k, v in g["bad_status"].value_counts(dropna=False).items()},
            "bad_state_confidence": _dist(g["bad_state_confidence"]),
            "bad_evidence_n": _dist(g["bad_evidence_n"]),
            "bad_available_evidence_freq": {str(k): int(v) for k, v in g["bad_available_evidence"].map(lambda v: "+".join(v)).value_counts().head(8).items()},
            "regime_label_freq": {str(k): int(v) for k, v in lab.value_counts(dropna=False).items()},
            "regime_transitions": int(g["transition"].fillna(False).astype(bool).sum()),
            "regime_fallback_freq": {str(k): int(v) for k, v in g["regime_fallback"].value_counts(dropna=False).items()},
            "regime_first_date": str(g.loc[lab.notna(), "date"].min()) if lab.notna().any() else None,
            "divergence": _dist(g["divergence"]),
            "divergence_none_ratio": round(float(pd.to_numeric(g["divergence"], errors="coerce").isna().mean()), 4),
            "divergence_label_freq": {str(k): int(v) for k, v in g["divergence_label"].value_counts(dropna=False).items()},
            "text_n": int(len(text)),
            "text_contrary_ratio": round(float(text.str.contains(" / 그러나 ").mean()), 4) if len(text) else None,
            "text_examples": text[text.str.contains(" / 그러나 ")].drop_duplicates().head(3).tolist() if len(text) else [],
        }
        if challengers:
            d["challengers"] = {}
            for name, cdf in challengers.items():
                c = cdf[cdf["scope"] == sc]
                if name.startswith("E-"):
                    ce = pd.to_numeric(c["energy"], errors="coerce")
                    both = pd.concat([e.reset_index(drop=True), ce.reset_index(drop=True)], axis=1).dropna()
                    d["challengers"][name] = {"energy": _dist(ce), "corr_with_champion": (round(float(both.iloc[:, 0].corr(both.iloc[:, 1])), 4) if len(both) > 2 else None),
                                              "cap_applied_ratio": round(float(c["cap_applied"].astype(bool).mean()), 4)}
                else:
                    d["challengers"][name] = {"value": _dist(c["value"]), "label_freq": {str(k): int(v) for k, v in c["label"].value_counts(dropna=False).items()}}
        out["scopes"][str(sc)] = d
    return out
