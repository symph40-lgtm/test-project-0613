"""Gate R1 — 소급 트랙 정보성 측정 (T4). 사전 등록 문서 `docs/mtpro-t4-gate-r1-prereg.md` 의 연산 정의를 그대로 구현한다.

규칙(사전 등록 문서 §1~§6, WORKORDER_MTPRO_v10.1 §3 Gate R1):
- PASS 조건·정의·구간·시드는 이 모듈에서 바꾸지 않는다. `PREREG` 는 문서 §6 yaml 블록과 **완전 일치**해야 하며,
  `assert_prereg_matches()` 가 불일치 시 예외를 던져 측정을 중단한다.
- 통계: IC = Spearman(신호[t], 라벨[t]) — 라벨은 선행 수익률(r1 = 익일, r21 = 21거래일). 유의성 = 정상 블록 부트스트랩
  (Politis–Romano stationary bootstrap, 평균 블록 길이 = 지평별 등록값, 2,000회, seed 20260817, numpy default_rng) 95% percentile CI.
  random control = 신호 순열 2,000회 → 귀무 분포 백분위(보고 의무, 판정 조건 아님).
- 표본: 신호·라벨 모두 non-None 인 t 만, 신호일 t ∈ 관문 구간(라벨은 구간 밖 허용). 스코프별 유효 n < 500 → "판정 불가".
- 부분 충족 = FAIL. 결과 문구: PASS / FAIL / 판정 불가.
- 룩어헤드(P4): (a) 절단 재산출 — 무작위 12 절단일마다 bronze 를 절단일 이하로 자른 임시 데이터 디렉토리에 전 파이프라인
  (build_flow → build_breadth → build_gradec(--no-fetch) → build_energy_lite) 을 `MTPRO_DATA_DIR` 로 재실행, 절단일 이하 행 비트 동일 비교.
  (b) gradec sox_session_date ≤ t−1 (c) bronze fetch_ts ≤ 산출 시각.
- 결측(P5): z·β·energy 컬럼의 정확히 0.0 비율, 첫 유효일 이전 None, 컴포넌트 경로 grep.

해석 기록(문서가 명시하지 않은 세부는 가장 엄격한 쪽을 택함 — 결과 문서 §해석 기록에 동일 내용 수록): `INTERPRETATIONS`.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import yaml

from mtpro import settings

# ---------------------------------------------------------------------------
# 사전 등록 상수 (docs/mtpro-t4-gate-r1-prereg.md §6 yaml 블록과 완전 일치 — assert_prereg_matches 로 대조)
# ---------------------------------------------------------------------------
PREREG: dict = {
    "gate_r1": {
        "window": [dt.date(2023, 1, 3), dt.date(2026, 6, 30)],
        "horizons": {"flow": 1, "breadth": 21, "energy": 21, "energy_aux": 5},
        "signs": {"flow": "pos", "breadth": "pos", "energy": "pos"},
        "ic": "spearman",
        "bootstrap": {"kind": "stationary_block", "block": {1: 10, 21: 21}, "n": 2000, "ci": 0.95, "seed": 20260817},
        "permutation": {"n": 2000, "seed": 20260817},
        "baseline_corr_max": 0.9,
        "min_valid_n": 500,
        "lookahead_truncation": {"n_cutoffs": 12, "seed": 20260817},
        "zero_share_max": 0.005,
        "folds_descriptive": [2023, 2024, 2025, "2026H1"],
    }
}
G = PREREG["gate_r1"]
WINDOW: tuple[dt.date, dt.date] = (G["window"][0], G["window"][1])
SEED: int = G["bootstrap"]["seed"]
N_BOOT: int = G["bootstrap"]["n"]
CI_LEVEL: float = G["bootstrap"]["ci"]
BLOCK: dict[int, int] = dict(G["bootstrap"]["block"])
N_PERM: int = G["permutation"]["n"]
PERM_SEED: int = G["permutation"]["seed"]
MIN_VALID_N: int = G["min_valid_n"]
BASELINE_CORR_MAX: float = G["baseline_corr_max"]
N_CUTOFFS: int = G["lookahead_truncation"]["n_cutoffs"]
CUTOFF_SEED: int = G["lookahead_truncation"]["seed"]
ZERO_SHARE_MAX: float = G["zero_share_max"]
FOLDS: tuple = tuple(G["folds_descriptive"])
H_FLOW, H_BREADTH, H_ENERGY, H_ENERGY_AUX = (G["horizons"][k] for k in ("flow", "breadth", "energy", "energy_aux"))

SCOPES: tuple[str, ...] = ("KOSPI200", "005930", "000660")
MARKET_SCOPE = "KOSPI200"
DOC_PREREG = settings.ROOT / "docs" / "mtpro-t4-gate-r1-prereg.md"
DOC_RESULT = settings.ROOT / "docs" / "mtpro-t4-gate-r1-result.md"
SUMMARY_JSON = settings.LOG_DIR / "gate_r1_summary.json"

PASS, FAIL, UNDECIDABLE = "PASS", "FAIL", "판정 불가"

INTERPRETATIONS: list[str] = [
    "표본 분모: 유효 n 은 신호·라벨 모두 non-None 인 t (신호일 ∈ 관문 구간). 전체 대비 비율의 분모 = 해당 스코프의 관문 구간 신호 행 수.",
    "P1 r[t+1]: 각 스코프 수정 종가(bronze ohlcv_adj, KOSPI200 = 지수 1028) 달력상 t 의 **다음 거래일** 수익률 %. "
    "t = 2026-06-30 의 라벨은 2026-07-01 (구간 밖 허용). P2·P3-b r21[t] = close[t+21]/close[t]−1 (거래일 21개 앞), 라벨 없는 말미 t 는 표본 제외.",
    "부트스트랩: 정상 블록 부트스트랩(Politis–Romano), 블록 길이 ~ Geometric(p=1/평균 블록), 시계열 순서의 (신호, 라벨) 쌍을 함께 재표집(원형 wrap), "
    "각 복제본에서 Spearman 재계산 → 2.5/97.5 percentile. numpy default_rng(20260817), 측정 항목(P1 각 스코프, P2, P3-b 각 스코프)마다 동일 시드로 초기화(재현성).",
    "순열 귀무 백분위 = 귀무 IC 중 관측 IC **미만**인 비율 ×100 (동률은 미만으로 세지 않음 — 관측치에 불리한 쪽).",
    "P3-a Pearson 상관의 표본 = energy_lite 와 baseline 이 모두 non-None 인 관문 구간 t. baseline① MA20·MA60 은 완전 창(20·60개 전부 유효)만 산출(과거만, t 포함).",
    "P4(a) 절단: bronze 7종은 date/asof ≤ 절단일. ^SOX(sox_daily)는 **date ≤ 절단일−1** (미국 세션 d 는 d+1 새벽 KST 종료 → 절단일 세션은 절단일 시점에 존재하지 않음; "
    "gradec 정렬 규칙 d ≤ t−1 과 정합. 더 엄격한 쪽). 비교 대상 = 4 gold 패널의 절단일 이하 행 전부, 키 = (date, scope)/(date), 제외 컬럼 = engine_ver 만. "
    "비트 동일 = float 는 NaN 위치 동일 + 비-NaN 값의 IEEE 비트 동일(−0.0 ≠ 0.0), 그 외 컬럼은 값(None 포함) 동일. 절단본에 없는 행도 위반으로 센다.",
    "P4(a) 재실행 잡: build_gradec 는 --no-fetch --wait-minutes 0 (ingest 재실행 없음), C-1 대사(reconcile_flow) 제외. build_flow 가 docs/mtpro-t3a-ingest.md·logs/flow_panel_summary.json 을 "
    "덮어쓰므로 실행 전 스냅샷 → 종료 후 원복(try/finally).",
    "P4(c) '산출 시각' = data/gold 4 패널 파일 mtime 중 **가장 이른** 것(UTC 환산). 위반 = bronze 8 파일 어느 행이든 fetch_ts 가 그보다 늦음.",
    "P5(i) 0.0 비율의 분모 = 해당 컬럼의 non-None 값 수(더 엄격). energy_lite 는 tanh 가중합×100 반올림 정수라 정확히 0 이 계산값으로 나올 수 있어, 0 행마다 "
    "가용 컴포넌트 ≥ min_components 이고 컴포넌트 z 로 재계산한 energy 가 0 임을 확인해 '원천 값이 실제 0' 소명으로 삼는다.",
    "P5(ii) '첫 유효일 이전 None' — 모든 컬럼: 첫 non-None 행 이전 값 전부 None. 워밍업 하한을 원천 시작일로부터 증명할 수 있는 flow_panel 만 하한을 건다"
    "(수급 원천 2023-01-03 시작: β·잔차 z 는 선행 None ≥ 78행(정규화 20일 → index 19 부터 유효, β 60 관측 → index 78), trend_z ≥ 83행(5일 기울기 index 23 부터 + 당일 제외 60개 기준)). breadth(2022 lookback)·gradec(2022 ohlcv·2022-12 SOX)·energy 는 상류 워밍업이 구간 앞에 있어 하한 없이 서술.",
    "P5(iii) grep 범위 = src/mtpro/components/*.py 전체(문서 '컴포넌트 경로'의 가장 넓은 읽기) + 보조로 src/mtpro/core·jobs/build_*.py. 패턴: fillna(0…), fillna(value=0), nan_to_num, "
    "`or 0`/`or 0.0`, replace(nan/None → 0). 히트가 하나라도 있으면 (iii) 미충족으로 적는다(용도가 보고용이더라도 문서 문구 그대로; 판단은 발주자).",
    "판정 집계: P1~P5 전부 PASS 일 때만 최종 PASS. 하나라도 '판정 불가' 이고 FAIL 이 없으면 최종 '판정 불가', FAIL 이 하나라도 있으면 최종 FAIL.",
]


class PreregMismatch(AssertionError):
    """사전 등록 문서의 상수 블록과 코드 상수가 다르다 — 측정 중단."""


class GateR1Error(RuntimeError):
    """loud-failure."""


# ---------------------------------------------------------------------------
# 사전 등록 대조
# ---------------------------------------------------------------------------
_YAML_BLOCK = re.compile(r"```yaml\s*\n(.*?)\n```", re.S)


def extract_prereg_block(doc_text: str) -> dict:
    blocks = _YAML_BLOCK.findall(doc_text)
    hits = [b for b in blocks if b.lstrip().startswith("gate_r1:")]
    if len(hits) != 1:
        raise PreregMismatch(f"expected exactly one ```yaml gate_r1 block in prereg doc, found {len(hits)}")
    parsed = yaml.safe_load(hits[0])
    if not isinstance(parsed, dict):
        raise PreregMismatch("prereg yaml block did not parse to a mapping")
    return parsed


def assert_prereg_matches(doc_path: Path | str = DOC_PREREG) -> dict:
    """문서 §6 yaml 블록 == PREREG (완전 일치). 불일치 → PreregMismatch (측정 중단)."""
    p = Path(doc_path)
    if not p.exists():
        raise PreregMismatch(f"prereg doc missing: {p}")
    parsed = extract_prereg_block(p.read_text(encoding="utf-8"))
    if parsed != PREREG:
        raise PreregMismatch(f"prereg block != code PREREG\n doc : {parsed}\n code: {PREREG}")
    return parsed


# ---------------------------------------------------------------------------
# 통계 — Spearman · 정상 블록 부트스트랩 · 순열
# ---------------------------------------------------------------------------

def rank_avg(a: np.ndarray) -> np.ndarray:
    """평균 순위(동률 = 평균). 1-D 또는 2-D(행별)."""
    a = np.asarray(a, dtype=float)
    if a.ndim == 1:
        return pd.Series(a).rank(method="average").to_numpy()
    return pd.DataFrame(a).rank(axis=1, method="average").to_numpy()


def _pearson_rows(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """행별 Pearson (x, y 2-D 동형)."""
    xc = x - x.mean(axis=1, keepdims=True)
    yc = y - y.mean(axis=1, keepdims=True)
    num = (xc * yc).sum(axis=1)
    den = np.sqrt((xc ** 2).sum(axis=1) * (yc ** 2).sum(axis=1))
    with np.errstate(invalid="ignore", divide="ignore"):
        r = num / den
    return r


def pearson(x: Sequence[float], y: Sequence[float]) -> float:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 3:
        return float("nan")
    return float(_pearson_rows(x[None, :], y[None, :])[0])


def spearman(x: Sequence[float], y: Sequence[float]) -> float:
    """Spearman ρ = Pearson(rank x, rank y). n<3 → nan."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 3:
        return float("nan")
    return pearson(rank_avg(x), rank_avg(y))


