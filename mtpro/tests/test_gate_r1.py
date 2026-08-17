"""T4 Gate R1 측정 모듈(`mtpro.gate.r1`) — 합성 데이터 단위 테스트.

사전 등록 대조(문서 상수 변조 → 실패) · Spearman(pandas 검산) · 정상 블록 부트스트랩(재현성·블록 구조·CI 방향) · 순열 귀무(백분위) ·
라벨/baseline/표본 규칙 · 판정 불가(n<500) · 절단 비교(비트 동일·NaN·누락 행) · 절단 bronze 생성(SOX 절단일−1) ·
MTPRO_DATA_DIR 오버라이드(기본 불변) · P4b/P5 헬퍼.
"""
from __future__ import annotations

import datetime as dt
import os
import pathlib
import subprocess
import sys

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from mtpro import settings  # noqa: E402
from mtpro.gate import r1  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "mtpro-t4-gate-r1-prereg.md"


# ---------------------------------------------------------------------------
# 사전 등록 대조
# ---------------------------------------------------------------------------

def test_prereg_matches_doc():
    parsed = r1.assert_prereg_matches(DOC)
    assert parsed == r1.PREREG
    assert parsed["gate_r1"]["bootstrap"]["seed"] == 20260817
    assert parsed["gate_r1"]["window"] == [dt.date(2023, 1, 3), dt.date(2026, 6, 30)]


@pytest.mark.parametrize("old,new", [("ci: 0.95, seed: 20260817", "ci: 0.95, seed: 20260818"),
                                     ("min_valid_n: 500", "min_valid_n: 400"),
                                     ("block: {1: 10, 21: 21}", "block: {1: 5, 21: 21}"),
                                     ("2026-06-30]", "2026-08-14]")])
def test_prereg_tampered_doc_fails(tmp_path, old, new):
    txt = DOC.read_text(encoding="utf-8")
    assert old in txt
    p = tmp_path / "prereg.md"
    p.write_text(txt.replace(old, new), encoding="utf-8")
    with pytest.raises(r1.PreregMismatch):
        r1.assert_prereg_matches(p)


def test_prereg_missing_block_fails(tmp_path):
    p = tmp_path / "prereg.md"
    p.write_text("# no yaml here\n", encoding="utf-8")
    with pytest.raises(r1.PreregMismatch):
        r1.assert_prereg_matches(p)
    with pytest.raises(r1.PreregMismatch):
        r1.assert_prereg_matches(tmp_path / "absent.md")


def test_module_constants_bound_to_prereg():
    assert r1.WINDOW == (dt.date(2023, 1, 3), dt.date(2026, 6, 30))
    assert r1.BLOCK == {1: 10, 21: 21}
    assert r1.N_BOOT == 2000 and r1.N_PERM == 2000 and r1.SEED == 20260817
    assert r1.MIN_VALID_N == 500 and r1.BASELINE_CORR_MAX == 0.9 and r1.N_CUTOFFS == 12 and r1.ZERO_SHARE_MAX == 0.005


# ---------------------------------------------------------------------------
# 통계
# ---------------------------------------------------------------------------

def test_spearman_matches_pandas():
    rng = np.random.default_rng(1)
    x = rng.normal(size=300)
    y = 0.4 * x + rng.normal(size=300)
    x[10:20] = x[0]                                   # 동률
    ref = pd.Series(x).rank().corr(pd.Series(y).rank())      # Spearman = Pearson(rank) (scipy 없이 검산)
    assert abs(r1.spearman(x, y) - ref) < 1e-12
    assert np.isnan(r1.spearman([1, 2], [1, 2]))
    assert abs(r1.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1.0) < 1e-12


def test_stationary_bootstrap_indices_structure():
    rng = np.random.default_rng(0)
    n, B, blk = 400, 500, 10.0
    idx = r1.stationary_bootstrap_indices(n, blk, B, rng)
    assert idx.shape == (B, n)
    assert idx.min() >= 0 and idx.max() < n
    steps = (idx[:, 1:] - idx[:, :-1]) % n
    frac_continue = float((steps == 1).mean())
    assert 0.85 < frac_continue < 0.95                # ≈ 1 − 1/10 (연속 확률)


