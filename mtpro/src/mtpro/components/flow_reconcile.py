"""C-1 대사 (T1 부록 C, 사전 등록 문안 그대로 — T3 부품 4 구현 중 **1회**, 이후 재론 금지).

교체 대상 = PIT 구성종목 합산 순매수 (월초 스냅샷 리스트 × 종목별 get_market_trading_value_by_date 합) 단 하나.
대사 구간 2023-01-03 ~ 2026-06-30. 지표 = KOSPI 시장 전체 vs 합산의 일별 외국인·기관 순매수 피어슨 상관(각각).
규칙: 둘 중 하나라도 < 0.8 이면 합산(PIT_CONSTITUENT_SUM)으로 교체, 아니면 KOSPI_MARKET 유지.
결과·판정·부호 일치율 → docs/mtpro-t3-flow-reconcile.md, config/mtpro.yaml flow.index_unit / flow.reconcile_result 갱신.

입력(bronze): investor_flow_constituents.parquet (scope=종목), constituents.parquet (asof·code), investor_flow.parquet (scope=KOSPI).
날짜 d 의 구성 리스트 = asof ≤ d 인 가장 최근 월초 스냅샷 (부품 5 와 동일 규칙). 그날 데이터가 없는 구성종목은 합에서 빠지며
`n_constituents_used` 로 기록(0 대체가 아니라 가용 종목 합 — 결측 종목 수를 명시).
"""
from __future__ import annotations

import datetime as dt
import re
from pathlib import Path

import numpy as np
import pandas as pd

from mtpro import settings

WINDOW = (dt.date(2023, 1, 3), dt.date(2026, 6, 30))
THRESHOLD = 0.8
DOC_PATH = settings.ROOT / "docs" / "mtpro-t3-flow-reconcile.md"


def _read(path: Path) -> pd.DataFrame:
    from mtpro.ingest import store
    df = store.read(path)
    if df is None or not len(df):
        raise RuntimeError(f"reconcile input missing: {path}")
    return df


def pit_membership(constituents: pd.DataFrame, dates: list[dt.date]) -> dict[dt.date, tuple[dt.date, frozenset[str]]]:
    """날짜 → (asof, 구성 집합). asof ≤ date 인 최신 스냅샷. 첫 스냅샷 이전 날짜는 제외."""
    c = constituents.copy()
    c["asof"] = pd.to_datetime(c["asof"]).dt.date
    snaps = {a: frozenset(g["code"].astype(str)) for a, g in c.groupby("asof")}
    asofs = sorted(snaps)
    out = {}
    j = 0
    for d in sorted(dates):
        while j + 1 < len(asofs) and asofs[j + 1] <= d:
            j += 1
        if asofs[j] <= d:
            out[d] = (asofs[j], snaps[asofs[j]])
    return out


def pit_constituent_sum(flow_const: pd.DataFrame | None = None, constituents: pd.DataFrame | None = None,
                        start: dt.date | None = None, end: dt.date | None = None) -> pd.DataFrame:
    """일별 PIT 구성종목 합산 순매수. 반환 컬럼: date, foreign, institution, n_constituents, n_constituents_used, asof."""
    from mtpro.ingest import krx
    fc = flow_const if flow_const is not None else _read(krx.P_INVESTOR_FLOW_CONST)
    cs = constituents if constituents is not None else _read(krx.P_CONSTITUENTS)
    fc = fc.copy()
    fc["date"] = pd.to_datetime(fc["date"]).dt.date
    fc["scope"] = fc["scope"].astype(str)
    if start:
        fc = fc[fc["date"] >= start]
    if end:
        fc = fc[fc["date"] <= end]
    dates = sorted(fc["date"].unique())
    member = pit_membership(cs, dates)
    rows = []
    for d, g in fc.groupby("date"):
        if d not in member:
            continue
        asof, codes = member[d]
        sub = g[g["scope"].isin(codes)]
        rows.append({"date": d, "foreign": float(sub["foreign"].sum()) if len(sub) else None,
                     "institution": float(sub["institution"].sum()) if len(sub) else None,
                     "n_constituents": len(codes), "n_constituents_used": int(len(sub)), "asof": asof})
    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def reconcile(market: pd.DataFrame, summed: pd.DataFrame, window=WINDOW, threshold: float = THRESHOLD) -> dict:
    """market: investor_flow(scope=KOSPI) 행. summed: pit_constituent_sum 출력. 순수 함수(테스트 가능)."""
    m = market.copy()
    m["date"] = pd.to_datetime(m["date"]).dt.date
    m = m[(m["date"] >= window[0]) & (m["date"] <= window[1])][["date", "foreign", "institution"]]
    s = summed.copy()
    s["date"] = pd.to_datetime(s["date"]).dt.date
    s = s[(s["date"] >= window[0]) & (s["date"] <= window[1])]
    j = m.merge(s, on="date", how="inner", suffixes=("_mkt", "_sum")).dropna(subset=["foreign_mkt", "foreign_sum", "institution_mkt", "institution_sum"])
    res = {"window": [str(window[0]), str(window[1])], "n_days": int(len(j)), "threshold": threshold}
    for k in ("foreign", "institution"):
        a, b = j[f"{k}_mkt"].astype(float), j[f"{k}_sum"].astype(float)
        corr = float(np.corrcoef(a, b)[0, 1]) if len(j) > 2 else None
        res[f"corr_{k}"] = round(corr, 4) if corr is not None else None
        res[f"sign_agree_{k}"] = round(float((np.sign(a) == np.sign(b)).mean()), 4) if len(j) else None
        res[f"ratio_sum_over_mkt_{k}"] = round(float(b.abs().sum() / a.abs().sum()), 4) if len(j) and a.abs().sum() > 0 else None
    if "n_constituents_used" in j.columns:
        res["n_constituents_used_min"] = int(j["n_constituents_used"].min())
        res["n_constituents_used_median"] = float(j["n_constituents_used"].median())
    corrs = [res["corr_foreign"], res["corr_institution"]]
    replace = any(c is None or c < threshold for c in corrs)
    res["decision"] = "PIT_CONSTITUENT_SUM" if replace else "KOSPI_MARKET"
    res["decided_on"] = str(dt.date.today())
    return res