def stationary_bootstrap_indices(n: int, mean_block: float, n_boot: int, rng: np.random.Generator) -> np.ndarray:
    """Politis–Romano 정상 블록 부트스트랩 인덱스 (n_boot × n). 각 위치에서 확률 p=1/mean_block 로 새 블록 시작(균등 무작위 시작점),
    아니면 직전 인덱스+1 (원형 wrap)."""
    if n <= 0:
        raise ValueError("n must be positive")
    p = 1.0 / float(mean_block)
    idx = np.empty((n_boot, n), dtype=np.int64)
    idx[:, 0] = rng.integers(0, n, size=n_boot)
    for t in range(1, n):
        new_start = rng.random(n_boot) < p
        starts = rng.integers(0, n, size=n_boot)
        idx[:, t] = np.where(new_start, starts, (idx[:, t - 1] + 1) % n)
    return idx


def bootstrap_ci(x: Sequence[float], y: Sequence[float], mean_block: float, n_boot: int = N_BOOT, seed: int = SEED,
                 ci: float = CI_LEVEL) -> dict:
    """정상 블록 부트스트랩 percentile CI of Spearman(x, y). (x, y) 쌍을 함께 재표집."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    rng = np.random.default_rng(seed)
    idx = stationary_bootstrap_indices(n, mean_block, n_boot, rng)
    xr = rank_avg(x[idx])
    yr = rank_avg(y[idx])
    boots = _pearson_rows(xr, yr)
    alpha = (1.0 - ci) / 2.0
    lo, hi = np.nanpercentile(boots, [100 * alpha, 100 * (1 - alpha)])
    return {"ci_lo": float(lo), "ci_hi": float(hi), "boot_mean": float(np.nanmean(boots)), "boot_sd": float(np.nanstd(boots, ddof=1)),
            "n_boot": int(n_boot), "block": float(mean_block), "seed": int(seed), "n_nan_boot": int(np.isnan(boots).sum())}


def permutation_null(x: Sequence[float], y: Sequence[float], n_perm: int = N_PERM, seed: int = PERM_SEED) -> dict:
    """신호 x 순열 n_perm 회 → Spearman 귀무 분포. 관측 IC 의 백분위(귀무 < 관측 비율 ×100)."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    obs = spearman(x, y)
    rng = np.random.default_rng(seed)
    rx = rank_avg(x)
    ry = rank_avg(y)
    perm = rng.permuted(np.tile(rx, (n_perm, 1)), axis=1)
    null = _pearson_rows(perm, np.tile(ry, (n_perm, 1)))
    pct = float(100.0 * np.mean(null < obs))
    p_two = float(np.mean(np.abs(null) >= abs(obs)))
    return {"observed": float(obs), "null_percentile": pct, "null_mean": float(np.mean(null)), "null_sd": float(np.std(null, ddof=1)),
            "p_two_sided": p_two, "n_perm": int(n_perm), "seed": int(seed)}


# ---------------------------------------------------------------------------
# 데이터 적재 · 라벨 · baseline
# ---------------------------------------------------------------------------
GOLD_FILES = ("flow_panel", "breadth_panel", "gradec_panel", "energy_lite_panel")
BRONZE_FILES = ("constituents", "investor_flow", "investor_flow_constituents", "market_cap",
                "ohlcv_adj", "ohlcv_adj_constituents", "ohlcv_unadj", "sox_daily")


def _to_date(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s).dt.date


def load_gold(data_dir: Path | None = None) -> dict[str, pd.DataFrame]:
    d = Path(data_dir) if data_dir else settings.DATA_DIR
    out = {}
    for name in GOLD_FILES:
        p = d / "gold" / f"{name}.parquet"
        if not p.exists():
            raise GateR1Error(f"gold panel missing: {p}")
        df = pq.read_table(p).to_pandas()
        df["date"] = _to_date(df["date"])
        out[name] = df
    return out


def load_close(data_dir: Path | None, code: str) -> pd.Series:
    """bronze ohlcv_adj(price_adjusted=True) 의 code 수정 종가, date 인덱스 오름차순."""
    d = Path(data_dir) if data_dir else settings.DATA_DIR
    df = pq.read_table(d / "bronze" / "ohlcv_adj.parquet").to_pandas()
    df = df[df["code"].astype(str) == code]
    if not len(df):
        raise GateR1Error(f"ohlcv_adj has no rows for {code}")
    if not df["price_adjusted"].astype(bool).all():
        raise GateR1Error(f"ohlcv_adj rows for {code} not price_adjusted")
    s = pd.Series(df["close"].astype(float).values, index=_to_date(df["date"]).values).sort_index()
    return s[~s.index.duplicated(keep="last")]