def test_bootstrap_ci_reproducible_and_directional():
    rng = np.random.default_rng(3)
    n = 700
    x = rng.normal(size=n)
    y = 0.6 * x + rng.normal(size=n)
    a = r1.bootstrap_ci(x, y, 10, n_boot=300, seed=123)
    b = r1.bootstrap_ci(x, y, 10, n_boot=300, seed=123)
    assert a == b
    assert a["ci_lo"] > 0.3 and a["ci_hi"] < 0.75
    z = rng.normal(size=n)                            # 독립 → CI 가 0 포함
    c = r1.bootstrap_ci(x, z, 10, n_boot=300, seed=123)
    assert c["ci_lo"] < 0 < c["ci_hi"]
    d = r1.bootstrap_ci(x, y, 10, n_boot=300, seed=124)
    assert d != a                                     # 시드가 다르면 달라진다


def test_permutation_null_percentile():
    rng = np.random.default_rng(3)
    n = 600
    x = rng.normal(size=n)
    y = 0.5 * x + rng.normal(size=n)
    p = r1.permutation_null(x, y, n_perm=500, seed=7)
    assert p["null_percentile"] > 99.0 and p["p_two_sided"] < 0.01
    assert abs(p["null_mean"]) < 0.05
    q = r1.permutation_null(x, y, n_perm=500, seed=7)
    assert p == q
    z = rng.normal(size=n)
    pz = r1.permutation_null(x, z, n_perm=500, seed=7)
    assert 1.0 < pz["null_percentile"] < 99.0


# ---------------------------------------------------------------------------
# 라벨 · baseline · 표본 규칙 · 판정
# ---------------------------------------------------------------------------

def _bdays(start: dt.date, n: int) -> list[dt.date]:
    return list(pd.bdate_range(start, periods=n).date)


def test_forward_return_and_baseline_and_align():
    days = _bdays(dt.date(2022, 12, 1), 100)
    close = pd.Series(np.linspace(100, 199, 100), index=days)
    r1_ = r1.forward_return(close, 1, pct=True)
    assert abs(r1_.iloc[0] - (101 / 100 - 1) * 100) < 1e-12
    assert np.isnan(r1_.iloc[-1])
    r21 = r1.forward_return(close, 21, pct=False)
    assert abs(r21.iloc[0] - (121 / 100 - 1)) < 1e-12
    assert r21.iloc[-21:].isna().all()
    b1 = r1.baseline_ma(close)
    assert b1.iloc[:59].isna().all() and np.isfinite(b1.iloc[59])
    # 표본 규칙: 신호일 ∈ window, 둘 다 non-None
    sig = pd.Series(np.arange(100, dtype=float), index=days)
    sig.iloc[50] = np.nan
    lab = r1.forward_return(close, 1, pct=True)
    pairs = r1.align_pairs(sig, lab, window=(dt.date(2023, 1, 3), dt.date(2023, 3, 31)))
    assert pairs["date"].min() >= dt.date(2023, 1, 3) and pairs["date"].max() <= dt.date(2023, 3, 31)
    assert dt.date(2023, 1, 2) not in set(pairs["date"])
    assert days[50] not in set(pairs["date"])


def test_fold_of():
    assert r1.fold_of(dt.date(2023, 5, 1)) == "2023"
    assert r1.fold_of(dt.date(2026, 6, 30)) == "2026H1"
    assert r1.fold_of(dt.date(2026, 7, 1)) == "2026H2"


def test_ic_measurement_undecidable_below_min_n():
    days = _bdays(dt.date(2023, 1, 2), 300)
    sig = pd.Series(np.random.default_rng(0).normal(size=300), index=days)
    lab = pd.Series(np.random.default_rng(1).normal(size=300), index=days)
    r = r1.ic_measurement(sig, lab, 10, n_total=300)
    assert r["verdict"] == r1.UNDECIDABLE and r["n"] < 500


def test_ic_measurement_pass_and_fail_rules():
    rng = np.random.default_rng(3)
    days = _bdays(dt.date(2023, 1, 2), 900)
    x = rng.normal(size=900)
    sig = pd.Series(x, index=days)
    lab_pos = pd.Series(0.5 * x + rng.normal(size=900), index=days)
    r = r1.ic_measurement(sig, lab_pos, 10, need_ci_excludes_zero=True, n_boot=200, n_perm=200)
    assert r["verdict"] == r1.PASS and r["ci_lo"] > 0 and r["null_percentile"] > 99
    assert set(r["folds"]) == {"2023", "2024", "2025", "2026H1"}
    r_neg = r1.ic_measurement(sig, -lab_pos, 10, need_ci_excludes_zero=True, n_boot=200, n_perm=200)
    assert r_neg["verdict"] == r1.FAIL and r_neg["ci_excludes_zero"]      # 유의하지만 부호 반대 → FAIL
    r_null = r1.ic_measurement(sig, pd.Series(rng.normal(size=900), index=days), 10, need_ci_lo_pos=True, n_boot=200, n_perm=200)
    assert r_null["verdict"] == r1.FAIL


