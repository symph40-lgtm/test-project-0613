"""C-1 대사 단위 테스트 (합성, 네트워크 없음): PIT 멤버십·합산·상관 판정 규칙·config 갱신."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

from mtpro.components import flow_reconcile as fr


def _consts():
    return pd.DataFrame({"asof": [dt.date(2023, 1, 2)] * 2 + [dt.date(2023, 2, 1)] * 2, "index_code": "1028",
                         "code": ["A", "B", "A", "C"]})


def test_pit_membership_uses_latest_snapshot_at_or_before_date():
    m = fr.pit_membership(_consts(), [dt.date(2022, 12, 30), dt.date(2023, 1, 2), dt.date(2023, 1, 31), dt.date(2023, 2, 1), dt.date(2023, 3, 1)])
    assert dt.date(2022, 12, 30) not in m
    assert m[dt.date(2023, 1, 31)] == (dt.date(2023, 1, 2), frozenset({"A", "B"}))
    assert m[dt.date(2023, 3, 1)][1] == frozenset({"A", "C"})


def test_pit_constituent_sum_counts_used_and_missing():
    days = [dt.date(2023, 1, 3), dt.date(2023, 2, 2)]
    rows = []
    for d in days:
        for c, f in (("A", 1.0), ("B", 10.0), ("C", 100.0), ("Z", 1000.0)):
            if c == "C" and d == days[1]:
                continue                                                          # C 는 2월에 결측
            rows.append({"date": d, "scope": c, "foreign": f, "institution": -f})
    s = fr.pit_constituent_sum(pd.DataFrame(rows), _consts())
    r1, r2 = s.iloc[0], s.iloc[1]
    assert r1["foreign"] == 11.0 and r1["n_constituents_used"] == 2 and r1["n_constituents"] == 2      # A+B, Z 비구성
    assert r2["foreign"] == 1.0 and r2["n_constituents_used"] == 1 and r2["n_constituents"] == 2       # A 만 (C 결측)
    assert r2["institution"] == -1.0


def _mk(n, corr_target):
    rng = np.random.default_rng(3)
    d = pd.bdate_range("2023-01-03", periods=n).date
    x = rng.normal(0, 1, n)
    y = corr_target * x + np.sqrt(1 - corr_target ** 2) * rng.normal(0, 1, n)
    mkt = pd.DataFrame({"date": d, "foreign": x, "institution": x})
    summed = pd.DataFrame({"date": d, "foreign": y, "institution": x, "n_constituents_used": 200})
    return mkt, summed


def test_reconcile_keeps_market_when_both_corr_high():
    mkt, summed = _mk(600, 0.99)
    r = fr.reconcile(mkt, summed)
    assert r["corr_institution"] == 1.0 and r["corr_foreign"] > 0.95
    assert r["decision"] == "KOSPI_MARKET" and r["n_days"] == 600
    assert 0 <= r["sign_agree_foreign"] <= 1


def test_reconcile_replaces_when_any_corr_below_threshold():
    mkt, summed = _mk(600, 0.3)
    r = fr.reconcile(mkt, summed)
    assert r["corr_foreign"] < 0.8 and r["corr_institution"] == 1.0
    assert r["decision"] == "PIT_CONSTITUENT_SUM"


def test_reconcile_window_filter():
    mkt, summed = _mk(1200, 0.99)                       # 2023-01-03 ~ 2027-08 → 창 밖은 제외
    r = fr.reconcile(mkt, summed)
    assert r["n_days"] < 1200 and r["window"] == ["2023-01-03", "2026-06-30"]


def test_update_config_rewrites_index_unit_and_records_result(tmp_path):
    p = tmp_path / "mtpro.yaml"
    p.write_text("version: x\nflow:                                          # 부품 4\n  index_unit: KOSPI_MARKET                     # 주석\n"
                 "  reconcile:\n    alternative: PIT_CONSTITUENT_SUM\n    replace_if_below: 0.8\n  denominator: trading_value_mean20\nbreadth:\n  x: 1\n", encoding="utf-8")
    res = {"decision": "PIT_CONSTITUENT_SUM", "corr_foreign": 0.5, "corr_institution": 0.9, "sign_agree_foreign": 0.7,
           "sign_agree_institution": 0.9, "n_days": 10, "decided_on": "2026-08-17"}
    fr.update_config(res, p)
    import yaml
    cfg = yaml.safe_load(p.read_text(encoding="utf-8"))
    assert cfg["flow"]["index_unit"] == "PIT_CONSTITUENT_SUM"
    assert cfg["flow"]["reconcile_result"]["corr_foreign"] == 0.5 and cfg["flow"]["reconcile_result"]["decision"] == "PIT_CONSTITUENT_SUM"
    assert cfg["flow"]["denominator"] == "trading_value_mean20" and cfg["breadth"] == {"x": 1}
    assert "# 주석" in p.read_text(encoding="utf-8")
    # 재실행(idempotent): 블록 교체, 중복 없음
    res["decision"] = "KOSPI_MARKET"
    fr.update_config(res, p)
    txt = p.read_text(encoding="utf-8")
    assert txt.count("reconcile_result:") == 1 and yaml.safe_load(txt)["flow"]["index_unit"] == "KOSPI_MARKET"