def forward_return(close: pd.Series, h: int, pct: bool) -> pd.Series:
    """r_h[t] = close[t+h]/close[t] − 1 (거래일 h 개 앞, 달력 = close 인덱스). pct=True → ×100. 말미 h 행은 NaN."""
    c = close.astype(float)
    r = c.shift(-h) / c - 1.0
    return r * 100.0 if pct else r


def baseline_ma(close: pd.Series, short: int = 20, long: int = 60) -> pd.Series:
    """baseline① b1[t] = (MA20[t] − MA60[t]) / MA60[t], 완전 창만(과거만, t 포함)."""
    c = close.astype(float)
    ma_s = c.rolling(short, min_periods=short).mean()
    ma_l = c.rolling(long, min_periods=long).mean()
    return (ma_s - ma_l) / ma_l


def fold_of(d: dt.date) -> str:
    if d.year == 2026:
        return "2026H1" if d.month <= 6 else "2026H2"
    return str(d.year)


def align_pairs(signal: pd.Series, label: pd.Series, window: tuple[dt.date, dt.date] = WINDOW) -> pd.DataFrame:
    """date 인덱스 신호·라벨 → DataFrame[date, x, y] (신호일 ∈ window, 둘 다 non-None). 날짜 오름차순."""
    s = pd.Series(pd.to_numeric(signal, errors="coerce").values, index=signal.index, name="x")
    l = pd.Series(pd.to_numeric(label, errors="coerce").values, index=label.index, name="y")
    df = pd.concat([s, l], axis=1, join="inner")
    df = df[(df.index >= window[0]) & (df.index <= window[1])]
    df = df.dropna()
    df = df.sort_index()
    return df.rename_axis("date").reset_index()


def signal_series(panel: pd.DataFrame, col: str, scope: str | None = None) -> pd.Series:
    g = panel if scope is None else panel[panel["scope"].astype(str) == scope]
    g = g.sort_values("date")
    return pd.Series(pd.to_numeric(g[col], errors="coerce").values, index=g["date"].values)


def ic_measurement(signal: pd.Series, label: pd.Series, mean_block: float, *, sign: str = "pos", need_ci_excludes_zero: bool = True,
                   need_ci_lo_pos: bool = False, n_total: int | None = None, window=WINDOW,
                   n_boot: int = N_BOOT, seed: int = SEED, n_perm: int = N_PERM, perm_seed: int = PERM_SEED,
                   min_valid_n: int = MIN_VALID_N) -> dict:
    """IC + 부트스트랩 CI + 순열 백분위 + fold 서술 + 판정. n < min_valid_n → 판정 불가."""
    pairs = align_pairs(signal, label, window)
    n = int(len(pairs))
    res: dict = {"n": n, "n_total": int(n_total) if n_total is not None else None,
                 "n_ratio": (n / n_total) if n_total else None,
                 "date_first": str(pairs["date"].iloc[0]) if n else None, "date_last": str(pairs["date"].iloc[-1]) if n else None}
    if n < min_valid_n:
        res.update({"ic": float(spearman(pairs["x"], pairs["y"])) if n >= 3 else None, "verdict": UNDECIDABLE,
                    "reason": f"valid n={n} < {min_valid_n}", "folds": {}})
        return res
    x = pairs["x"].to_numpy(dtype=float)
    y = pairs["y"].to_numpy(dtype=float)
    ic = spearman(x, y)
    boot = bootstrap_ci(x, y, mean_block, n_boot=n_boot, seed=seed)
    perm = permutation_null(x, y, n_perm=n_perm, seed=perm_seed)
    folds = {}
    for f in FOLDS:
        m = pairs["date"].map(fold_of) == str(f)
        k = int(m.sum())
        folds[str(f)] = {"n": k, "ic": float(spearman(pairs.loc[m, "x"], pairs.loc[m, "y"])) if k >= 3 else None}
    ci_excl0 = (boot["ci_lo"] > 0) or (boot["ci_hi"] < 0)
    sign_ok = ic > 0 if sign == "pos" else ic < 0
    ok = sign_ok
    if need_ci_excludes_zero:
        ok = ok and ci_excl0
    if need_ci_lo_pos:
        ok = ok and (boot["ci_lo"] > 0)
    res.update({"ic": float(ic), "ci_lo": boot["ci_lo"], "ci_hi": boot["ci_hi"], "boot_mean": boot["boot_mean"], "boot_sd": boot["boot_sd"],
                "block": mean_block, "ci_excludes_zero": bool(ci_excl0), "sign_ok": bool(sign_ok),
                "null_percentile": perm["null_percentile"], "null_sd": perm["null_sd"], "p_two_sided_perm": perm["p_two_sided"],
                "folds": folds, "verdict": PASS if ok else FAIL})
    return res


# ---------------------------------------------------------------------------
# P1 · P2 · P3
# ---------------------------------------------------------------------------

def _n_total(panel: pd.DataFrame, scope: str | None) -> int:
    g = panel if scope is None else panel[panel["scope"].astype(str) == scope]
    d = g["date"]
    return int(((d >= WINDOW[0]) & (d <= WINDOW[1])).sum())


def run_p1(gold: dict, closes: dict[str, pd.Series], log: Callable[[str], None] = print) -> dict:
    """P1: 스코프별 Spearman(flow_impact_residual_z[t], r1[t+1]) — 블록 10, CI 0 제외 AND IC>0, 3스코프 모두."""
    fp = gold["flow_panel"]
    out = {"scopes": {}}
    for sc in SCOPES:
        sig = signal_series(fp, "flow_impact_residual_z", sc)
        lab = forward_return(closes[sc], H_FLOW, pct=True)
        r = ic_measurement(sig, lab, BLOCK[H_FLOW], sign=G["signs"]["flow"], need_ci_excludes_zero=True, n_total=_n_total(fp, sc))
        out["scopes"][sc] = r
        log(f"[P1] {sc}: n={r['n']} IC={r.get('ic')} CI=[{r.get('ci_lo')}, {r.get('ci_hi')}] null_pct={r.get('null_percentile')} -> {r['verdict']}")
    out["verdict"] = _combine([v["verdict"] for v in out["scopes"].values()])
    out["definition"] = "IC_1 = Spearman(flow_impact_residual_z[t], r[t+1]); r = 수정 종가 일간 수익률 %; 정상 블록 부트스트랩(10, 2000) 95% CI 0 제외 AND IC>0, 3스코프 모두"
    return out


def run_p2(gold: dict, closes: dict[str, pd.Series], log: Callable[[str], None] = print) -> dict:
    """P2: Spearman(breadth_impulse_z[t], r21_KOSPI200[t]) — 블록 21, IC>0 AND CI 하한>0. 보조: 005930·000660 IC_21."""
    bp = gold["breadth_panel"]
    sig = signal_series(bp, "breadth_impulse_z", None)
    n_tot = _n_total(bp, None)
    out = {"scopes": {}, "aux_scopes": {}}
    for sc in SCOPES:
        lab = forward_return(closes[sc], H_BREADTH, pct=False)
        r = ic_measurement(sig, lab, BLOCK[H_BREADTH], sign=G["signs"]["breadth"], need_ci_excludes_zero=False, need_ci_lo_pos=True, n_total=n_tot)
        if sc == MARKET_SCOPE:
            out["scopes"][sc] = r
        else:
            out["aux_scopes"][sc] = r
        log(f"[P2] {sc}{'' if sc == MARKET_SCOPE else ' (aux)'}: n={r['n']} IC={r.get('ic')} CI=[{r.get('ci_lo')}, {r.get('ci_hi')}] null_pct={r.get('null_percentile')} -> {r['verdict']}")
    out["verdict"] = out["scopes"][MARKET_SCOPE]["verdict"]
    out["definition"] = "IC_21 = Spearman(breadth_impulse_z[t], r21[t]), r21 = KOSPI200 close[t+21]/close[t]−1; 블록 21 부트스트랩 CI; IC>0 AND CI 하한>0"
    return out