def test_combine_verdicts():
    assert r1._combine([r1.PASS, r1.PASS]) == r1.PASS
    assert r1._combine([r1.PASS, r1.UNDECIDABLE]) == r1.UNDECIDABLE
    assert r1._combine([r1.FAIL, r1.UNDECIDABLE]) == r1.FAIL


# ---------------------------------------------------------------------------
# 절단 비교
# ---------------------------------------------------------------------------

def _panel(n=10):
    days = _bdays(dt.date(2023, 1, 2), n)
    rows = []
    for sc in ("A", "B"):
        for i, d in enumerate(days):
            rows.append({"date": d, "scope": sc, "z": float(i) if i >= 3 else np.nan, "k": i, "lst": ["a", "b"] if i % 2 else [], "engine_ver": "x-0.1"})
    df = pd.DataFrame(rows)
    df["k"] = df["k"].astype("Int32")
    return df


def test_compare_panels_identical_and_diffs():
    full = _panel()
    cutoff = full["date"].iloc[6]
    same = r1.compare_panels(full, full.copy(), ["date", "scope"], cutoff)
    assert same["violations"] == 0 and same["rows_compared"] == 14
    # engine_ver 만 다르면 무시
    t = full.copy(); t["engine_ver"] = "y-0.2"
    assert r1.compare_panels(full, t, ["date", "scope"], cutoff)["violations"] == 0
    # 값 변경 1행 (절단일 이하)
    t = full.copy(); t.loc[4, "z"] = 99.0
    c = r1.compare_panels(full, t, ["date", "scope"], cutoff)
    assert c["violations"] == 1 and c["cols_differ"] == {"z": 1}
    # 절단일 이후 변경은 무시
    t = full.copy(); t.loc[9, "z"] = 99.0
    assert r1.compare_panels(full, t, ["date", "scope"], cutoff)["violations"] == 0
    # NaN ↔ 값
    t = full.copy(); t.loc[5, "z"] = np.nan
    assert r1.compare_panels(full, t, ["date", "scope"], cutoff)["violations"] == 1
    # −0.0 vs 0.0 은 비트 상이
    f2 = full.copy(); f2.loc[4, "z"] = 0.0
    t = f2.copy(); t.loc[4, "z"] = -0.0
    assert r1.compare_panels(f2, t, ["date", "scope"], cutoff)["violations"] == 1
    # 누락 행
    t = full.drop(index=[2])
    c = r1.compare_panels(full, t, ["date", "scope"], cutoff)
    assert c["rows_missing_in_trunc"] == 1 and c["violations"] == 1
    # Int / list 컬럼
    t = full.copy(); t.loc[3, "k"] = pd.NA
    assert r1.compare_panels(full, t, ["date", "scope"], cutoff)["cols_differ"] == {"k": 1}
    t = full.copy(); t.at[3, "lst"] = ["a"]
    assert r1.compare_panels(full, t, ["date", "scope"], cutoff)["cols_differ"] == {"lst": 1}


def test_choose_cutoffs_deterministic():
    days = _bdays(dt.date(2023, 1, 3), 850)
    a = r1.choose_cutoffs(days)
    b = r1.choose_cutoffs(days)
    assert a == b and len(a) == 12 and len(set(a)) == 12 and a == sorted(a)
    assert all(days[0] <= d <= days[-1] for d in a)


def test_make_truncated_data_dir_cuts_bronze_and_sox(tmp_path):
    src = tmp_path / "data"; (src / "bronze").mkdir(parents=True)
    days = _bdays(dt.date(2023, 1, 2), 30)
    for name, col in r1.BRONZE_CUT_COLUMN.items():
        tbl = pa.table({col: pa.array(days, type=pa.date32()), "v": pa.array(np.arange(30, dtype=float))})
        pq.write_table(tbl, src / "bronze" / f"{name}.parquet")
    cutoff = days[10]
    d = r1.make_truncated_data_dir(src, tmp_path / "work", cutoff)
    assert (d / "gold").is_dir() and (d / "silver").is_dir()
    for name, col in r1.BRONZE_CUT_COLUMN.items():
        t = pq.read_table(d / "bronze" / f"{name}.parquet")
        got = pd.to_datetime(t.column(col).to_pandas()).dt.date
        lim = cutoff - dt.timedelta(days=1) if name == "sox_daily" else cutoff
        assert got.max() <= lim, name
        assert t.schema.field(col).type == pa.date32()
    assert pq.read_table(d / "bronze" / "sox_daily.parquet").num_rows == 10
    assert pq.read_table(d / "bronze" / "ohlcv_adj.parquet").num_rows == 11