def update_config(res: dict, path: Path | None = None) -> str:
    """config/mtpro.yaml 의 flow.index_unit 을 판정대로 갱신하고 flow.reconcile_result 블록을 기록(주석 보존, 텍스트 편집)."""
    p = path or (settings.CONFIG_DIR / "mtpro.yaml")
    txt = p.read_text(encoding="utf-8")
    txt = re.sub(r"^(  index_unit:\s*)\S+", rf"\g<1>{res['decision']}", txt, count=1, flags=re.M)
    block = (
        "  reconcile_result:                            # C-1 판정 기록 (T3 1회, 재론 금지)\n"
        f"    corr_foreign: {res['corr_foreign']}\n"
        f"    corr_institution: {res['corr_institution']}\n"
        f"    sign_agree_foreign: {res['sign_agree_foreign']}\n"
        f"    sign_agree_institution: {res['sign_agree_institution']}\n"
        f"    n_days: {res['n_days']}\n"
        f"    decision: {res['decision']}\n"
        f"    decided_on: {res['decided_on']}\n"
    )
    if re.search(r"^  reconcile_result:", txt, flags=re.M):
        txt = re.sub(r"^  reconcile_result:.*?(?=^\S|^  [a-z_]+:)", block, txt, count=1, flags=re.M | re.S)
    else:
        txt = re.sub(r"^(  denominator:)", block + r"\1", txt, count=1, flags=re.M)
    p.write_text(txt, encoding="utf-8")
    return txt


def write_doc(res: dict, ingest_info: dict | None = None, path: Path = DOC_PATH) -> None:
    lines = [
        "# MT-PRO T3 — C-1 지수 단위 대사 (KOSPI 시장 전체 vs PIT 구성종목 합산)",
        "",
        f"- 판정일: {res['decided_on']} · 사전 등록 문안: `docs/mtpro-t1-procurement.md` 부록 C C-1 · config `flow.reconcile` (window {res['window'][0]}~{res['window'][1]}, replace_if_below {res['threshold']})",
        "- 실행: `jobs/reconcile_flow.py` → `src/mtpro/components/flow_reconcile.py` (1회, 이후 재론 금지)",
        "- 합산 = 각 거래일의 PIT 월초 스냅샷(`data/bronze/constituents.parquet`, asof ≤ 날짜 최신) 구성종목의 `get_market_trading_value_by_date` 순매수 합 (`data/bronze/investor_flow_constituents.parquet`). 그날 행이 없는 구성종목은 합에서 빠지고 `n_constituents_used` 로 기록.",
        "",
        "## 결과",
        "",
        "| 지표 | 외국인 | 기관 |",
        "|---|---|---|",
        f"| 피어슨 상관 (일별 순매수, n={res['n_days']}) | **{res['corr_foreign']}** | **{res['corr_institution']}** |",
        f"| 부호 일치율 | {res['sign_agree_foreign']} | {res['sign_agree_institution']} |",
        f"| Σ\\|합산\\| / Σ\\|시장\\| | {res.get('ratio_sum_over_mkt_foreign')} | {res.get('ratio_sum_over_mkt_institution')} |",
        "",
        f"- 사용 구성종목 수: 최소 {res.get('n_constituents_used_min')} · 중앙값 {res.get('n_constituents_used_median')} (스냅샷 200 기준)",
    ]
    if ingest_info:
        lines.append(f"- 구성종목 수급 캐시: 종목 {ingest_info.get('tickers')} · 성공 {ingest_info.get('ok')} · 결측 {len(ingest_info.get('missing') or {})} · 행 {ingest_info.get('rows_total')} · 소요 {ingest_info.get('seconds')}s")
        if ingest_info.get("missing"):
            lines.append(f"  - 결측 종목: {', '.join(sorted(ingest_info['missing']))}")
    lines += [
        "",
        "## 판정",
        "",
        f"- 규칙: 외국인·기관 상관 중 **하나라도 < {res['threshold']} 이면 PIT_CONSTITUENT_SUM 으로 교체**, 아니면 KOSPI_MARKET 유지.",
        f"- **판정: `flow.index_unit = {res['decision']}`** (config/mtpro.yaml 갱신, `flow.reconcile_result` 에 값 기록). 이후 재론 금지.",
        "- 부품 4 KOSPI200 스코프(`components/flow.py`)는 이 판정 소스를 사용한다.",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def run(write: bool = True) -> dict:
    """전체 실행: 합산 → 대사 → 문서·config 갱신. bronze 캐시가 없으면 먼저 jobs/ingest_krx.py --only const_flow."""
    from mtpro.ingest import krx
    market = _read(krx.P_INVESTOR_FLOW)
    market = market[market["scope"] == "KOSPI"]
    summed = pit_constituent_sum(start=WINDOW[0], end=WINDOW[1])
    res = reconcile(market, summed)
    if write:
        info = None
        summ = settings.LOG_DIR / "ingest_krx_summary.json"
        if summ.exists():
            import json
            info = json.loads(summ.read_text(encoding="utf-8")).get("steps", {}).get("const_flow")
        write_doc(res, info)
        update_config(res)
    return res