def run_p3(gold: dict, closes: dict[str, pd.Series], log: Callable[[str], None] = print) -> dict:
    """P3-a: Pearson(energy_lite, baseline①/②) 스코프별 |ρ|<0.9 (6개 전부). P3-b: Spearman(energy_lite[t], r21[t]) 스코프별 IC>0 AND CI 하한>0.
    보조: 5일 지평 IC, baseline①②의 IC_21."""
    ep = gold["energy_lite_panel"]
    bp = gold["breadth_panel"]
    b2 = signal_series(bp, "above_20d_ratio", None)
    out = {"a": {"scopes": {}}, "b": {"scopes": {}}, "aux_h5": {}, "baseline_ic21": {}}
    for sc in SCOPES:
        e = signal_series(ep, "energy_lite", sc)
        n_tot = _n_total(ep, sc)
        b1 = baseline_ma(closes[sc])
        # P3-a
        pa_ = {}
        for name, b in (("b1_ma20_60", b1), ("b2_above_20d_ratio", b2)):
            pairs = align_pairs(e, b)
            rho = pearson(pairs["x"], pairs["y"]) if len(pairs) >= 3 else float("nan")
            ok = bool(np.isfinite(rho) and abs(rho) < BASELINE_CORR_MAX)
            pa_[name] = {"pearson": float(rho), "n": int(len(pairs)), "spearman": float(spearman(pairs["x"], pairs["y"])) if len(pairs) >= 3 else None,
                         "verdict": PASS if ok else FAIL}
            log(f"[P3-a] {sc} vs {name}: pearson={rho:.4f} n={len(pairs)} -> {pa_[name]['verdict']}")
        pa_["verdict"] = _combine([v["verdict"] for k, v in pa_.items() if k != "verdict"])
        out["a"]["scopes"][sc] = pa_
        # P3-b
        lab21 = forward_return(closes[sc], H_ENERGY, pct=False)
        r = ic_measurement(e, lab21, BLOCK[H_ENERGY], sign=G["signs"]["energy"], need_ci_excludes_zero=False, need_ci_lo_pos=True, n_total=n_tot)
        out["b"]["scopes"][sc] = r
        log(f"[P3-b] {sc}: n={r['n']} IC21={r.get('ic')} CI=[{r.get('ci_lo')}, {r.get('ci_hi')}] null_pct={r.get('null_percentile')} -> {r['verdict']}")
        # 보조: 5일 지평 (서술 전용) — 블록 = 지평(5) 로 부트스트랩 (등록 표엔 5 블록이 없어 지평 길이를 사용; 판정 불사용)
        lab5 = forward_return(closes[sc], H_ENERGY_AUX, pct=False)
        r5 = ic_measurement(e, lab5, float(H_ENERGY_AUX), sign="pos", need_ci_excludes_zero=False, need_ci_lo_pos=True, n_total=n_tot)
        r5["verdict_note"] = "descriptive only"
        out["aux_h5"][sc] = r5
        log(f"[P3 aux h5] {sc}: n={r5['n']} IC5={r5.get('ic')} CI=[{r5.get('ci_lo')}, {r5.get('ci_hi')}]")
        # 보조: baseline ①② IC_21 (같은 방법)
        bl = {}
        for name, b in (("b1_ma20_60", b1), ("b2_above_20d_ratio", b2)):
            rb = ic_measurement(b, lab21, BLOCK[H_ENERGY], sign="pos", need_ci_excludes_zero=False, need_ci_lo_pos=True, n_total=n_tot)
            rb["verdict_note"] = "descriptive only"
            bl[name] = rb
            log(f"[P3 baseline IC21] {sc} {name}: n={rb['n']} IC21={rb.get('ic')} CI=[{rb.get('ci_lo')}, {rb.get('ci_hi')}]")
        out["baseline_ic21"][sc] = bl
    out["a"]["verdict"] = _combine([v["verdict"] for v in out["a"]["scopes"].values()])
    out["b"]["verdict"] = _combine([v["verdict"] for v in out["b"]["scopes"].values()])
    out["verdict"] = _combine([out["a"]["verdict"], out["b"]["verdict"]])
    out["a"]["definition"] = "Pearson(energy_lite[t], baseline_k[t]) 스코프별, ① (MA20−MA60)/MA60 (수정 종가, 과거만) ② breadth above_20d_ratio; 6개 전부 |ρ|<0.9"
    out["b"]["definition"] = "IC_21 = Spearman(energy_lite[t], r21[t]) 스코프별 자기 수익률; 블록 21 부트스트랩; 3스코프 모두 IC>0 AND CI 하한>0"
    return out


def _combine(verdicts: Sequence[str]) -> str:
    if any(v == FAIL for v in verdicts):
        return FAIL
    if any(v == UNDECIDABLE for v in verdicts):
        return UNDECIDABLE
    return PASS


# ---------------------------------------------------------------------------
# P4 — 룩어헤드
# ---------------------------------------------------------------------------
BRONZE_CUT_COLUMN = {"constituents": "asof", "market_cap": "asof", "investor_flow": "date", "investor_flow_constituents": "date",
                     "ohlcv_adj": "date", "ohlcv_adj_constituents": "date", "ohlcv_unadj": "date", "sox_daily": "date"}
PIPELINE_JOBS: tuple[tuple[str, ...], ...] = (
    ("jobs/build_flow.py",),
    ("jobs/build_breadth.py",),
    ("jobs/build_gradec.py", "--no-fetch", "--wait-minutes", "0"),
    ("jobs/build_energy_lite.py",),
)
SIDE_EFFECT_FILES = ("docs/mtpro-t3a-ingest.md", "logs/flow_panel_summary.json")   # build_flow 가 덮어쓰는 파일 — 스냅샷/원복
PANEL_KEYS = {"flow_panel": ["date", "scope"], "breadth_panel": ["date"], "gradec_panel": ["date", "scope"], "energy_lite_panel": ["date", "scope"]}
COMPARE_EXCLUDE = ("engine_ver",)


def trading_days_in_window(close: pd.Series, window=WINDOW) -> list[dt.date]:
    return [d for d in close.index if window[0] <= d <= window[1]]


def choose_cutoffs(trading_days: Sequence[dt.date], n: int = N_CUTOFFS, seed: int = CUTOFF_SEED) -> list[dt.date]:
    rng = np.random.default_rng(seed)
    days = list(trading_days)
    pick = rng.choice(len(days), size=n, replace=False)
    return sorted(days[int(i)] for i in pick)


def sox_cutoff(cutoff: dt.date) -> dt.date:
    """^SOX 는 절단일−1 까지 (해석 기록 참조)."""
    return cutoff - dt.timedelta(days=1)


def make_truncated_data_dir(src_data_dir: Path, dst_root: Path, cutoff: dt.date) -> Path:
    """bronze 7종 + sox 를 절단일 이하로 잘라 dst_root/<cutoff>/bronze 에 기록(스키마 보존). gold·silver 는 빈 디렉토리."""
    d = Path(dst_root) / cutoff.isoformat()
    if d.exists():
        shutil.rmtree(d)
    (d / "bronze").mkdir(parents=True)
    (d / "silver").mkdir()
    (d / "gold").mkdir()
    for name, col in BRONZE_CUT_COLUMN.items():
        src = Path(src_data_dir) / "bronze" / f"{name}.parquet"
        if not src.exists():
            raise GateR1Error(f"bronze missing for truncation: {src}")
        tbl = pq.read_table(src)
        lim = sox_cutoff(cutoff) if name == "sox_daily" else cutoff
        mask = pc.less_equal(tbl[col], pa.scalar(lim, type=tbl.schema.field(col).type))
        pq.write_table(tbl.filter(mask), d / "bronze" / f"{name}.parquet")
    return d