def test_settings_data_dir_override_via_env(tmp_path):
    """MTPRO_DATA_DIR 가 있으면 BRONZE/GOLD 가 그 아래, 없으면 ROOT/data (기본 불변) — 새 프로세스에서 확인."""
    code = "import sys; sys.path.insert(0, r'%s'); from mtpro import settings; print(settings.DATA_DIR); print(settings.BRONZE); print(settings.GOLD)" % (ROOT / "src")
    env = {k: v for k, v in os.environ.items() if k != "MTPRO_DATA_DIR"}
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout.splitlines()
    assert pathlib.Path(out[0]) == ROOT / "data" and pathlib.Path(out[1]) == ROOT / "data" / "bronze"
    env["MTPRO_DATA_DIR"] = str(tmp_path)
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout.splitlines()
    assert pathlib.Path(out[0]) == tmp_path.resolve() and pathlib.Path(out[2]) == tmp_path.resolve() / "gold"


def test_settings_default_unchanged_in_process():
    if not os.environ.get("MTPRO_DATA_DIR"):
        assert settings.DATA_DIR == settings.ROOT / "data"
        assert settings.BRONZE == settings.ROOT / "data" / "bronze"


# ---------------------------------------------------------------------------
# P4b · P5 헬퍼
# ---------------------------------------------------------------------------

def test_sox_alignment_check():
    days = _bdays(dt.date(2023, 1, 2), 5)
    g = pd.DataFrame({"date": days, "scope": "A", "sox_session_date": [d - dt.timedelta(days=1) for d in days],
                      "sox_align_status": ["ok"] * 5})
    assert r1.sox_alignment_check(g)["violations"] == 0
    g.loc[2, "sox_session_date"] = days[2]                     # 같은 날 세션 → 룩어헤드
    assert r1.sox_alignment_check(g)["violations"] == 1
    g.loc[3, "sox_session_date"] = None
    assert r1.sox_alignment_check(g)["violations"] == 1


def _gold_synthetic(n=200, zero_rows=0):
    days = _bdays(dt.date(2023, 1, 3), n)
    z = np.random.default_rng(0).normal(size=n)
    z[:78] = np.nan
    flow = pd.DataFrame({"date": days, "scope": "KOSPI200", "flow_beta_foreign": z, "flow_beta_inst": z, "flow_impact_residual_z": z, "flow_trend_z": np.r_[[np.nan] * 83, z[83:]]})
    breadth = pd.DataFrame({"date": days, "breadth_impulse_z": z})
    gradec = pd.DataFrame({"date": days, "scope": "KOSPI200", "beta_sox_raw": z, "beta_sox": z, "err_z": z, "good_acceptance_z": z, "bad_resilience_z": z, "good_beta": z, "bad_beta": z})
    e = np.where(np.isnan(z), np.nan, np.sign(z) * np.ceil(np.abs(z) * 30))   # 정확히 0 없음
    if zero_rows:
        e[100:100 + zero_rows] = 0.0
    energy = pd.DataFrame({"date": days, "scope": "KOSPI200", "flow_z": z, "breadth_z": z, "gradec_err_z": z, "energy_lite": e,
                           "good_acceptance_z": z, "bad_resilience_z": z, "good_beta": z, "bad_beta": z})
    return {"flow_panel": flow, "breadth_panel": breadth, "gradec_panel": gradec, "energy_lite_panel": energy}


def test_zero_share_and_warmup_checks():
    gold = _gold_synthetic()
    zs = r1.zero_share_check(gold)
    assert zs["verdict"] == r1.PASS
    wu = r1.warmup_none_check(gold)
    assert wu["verdict"] == r1.PASS
    assert wu["columns"]["flow_panel.flow_beta_foreign[KOSPI200]"]["leading_none_rows"] == 78
    # 워밍업 구간에 0 대체가 있으면 (ii) 실패
    bad = _gold_synthetic()
    bad["flow_panel"].loc[10, "flow_beta_foreign"] = 0.0
    assert r1.warmup_none_check(bad)["verdict"] == r1.FAIL
    # 0.0 비율 초과(β 컬럼) → (i) 실패
    bad2 = _gold_synthetic()
    bad2["gradec_panel"].loc[100:110, "beta_sox"] = 0.0
    assert r1.zero_share_check(bad2)["verdict"] == r1.FAIL


def test_grep_zero_substitution_finds_planted(tmp_path):
    root = tmp_path
    (root / "src" / "mtpro" / "components").mkdir(parents=True)
    (root / "src" / "mtpro" / "core").mkdir(parents=True)
    (root / "jobs").mkdir()
    (root / "src" / "mtpro" / "components" / "a.py").write_text("x = s.fillna(0)\ny = v or 0.0\n# fillna(0) in comment only\n", encoding="utf-8")
    (root / "src" / "mtpro" / "core" / "b.py").write_text("z = np.nan_to_num(a)\n", encoding="utf-8")
    (root / "jobs" / "build_x.py").write_text("q = 1\n", encoding="utf-8")
    g = r1.grep_zero_substitution(root)
    assert g["verdict"] == r1.FAIL and len(g["hits"]) == 2 and len(g["aux_hits"]) == 1
    (root / "src" / "mtpro" / "components" / "a.py").write_text("x = s\n", encoding="utf-8")
    assert r1.grep_zero_substitution(root)["verdict"] == r1.PASS


def test_render_markdown_smoke():
    """evaluate 없이 최소 summary 로 렌더링이 깨지지 않는지."""
    days = _bdays(dt.date(2023, 1, 2), 900)
    rng = np.random.default_rng(9)
    x = rng.normal(size=900)
    sig = pd.Series(x, index=days)
    lab = pd.Series(0.3 * x + rng.normal(size=900), index=days)
    r = r1.ic_measurement(sig, lab, 10, n_boot=50, n_perm=50, n_total=900)
    pa_ = {"b1_ma20_60": {"pearson": 0.1, "n": 800, "spearman": 0.1, "verdict": r1.PASS}, "b2_above_20d_ratio": {"pearson": 0.2, "n": 800, "spearman": 0.2, "verdict": r1.PASS}, "verdict": r1.PASS}
    s = {"finished_at": "2026-08-17T00:00:00", "elapsed_seconds": 1.0, "final": r1.FAIL,
         "meta": {"data_dir": "x", "panels": {"flow_panel": {"rows": 1, "date_range": ["a", "b"], "engine_ver": "v"}}},
         "verdicts": {"P1": r1.PASS, "P2": r1.PASS, "P3-a": r1.PASS, "P3-b": r1.PASS, "P4": r1.UNDECIDABLE, "P5": r1.PASS},
         "P1": {"scopes": {sc: r for sc in r1.SCOPES}, "verdict": r1.PASS},
         "P2": {"scopes": {"KOSPI200": r}, "aux_scopes": {"005930": r, "000660": r}, "verdict": r1.PASS},
         "P3": {"a": {"scopes": {sc: pa_ for sc in r1.SCOPES}, "verdict": r1.PASS}, "b": {"scopes": {sc: r for sc in r1.SCOPES}, "verdict": r1.PASS},
                "aux_h5": {sc: r for sc in r1.SCOPES}, "baseline_ic21": {sc: {"b1_ma20_60": r, "b2_above_20d_ratio": r} for sc in r1.SCOPES}, "verdict": r1.PASS},
         "P4": {"a_truncation": {"cutoffs": ["2023-02-07"], "runs": [], "total_violations": None, "pipeline_failures": [], "verdict": r1.UNDECIDABLE, "note": "skipped"},
                "b_sox_alignment": {"rows": 1, "rows_with_session": 1, "violations": 0, "max_session_minus_date_days": -1, "status_counts": {"ok": 1}, "verdict": r1.PASS},
                "c_fetch_ts": {"build_time_utc_min": "t", "bronze": {"ohlcv_adj": {"fetch_ts_max": "2026-08-17 10:20:43+00:00"}}, "violations": 0, "verdict": r1.PASS},
                "verdict": r1.UNDECIDABLE},
         "P5": {"i_zero_share": {"columns": {"a.b": {"n_valid": 1, "n_zero": 0, "zero_share": 0.0, "within_limit": True}}, "verdict": r1.PASS},
                "ii_warmup_none": {"columns": {"a.b": {"first_valid_date": "d", "leading_none_rows": 1, "leading_all_none": True, "warmup_min_rows": None, "ok": True}}, "verdict": r1.PASS},
                "iii_grep": {"patterns": ["p"], "dirs": ["d"], "hits": [], "aux_dirs": ["e"], "aux_hits": [], "verdict": r1.PASS}, "verdict": r1.PASS},
         "interpretations": r1.INTERPRETATIONS}
    md = r1.render_markdown(s, DOC)
    assert "## D-A 조건 명시" in md and "gradec_err" in md and "최종 판정 한 줄" in md and "해석 기록" in md