def run_pipeline(data_dir: Path, *, root: Path = settings.ROOT, python: str = sys.executable,
                 log: Callable[[str], None] = print, timeout_s: int = 1800) -> dict:
    """전 파이프라인을 MTPRO_DATA_DIR=data_dir 로 재실행. build_flow 부작용 파일은 스냅샷 → 원복."""
    snapshots = {}
    for rel in SIDE_EFFECT_FILES:
        p = root / rel
        snapshots[rel] = p.read_bytes() if p.exists() else None
    env = dict(os.environ)
    env["MTPRO_DATA_DIR"] = str(data_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    steps = []
    ok = True
    try:
        for job in PIPELINE_JOBS:
            cmd = [python, *job]
            t0 = time.time()
            proc = subprocess.run(cmd, cwd=str(root), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_s)
            dt_s = time.time() - t0
            steps.append({"job": " ".join(job), "returncode": proc.returncode, "seconds": round(dt_s, 1),
                          "stderr_tail": proc.stderr[-800:] if proc.returncode != 0 else ""})
            log(f"    {job[0]} rc={proc.returncode} ({dt_s:.1f}s)")
            if proc.returncode != 0:
                ok = False
                log(f"    STDERR: {proc.stderr[-800:]}")
                break
    finally:
        for rel, content in snapshots.items():
            p = root / rel
            if content is None:
                if p.exists():
                    p.unlink()
            else:
                p.write_bytes(content)
    return {"ok": ok, "steps": steps}


def _values_bit_equal(a: pd.Series, b: pd.Series) -> np.ndarray:
    """행별 동일 여부(bool 배열). float → NaN 위치 동일 + 비-NaN 비트 동일. 그 외 → 값 동일(None 포함, list 는 tuple 비교)."""
    if pd.api.types.is_float_dtype(a.dtype) and pd.api.types.is_float_dtype(b.dtype):
        x = a.to_numpy(dtype=np.float64)
        y = b.to_numpy(dtype=np.float64)
        nx, ny = np.isnan(x), np.isnan(y)
        eq = (nx & ny) | (~nx & ~ny & (x.view(np.uint64) == y.view(np.uint64)))
        return eq
    def norm(v):
        if v is None:
            return None
        try:
            if pd.isna(v):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(v, (list, np.ndarray)):
            return tuple(norm(u) for u in v)
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            f = float(v)
            return f
        if isinstance(v, (np.bool_,)):
            return bool(v)
        return v
    xa = [norm(v) for v in a.tolist()]
    ya = [norm(v) for v in b.tolist()]
    return np.array([u == w for u, w in zip(xa, ya)], dtype=bool)


def compare_panels(full: pd.DataFrame, trunc: pd.DataFrame, keys: Sequence[str], cutoff: dt.date,
                   exclude: Sequence[str] = COMPARE_EXCLUDE) -> dict:
    """전량 산출본 vs 절단 산출본: 절단일 이하 행 비교. 반환 rows_compared·rows_missing_in_trunc·rows_differ·cols_differ·examples."""
    f = full[full["date"] <= cutoff].copy()
    t = trunc[trunc["date"] <= cutoff].copy()
    for df in (f, t):
        for k in keys:
            if k != "date":
                df[k] = df[k].astype(str)
    cols = [c for c in full.columns if c not in exclude]
    fi = f.set_index(list(keys)).sort_index()
    ti = t.set_index(list(keys)).sort_index()
    if fi.index.has_duplicates or ti.index.has_duplicates:
        raise GateR1Error("duplicate keys in panel — cannot compare")
    missing = fi.index.difference(ti.index)
    extra = ti.index.difference(fi.index)
    common = fi.index.intersection(ti.index)
    fc = fi.loc[common]
    tc = ti.loc[common]
    diff_rows = np.zeros(len(common), dtype=bool)
    cols_differ: dict[str, int] = {}
    examples: list[dict] = []
    for c in cols:
        if c in keys:
            continue
        eq = _values_bit_equal(fc[c], tc[c])
        bad = ~eq
        if bad.any():
            cols_differ[c] = int(bad.sum())
            diff_rows |= bad
            for i in np.flatnonzero(bad)[:3]:
                examples.append({"key": [str(k) for k in (common[i] if isinstance(common[i], tuple) else (common[i],))], "col": c,
                                 "full": _jsonable(fc[c].iloc[i]), "trunc": _jsonable(tc[c].iloc[i])})
    return {"cutoff": cutoff.isoformat(), "rows_compared": int(len(common)), "rows_missing_in_trunc": int(len(missing)),
            "rows_extra_in_trunc": int(len(extra)), "rows_differ": int(diff_rows.sum()), "cols_differ": cols_differ,
            "violations": int(diff_rows.sum()) + int(len(missing)), "examples": examples[:10],
            "trunc_rows_total": int(len(trunc)), "trunc_max_date": str(trunc["date"].max()) if len(trunc) else None,
            "full_rows_le_cutoff": int(len(f))}


def truncation_check(data_dir: Path, gold_full: dict[str, pd.DataFrame], cutoffs: Sequence[dt.date], workdir: Path, *,
                     keep: bool = False, log: Callable[[str], None] = print, python: str = sys.executable, root: Path = settings.ROOT) -> dict:
    """P4(a): 절단일마다 임시 데이터 디렉토리 → 파이프라인 재실행 → 비교."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    runs = []
    total_viol = 0
    t_all = time.time()
    for i, c in enumerate(cutoffs, 1):
        t0 = time.time()
        log(f"[P4a] cutoff {i}/{len(cutoffs)} = {c} — building truncated bronze (sox ≤ {sox_cutoff(c)})")
        d = make_truncated_data_dir(data_dir, workdir, c)
        pr = run_pipeline(d, root=root, python=python, log=log)
        rec: dict = {"cutoff": c.isoformat(), "dir": str(d), "pipeline": pr, "panels": {}, "violations": None}
        if pr["ok"]:
            gt = load_gold(d)
            v = 0
            for name in GOLD_FILES:
                cmp = compare_panels(gold_full[name], gt[name], PANEL_KEYS[name], c)
                rec["panels"][name] = cmp
                v += cmp["violations"]
                log(f"    {name}: compared={cmp['rows_compared']} missing={cmp['rows_missing_in_trunc']} differ={cmp['rows_differ']} cols={cmp['cols_differ']}")
            rec["violations"] = v
        else:
            rec["violations"] = None
            rec["error"] = "pipeline failed"
        rec["seconds"] = round(time.time() - t0, 1)
        total_viol += rec["violations"] if rec["violations"] is not None else 0
        runs.append(rec)
        log(f"    -> violations={rec['violations']} ({rec['seconds']}s)")
        if not keep:
            shutil.rmtree(d, ignore_errors=True)
    failed = [r["cutoff"] for r in runs if r.get("error")]
    return {"cutoffs": [c.isoformat() for c in cutoffs], "runs": runs, "total_violations": int(total_viol),
            "pipeline_failures": failed, "seconds": round(time.time() - t_all, 1),
            "verdict": FAIL if (total_viol > 0 or failed) else PASS}


def sox_alignment_check(gradec_panel: pd.DataFrame) -> dict:
    """P4(b): 모든 행에서 sox_session_date ≤ date − 1 (sox_session_date non-None 행)."""
    g = gradec_panel
    sess = pd.to_datetime(g["sox_session_date"], errors="coerce")
    d = pd.to_datetime(g["date"])
    has = sess.notna()
    gap_days = (d - sess).dt.days                       # t − session (달력일)
    viol = has & ~(gap_days >= 1)
    return {"rows": int(len(g)), "rows_with_session": int(has.sum()), "violations": int(viol.sum()),
            "max_session_minus_date_days": int(-gap_days[has].min()) if has.any() else None,
            "status_counts": {str(k): int(v) for k, v in g["sox_align_status"].value_counts(dropna=False).items()},
            "verdict": PASS if int(viol.sum()) == 0 else FAIL}


def fetch_ts_check(data_dir: Path) -> dict:
    """P4(c): bronze 8 파일 fetch_ts 최댓값 ≤ gold 패널 파일 mtime 중 가장 이른 것(UTC)."""
    d = Path(data_dir)
    mtimes = {}
    for name in GOLD_FILES:
        p = d / "gold" / f"{name}.parquet"
        mtimes[name] = dt.datetime.fromtimestamp(p.stat().st_mtime, tz=dt.timezone.utc)
    build_min = min(mtimes.values())
    files = {}
    viol = 0
    for name in BRONZE_FILES:
        p = d / "bronze" / f"{name}.parquet"
        t = pq.read_table(p, columns=["fetch_ts"]).to_pandas()["fetch_ts"]
        t = pd.to_datetime(t, utc=True)
        mx = t.max()
        n_bad = int((t > build_min).sum())
        viol += n_bad
        files[name] = {"fetch_ts_min": str(t.min()), "fetch_ts_max": str(mx), "rows_after_build": n_bad}
    return {"gold_mtime_utc": {k: v.isoformat(timespec="seconds") for k, v in mtimes.items()},
            "build_time_utc_min": build_min.isoformat(timespec="seconds"), "bronze": files, "violations": int(viol),
            "verdict": PASS if viol == 0 else FAIL}


# ---------------------------------------------------------------------------
# P5 — 결측 None 유지
# ---------------------------------------------------------------------------
P5_COLUMNS = {
    "flow_panel": ["flow_beta_foreign", "flow_beta_inst", "flow_impact_residual_z", "flow_trend_z"],
    "breadth_panel": ["breadth_impulse_z"],
    "gradec_panel": ["beta_sox_raw", "beta_sox", "err_z", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"],
    "energy_lite_panel": ["flow_z", "breadth_z", "gradec_err_z", "energy_lite", "good_acceptance_z", "bad_resilience_z", "good_beta", "bad_beta"],
}
# 워밍업 하한(행 수) — 원천 시작일로부터 증명 가능한 flow_panel 만 (해석 기록)
P5_WARMUP_MIN_ROWS = {"flow_panel": {"flow_beta_foreign": 78, "flow_beta_inst": 78, "flow_impact_residual_z": 78, "flow_trend_z": 83}}   # 0-based: norm 첫 유효 index 19, +59 관측 → 78; trend 기울기 첫 index 23 + 60 기준 → 83
GREP_PATTERNS = [r"fillna\(\s*0", r"fillna\(\s*value\s*=\s*0", r"nan_to_num", r"\bor\s+0(\.0+)?\b(?!\.)", r"replace\(\s*(np\.nan|None|float\(['\"]nan['\"]\))\s*,\s*0"]
GREP_DIRS = ("src/mtpro/components",)
GREP_DIRS_AUX = ("src/mtpro/core", "jobs")


def zero_share_check(gold: dict) -> dict:
    out = {}
    worst_fail = False
    for panel, cols in P5_COLUMNS.items():
        df = gold[panel]
        scopes = sorted(df["scope"].astype(str).unique()) if "scope" in df.columns else [None]
        for c in cols:
            for sc in scopes:
                g = df if sc is None else df[df["scope"].astype(str) == sc]
                v = pd.to_numeric(g[c], errors="coerce")
                nn = v.notna()
                n_valid = int(nn.sum())
                n_zero = int((v[nn] == 0.0).sum())
                share = (n_zero / n_valid) if n_valid else 0.0
                key = f"{panel}.{c}" + (f"[{sc}]" if sc else "")
                rec = {"n_rows": int(len(g)), "n_valid": n_valid, "n_zero": n_zero, "zero_share": share, "within_limit": share <= ZERO_SHARE_MAX}
                if not rec["within_limit"] and panel == "energy_lite_panel" and c == "energy_lite":
                    rec["justification"] = _justify_energy_zero(g)
                    rec["justified"] = rec["justification"]["all_zero_rows_recomputed_zero"]
                out[key] = rec
                if not rec["within_limit"] and not rec.get("justified", False):
                    worst_fail = True
    return {"columns": out, "verdict": FAIL if worst_fail else PASS}


def _justify_energy_zero(g: pd.DataFrame) -> dict:
    """energy_lite == 0 행: 가용 컴포넌트 ≥ min_components 이고 z 컴포넌트에서 재계산한 energy 가 0 인지 (원천 값이 실제 0)."""
    from mtpro.components import energy_lite as EL
    from mtpro.core.errata import energy as energy_fn
    z = g[pd.to_numeric(g["energy_lite"], errors="coerce") == 0]
    n_ok = 0
    n_bad = 0
    for r in z.itertuples(index=False):
        comps = {"flow": None if pd.isna(r.flow_z) else float(r.flow_z), "breadth": None if pd.isna(r.breadth_z) else float(r.breadth_z),
                 "gradec_err": None if pd.isna(r.gradec_err_z) else float(r.gradec_err_z)}
        res = energy_fn(comps, EL.WEIGHTS, min_components=EL.MIN_COMPONENTS)
        if res["energy"] == 0 and len(res["available_components"]) >= EL.MIN_COMPONENTS:
            n_ok += 1
        else:
            n_bad += 1
    return {"n_zero_rows": int(len(z)), "recomputed_zero_with_ge_min_components": n_ok, "not_reproduced": n_bad,
            "all_zero_rows_recomputed_zero": n_bad == 0 and len(z) > 0,
            "note": "energy_lite = round(100·Σ w·tanh(z)) 정수 — 작은 가중합이 반올림으로 0. None 대체 아님(가용 컴포넌트 z 로 재계산 일치)."}


def warmup_none_check(gold: dict) -> dict:
    out = {}
    fail = False
    for panel, cols in P5_COLUMNS.items():
        df = gold[panel]
        scopes = sorted(df["scope"].astype(str).unique()) if "scope" in df.columns else [None]
        for c in cols:
            for sc in scopes:
                g = (df if sc is None else df[df["scope"].astype(str) == sc]).sort_values("date")
                v = pd.to_numeric(g[c], errors="coerce").to_numpy()
                nn = ~np.isnan(v)
                if nn.any():
                    first = int(np.argmax(nn))
                    leading_all_none = bool(not nn[:first].any())
                    first_date = str(g["date"].iloc[first])
                else:
                    first, leading_all_none, first_date = int(len(v)), True, None
                min_rows = P5_WARMUP_MIN_ROWS.get(panel, {}).get(c)
                ok = leading_all_none and (min_rows is None or first >= min_rows)
                key = f"{panel}.{c}" + (f"[{sc}]" if sc else "")
                out[key] = {"first_valid_date": first_date, "leading_none_rows": first, "leading_all_none": leading_all_none,
                            "warmup_min_rows": min_rows, "ok": ok}
                fail |= not ok
    return {"columns": out, "verdict": FAIL if fail else PASS}


def grep_zero_substitution(root: Path = settings.ROOT) -> dict:
    hits = []
    aux_hits = []
    pats = [re.compile(p) for p in GREP_PATTERNS]

    def scan(dirs, sink, jobs_only_build=False):
        for rel in dirs:
            base = root / rel
            files = sorted(base.glob("build_*.py")) if (jobs_only_build and rel == "jobs") else sorted(base.rglob("*.py"))
            for f in files:
                if "__pycache__" in f.parts:
                    continue
                lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
                enclosing = None
                for i, line in enumerate(lines, 1):
                    m = re.match(r"\s*def\s+(\w+)", line)
                    if m:
                        enclosing = m.group(1)
                    code = line.split("#", 1)[0]
                    for p in pats:
                        if p.search(code):
                            sink.append({"file": str(f.relative_to(root)).replace("\\", "/"), "line": i, "text": line.strip()[:160], "pattern": p.pattern,
                                         "enclosing_def": enclosing})
                            break
    scan(GREP_DIRS, hits)
    scan(GREP_DIRS_AUX, aux_hits, jobs_only_build=True)
    return {"patterns": GREP_PATTERNS, "dirs": list(GREP_DIRS), "hits": hits, "aux_dirs": list(GREP_DIRS_AUX), "aux_hits": aux_hits,
            "verdict": PASS if not hits else FAIL}


def _grep_hit_context(hits: list[dict], gold: dict) -> list[str]:
    """히트 맥락(사실 서술, 판정에 미반영): 감싸는 함수, 히트가 다루는 gold 컬럼의 실제 None 개수, P5 대상(z·β·energy) 컬럼 여부."""
    notes = []
    for h in hits:
        cols = re.findall(r"\[\s*['\"](\w+)['\"]\s*\]", h["text"])
        parts = [f"{h['file']}:{h['line']} 감싸는 함수 = {h.get('enclosing_def')}"]
        for c in cols:
            for pname, df in gold.items():
                if c in df.columns:
                    n_none = int(df[c].isna().sum())
                    is_p5 = c in P5_COLUMNS.get(pname, [])
                    parts.append(f"컬럼 {pname}.{c}: 실제 None {n_none}개 / P5 대상(z·β·energy) 컬럼 {'예' if is_p5 else '아니오'}")
        notes.append("; ".join(parts))
    return notes


def run_p5(gold: dict, root: Path = settings.ROOT, log: Callable[[str], None] = print) -> dict:
    zs = zero_share_check(gold)
    wu = warmup_none_check(gold)
    gr = grep_zero_substitution(root)
    gr["hit_context"] = _grep_hit_context(gr["hits"], gold)
    log(f"[P5] zero-share {zs['verdict']} / warm-up None {wu['verdict']} / grep {gr['verdict']} (hits={len(gr['hits'])}, aux={len(gr['aux_hits'])})")
    return {"i_zero_share": zs, "ii_warmup_none": wu, "iii_grep": gr, "verdict": _combine([zs["verdict"], wu["verdict"], gr["verdict"]])}


# ---------------------------------------------------------------------------
# 전체 실행
# ---------------------------------------------------------------------------

def _jsonable(v):
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if np.isnan(f) else f
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, (dt.date, dt.datetime, pd.Timestamp)):
        return str(v)
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_jsonable(u) for u in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(u) for k, u in v.items()}
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def evaluate(data_dir: Path | None = None, *, run_truncation: bool = True, workdir: Path | None = None, keep_workdirs: bool = False,
             log: Callable[[str], None] = print, doc_prereg: Path = DOC_PREREG, root: Path = settings.ROOT) -> dict:
    """전 항목 실행 → summary dict (logs/gate_r1_summary.json 원본)."""
    t_start = time.time()
    data_dir = Path(data_dir) if data_dir else settings.DATA_DIR
    log(f"[gate_r1] prereg check vs {doc_prereg}")
    prereg = assert_prereg_matches(doc_prereg)
    log("[gate_r1] prereg OK")
    gold = load_gold(data_dir)
    closes = {sc: load_close(data_dir, sc) for sc in SCOPES}
    meta = {"data_dir": str(data_dir), "started_at": dt.datetime.now().isoformat(timespec="seconds"),
            "panels": {k: {"rows": int(len(v)), "date_range": [str(v['date'].min()), str(v['date'].max())],
                           "engine_ver": str(v["engine_ver"].iloc[0]) if "engine_ver" in v.columns and len(v) else None} for k, v in gold.items()},
            "close_ranges": {sc: [str(s.index.min()), str(s.index.max()), int(len(s))] for sc, s in closes.items()}}
    p1 = run_p1(gold, closes, log)
    p2 = run_p2(gold, closes, log)
    p3 = run_p3(gold, closes, log)
    # P4
    kospi_days = trading_days_in_window(closes[MARKET_SCOPE])
    cutoffs = choose_cutoffs(kospi_days)
    log(f"[P4a] cutoffs (seed {CUTOFF_SEED}, {N_CUTOFFS} of {len(kospi_days)} trading days): {[c.isoformat() for c in cutoffs]}")
    if run_truncation:
        wd = Path(workdir) if workdir else (settings.CACHE_DIR / "gate_r1_trunc")
        p4a = truncation_check(data_dir, gold, cutoffs, wd, keep=keep_workdirs, log=log, root=root)
    else:
        p4a = {"cutoffs": [c.isoformat() for c in cutoffs], "runs": [], "total_violations": None, "pipeline_failures": [], "verdict": UNDECIDABLE,
               "note": "truncation skipped (--skip-truncation)"}
    p4b = sox_alignment_check(gold["gradec_panel"])
    log(f"[P4b] sox alignment violations={p4b['violations']} -> {p4b['verdict']}")
    p4c = fetch_ts_check(data_dir)
    log(f"[P4c] fetch_ts violations={p4c['violations']} (build_min={p4c['build_time_utc_min']}) -> {p4c['verdict']}")
    p4 = {"a_truncation": p4a, "b_sox_alignment": p4b, "c_fetch_ts": p4c, "verdict": _combine([p4a["verdict"], p4b["verdict"], p4c["verdict"]])}
    p5 = run_p5(gold, root, log)
    verdicts = {"P1": p1["verdict"], "P2": p2["verdict"], "P3": p3["verdict"], "P3-a": p3["a"]["verdict"], "P3-b": p3["b"]["verdict"],
                "P4": p4["verdict"], "P5": p5["verdict"]}
    final = _combine([verdicts[k] for k in ("P1", "P2", "P3", "P4", "P5")])
    elapsed = round(time.time() - t_start, 1)
    log(f"[gate_r1] verdicts {verdicts} -> FINAL {final} ({elapsed}s)")
    return _jsonable({"gate": "R1", "prereg": prereg, "meta": meta, "P1": p1, "P2": p2, "P3": p3, "P4": p4, "P5": p5,
                      "verdicts": verdicts, "final": final, "interpretations": INTERPRETATIONS, "elapsed_seconds": elapsed,
                      "finished_at": dt.datetime.now().isoformat(timespec="seconds")})


# ---------------------------------------------------------------------------
# 결과 문서 렌더링
# ---------------------------------------------------------------------------

def _f(v, nd=4):
    if v is None:
        return "—"
    try:
        if isinstance(v, float) and np.isnan(v):
            return "—"
        return f"{v:.{nd}f}"
    except (TypeError, ValueError):
        return str(v)


def _ci(r):
    if r.get("ci_lo") is None:
        return "—"
    return f"[{_f(r['ci_lo'])}, {_f(r['ci_hi'])}]"


def _pct(v):
    return "—" if v is None else f"{v:.1f}"


def _nrow(r):
    if r.get("n_ratio") is None:
        return str(r.get("n"))
    return f"{r['n']} ({100 * r['n_ratio']:.1f}%)"


def extract_section(doc_text: str, start_marker: str, end_marker: str) -> str:
    i = doc_text.find(start_marker)
    j = doc_text.find(end_marker, i + 1)
    if i < 0:
        return ""
    return doc_text[i:j if j > 0 else None].rstrip()


def render_markdown(s: dict, doc_prereg: Path = DOC_PREREG) -> str:
    L: list[str] = []
    A = L.append
    A(f"# MT-PRO T4 — Gate R1 측정 결과 ({s['finished_at'][:10]})")
    A("")
    A(f"- 사전 등록: `docs/mtpro-t4-gate-r1-prereg.md` (§6 상수 블록 ↔ `src/mtpro/gate/r1.py::PREREG` 대조 통과). 측정 코드 `src/mtpro/gate/r1.py` + `jobs/run_gate_r1.py`, 원본 수치 `logs/gate_r1_summary.json`.")
    m = s["meta"]
    A(f"- 데이터: `{m['data_dir']}` — " + ", ".join(f"{k} {v['rows']}행 {v['date_range'][0]}~{v['date_range'][1]} ({v['engine_ver']})" for k, v in m["panels"].items()) + ".")
    A(f"- 관문 구간 신호일 {WINDOW[0]}~{WINDOW[1]}, 라벨은 구간 밖 허용. 부트스트랩 {N_BOOT}회·순열 {N_PERM}회·seed {SEED}. 실행 {s['elapsed_seconds']}s.")
    A("")
    A(f"## 최종 판정: **{s['final']}**")
    A("")
    v = s["verdicts"]
    A("| 항목 | 판정 |")
    A("|---|---|")
    for k in ("P1", "P2", "P3-a", "P3-b", "P4", "P5"):
        A(f"| {k} | {v[k]} |")
    A("")
    A("부분 충족 = FAIL (사전 등록 §1 다중 스코프 규칙). 어떤 조건도 재해석하지 않았다.")
    A("")
    # P1
    A("## P1 — FlowImpactResidual_z vs 익일 수익률 (IC_1, 블록 10)")
    A("")
    A("| scope | 유효 n (구간 대비) | IC_1 | 95% CI | CI 0 제외 | 귀무 백분위 | 판정 |")
    A("|---|---|---|---|---|---|---|")
    for sc, r in s["P1"]["scopes"].items():
        A(f"| {sc} | {_nrow(r)} | {_f(r.get('ic'))} | {_ci(r)} | {r.get('ci_excludes_zero', '—')} | {_pct(r.get('null_percentile'))} | {r['verdict']} |")
    A(f"\n판정: **{s['P1']['verdict']}** — 조건: 3스코프 모두 CI 0 제외 AND IC_1 > 0.")
    A("")
    # P2
    A("## P2 — BreadthImpulse_z vs KOSPI200 21거래일 선행 수익률 (IC_21, 블록 21)")
    A("")
    A("| 대상 | 유효 n (구간 대비) | IC_21 | 95% CI | CI 하한>0 | 귀무 백분위 | 판정 |")
    A("|---|---|---|---|---|---|---|")
    for sc, r in s["P2"]["scopes"].items():
        A(f"| {sc} (판정) | {_nrow(r)} | {_f(r.get('ic'))} | {_ci(r)} | {r.get('ci_lo') is not None and r['ci_lo'] > 0} | {_pct(r.get('null_percentile'))} | {r['verdict']} |")
    for sc, r in s["P2"]["aux_scopes"].items():
        A(f"| {sc} (보조 서술) | {_nrow(r)} | {_f(r.get('ic'))} | {_ci(r)} | {r.get('ci_lo') is not None and r['ci_lo'] > 0} | {_pct(r.get('null_percentile'))} | (서술) {r['verdict']} |")
    A(f"\n판정: **{s['P2']['verdict']}** — 조건: KOSPI200 IC_21 > 0 AND CI 하한 > 0.")
    A("")
    # P3-a
    A("## P3-a — Energy-Lite vs baseline ①② Pearson 상관 (|ρ| < 0.9, 6개 전부)")
    A("")
    A("| scope | ① (MA20−MA60)/MA60: ρ (n) | ② above_20d_ratio: ρ (n) | 판정 |")
    A("|---|---|---|---|")
    for sc, r in s["P3"]["a"]["scopes"].items():
        b1, b2 = r["b1_ma20_60"], r["b2_above_20d_ratio"]
        A(f"| {sc} | {_f(b1['pearson'])} ({b1['n']}) | {_f(b2['pearson'])} ({b2['n']}) | {r['verdict']} |")
    A(f"\n판정: **{s['P3']['a']['verdict']}**")
    A("")
    A("## P3-b — Energy-Lite 자체 IC_21 (스코프별 자기 수익률, 블록 21)")
    A("")
    A("| scope | 유효 n (구간 대비) | IC_21 | 95% CI | CI 하한>0 | 귀무 백분위 | 판정 |")
    A("|---|---|---|---|---|---|---|")
    for sc, r in s["P3"]["b"]["scopes"].items():
        A(f"| {sc} | {_nrow(r)} | {_f(r.get('ic'))} | {_ci(r)} | {r.get('ci_lo') is not None and r['ci_lo'] > 0} | {_pct(r.get('null_percentile'))} | {r['verdict']} |")
    A(f"\n판정: **{s['P3']['b']['verdict']}** — 조건: 3스코프 모두 IC_21 > 0 AND CI 하한 > 0. P3 종합 = **{s['P3']['verdict']}**.")
    A("")
    A("### 보조 서술 (판정 불사용): 5거래일 지평 IC · baseline ①② IC_21")
    A("")
    A("| scope | Energy-Lite IC_5 (n) [CI] | baseline① IC_21 (n) [CI] | baseline② IC_21 (n) [CI] |")
    A("|---|---|---|---|")
    for sc in SCOPES:
        r5 = s["P3"]["aux_h5"][sc]
        b1 = s["P3"]["baseline_ic21"][sc]["b1_ma20_60"]
        b2 = s["P3"]["baseline_ic21"][sc]["b2_above_20d_ratio"]
        A(f"| {sc} | {_f(r5.get('ic'))} ({r5['n']}) {_ci(r5)} | {_f(b1.get('ic'))} ({b1['n']}) {_ci(b1)} | {_f(b2.get('ic'))} ({b2['n']}) {_ci(b2)} |")
    A("")
    # folds
    A("## 연도별 fold IC 서술표 (재학습 없음, 판정 불사용)")
    A("")
    A("| 항목 | " + " | ".join(str(f) for f in FOLDS) + " |")
    A("|---|" + "---|" * len(FOLDS))

    def fold_row(label, r):
        cells = []
        for f in FOLDS:
            fr = (r.get("folds") or {}).get(str(f))
            cells.append("—" if not fr else f"{_f(fr['ic'], 3)} (n={fr['n']})")
        A(f"| {label} | " + " | ".join(cells) + " |")
    for sc, r in s["P1"]["scopes"].items():
        fold_row(f"P1 flow IC_1 {sc}", r)
    for sc, r in s["P2"]["scopes"].items():
        fold_row(f"P2 breadth IC_21 {sc}", r)
    for sc, r in s["P2"]["aux_scopes"].items():
        fold_row(f"P2 breadth IC_21 {sc} (aux)", r)
    for sc, r in s["P3"]["b"]["scopes"].items():
        fold_row(f"P3-b energy IC_21 {sc}", r)
    A("")
    # P4
    p4 = s["P4"]
    A("## P4 — Lookahead violations")
    A("")
    a = p4["a_truncation"]
    A(f"### (a) 절단 재산출 — 절단일 {len(a['cutoffs'])}개 (seed {CUTOFF_SEED}): {', '.join(a['cutoffs'])}")
    A("")
    if a["runs"]:
        A("| 절단일 | 파이프라인 | flow 비교/상이 | breadth 비교/상이 | gradec 비교/상이 | energy 비교/상이 | 절단본 최종일(행) | 위반 | 초 |")
        A("|---|---|---|---|---|---|---|---|---|")
        for r in a["runs"]:
            def cell(name):
                c = r["panels"].get(name)
                if not c:
                    return "—"
                extra = f" (누락 {c['rows_missing_in_trunc']})" if c["rows_missing_in_trunc"] else ""
                return f"{c['rows_compared']}/{c['rows_differ']}{extra}"
            ep = r["panels"].get("energy_lite_panel") or {}
            A(f"| {r['cutoff']} | {'ok' if r['pipeline']['ok'] else 'FAIL'} | {cell('flow_panel')} | {cell('breadth_panel')} | {cell('gradec_panel')} | {cell('energy_lite_panel')} | {ep.get('trunc_max_date', '—')} ({ep.get('trunc_rows_total', '—')}) | {r['violations']} | {r['seconds']} |")
        A(f"\n합계 위반 행 = **{a['total_violations']}**, 파이프라인 실패 {len(a['pipeline_failures'])}건, 소요 {a['seconds']}s → {a['verdict']}.")
        ex = [e for r in a["runs"] for e in (r["panels"].get(n, {}).get("examples", []) for n in GOLD_FILES) for e in e]
        if ex:
            A("\n상이 예시(최대 10):")
            for e in ex[:10]:
                A(f"- {e}")
    else:
        A(f"절단 재산출 미실행: {a.get('note')} → {a['verdict']}")
    A("")
    b = p4["b_sox_alignment"]
    A(f"### (b) SOX 정렬 — gradec_panel {b['rows']}행 중 세션 있는 {b['rows_with_session']}행, `sox_session_date ≤ t−1` 위반 **{b['violations']}** (max session−t = {b['max_session_minus_date_days']}일; status {b['status_counts']}) → {b['verdict']}")
    A("")
    c = p4["c_fetch_ts"]
    A(f"### (c) fetch_ts ≤ 산출 시각 — 산출 시각(gold mtime 최솟값, UTC) {c['build_time_utc_min']}; bronze fetch_ts 최댓값 " +
      ", ".join(f"{k} {v['fetch_ts_max'][:19]}" for k, v in c["bronze"].items()) + f" → 위반 **{c['violations']}** → {c['verdict']}")
    A(f"\nP4 종합: **{p4['verdict']}**")
    A("")
    # P5
    p5 = s["P5"]
    A("## P5 — 결측 None 유지 (0 대체 없음)")
    A("")
    zs = p5["i_zero_share"]
    A(f"### (i) 정확히 0.0 비율 (분모 = non-None) — 한도 {ZERO_SHARE_MAX:.3%} → {zs['verdict']}")
    A("")
    A("| 컬럼 | non-None | 0.0 개수 | 비율 | 한도 내 | 소명 |")
    A("|---|---|---|---|---|---|")
    for k, r in zs["columns"].items():
        just = ""
        if "justification" in r:
            j = r["justification"]
            just = f"0행 {j['n_zero_rows']}개 전부 재계산 0·가용≥2: {j['all_zero_rows_recomputed_zero']}"
        A(f"| {k} | {r['n_valid']} | {r['n_zero']} | {100 * r['zero_share']:.2f}% | {r['within_limit']} | {just} |")
    A("")
    wu = p5["ii_warmup_none"]
    A(f"### (ii) 첫 유효일 이전 None → {wu['verdict']}")
    A("")
    A("| 컬럼 | 첫 유효일 | 선행 None 행 | 선행 전부 None | 워밍업 하한 | ok |")
    A("|---|---|---|---|---|---|")
    for k, r in wu["columns"].items():
        A(f"| {k} | {r['first_valid_date']} | {r['leading_none_rows']} | {r['leading_all_none']} | {r['warmup_min_rows'] if r['warmup_min_rows'] is not None else '—'} | {r['ok']} |")
    A("")
    gr = p5["iii_grep"]
    A(f"### (iii) 코드 grep ({', '.join(gr['dirs'])}; 패턴 `{'`, `'.join(gr['patterns'])}`) → 히트 {len(gr['hits'])}건 → {gr['verdict']}")
    A("")
    for h in gr["hits"]:
        A(f"- `{h['file']}:{h['line']}` — `{h['text']}` (패턴 `{h['pattern']}`)")
    for note in gr.get("hit_context", []):
        A(f"  - 맥락(사실 서술, 판정 미반영): {note}")
    if gr["aux_hits"]:
        A(f"\n보조 범위({', '.join(gr['aux_dirs'])}) 히트 {len(gr['aux_hits'])}건:")
        for h in gr["aux_hits"]:
            A(f"- `{h['file']}:{h['line']}` — `{h['text']}`")
    else:
        A(f"\n보조 범위({', '.join(gr['aux_dirs'])}) 히트 0건.")
    A(f"\nP5 종합: **{p5['verdict']}**")
    A("")
    # D-A
    doc = Path(doc_prereg).read_text(encoding="utf-8") if Path(doc_prereg).exists() else ""
    sec4 = extract_section(doc, "## 4. D-A 조건 명시", "## 5.")
    A("## D-A 조건 명시 (사전 등록 문서 §4 재수록 — 원문 그대로)")
    A("")
    A(sec4 if sec4 else "(사전 등록 문서 §4 를 찾지 못함)")
    A("")
    A("## 해석 기록 (문서가 명시하지 않은 세부 — 가장 엄격한 쪽 채택)")
    A("")
    for i, t in enumerate(s["interpretations"], 1):
        A(f"{i}. {t}")
    A("")
    A(f"## 최종 판정 한 줄")
    A("")
    A(f"**Gate R1 = {s['final']}** — " + ", ".join(f"{k} {v[k]}" for k in ("P1", "P2", "P3-a", "P3-b", "P4", "P5")) + ".")
    A("")
    return "\n".join(L)


def write_outputs(summary: dict, json_path: Path = SUMMARY_JSON, md_path: Path = DOC_RESULT, doc_prereg: Path = DOC_PREREG) -> tuple[Path, Path]:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    md_path.write_text(render_markdown(summary, doc_prereg), encoding="utf-8")
    return json_path, md_path
