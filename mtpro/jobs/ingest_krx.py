"""T3-A KRX bronze 적재 잡. 실행(cwd=mtpro): `.venv\\Scripts\\python.exe jobs\\ingest_krx.py [--only a,b,...] [--end YYYY-MM-DD]`

단계(순서 고정 — 뒤 단계가 앞 단계 산출을 캘린더/유니버스로 씀):
  flow        투자자별 순매수 005930·000660·KOSPI (2023-01-03~)      → bronze/investor_flow.parquet
  ohlcv_unadj 비수정 OHLCV 005930·000660 + KOSPI 시장 거래대금       → bronze/ohlcv_unadj.parquet
  ohlcv_adj   수정주가 OHLCV 005930·000660 + KOSPI200(1028) 2022~   → bronze/ohlcv_adj.parquet
  pit         월초 PIT 구성종목 + 시총 단면                          → bronze/constituents.parquet, market_cap.parquet
  const_ohlcv 구성종목 합집합 수정주가 OHLCV 2022~                    → bronze/ohlcv_adj_constituents.parquet
  const_flow  구성종목별 투자자별 순매수 (C-1 대사 캐시) 2023~          → bronze/investor_flow_constituents.parquet
loud-failure: 예외 그대로 전파(PROCURE_FAIL:*), logs/alerts.jsonl 기록. 요약 → logs/ingest_krx_summary.json + docs/mtpro-t3a-ingest.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mtpro import settings                      # noqa: E402
from mtpro.ingest import krx                    # noqa: E402

STEPS = ["flow", "ohlcv_unadj", "ohlcv_adj", "pit", "const_ohlcv", "const_flow"]
DOC = ROOT / "docs" / "mtpro-t3a-ingest.md"
SUMMARY = settings.LOG_DIR / "ingest_krx_summary.json"


def run(only: list[str], end: dt.date | None) -> dict:
    settings.ensure_dirs()
    out: dict = {"run_ts_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "steps": {}}
    prev = json.loads(SUMMARY.read_text(encoding="utf-8")) if SUMMARY.exists() else {}
    for step, r in prev.get("steps", {}).items():          # 이번에 안 돈 단계는 직전 실행 결과를 보존(문서 누적)
        if step not in only:
            out["steps"][step] = {**r, "carried_from": prev.get("run_ts_utc")}
    for step in STEPS:
        if step not in only:
            continue
        t0 = time.time()
        if step == "flow":
            r = krx.ingest_investor_flow(end=end)
        elif step == "ohlcv_unadj":
            r = krx.ingest_ohlcv_unadj(end=end)
        elif step == "ohlcv_adj":
            r = krx.ingest_ohlcv_adj(end=end)
        elif step == "pit":
            r = krx.ingest_constituents_and_mcap(end=end)
        elif step == "const_ohlcv":
            r = krx.ingest_constituent_ohlcv_adj(end=end)
        elif step == "const_flow":
            r = krx.ingest_constituent_flow(end=end)
        r["seconds"] = round(time.time() - t0, 1)
        out["steps"][step] = r
        print(f"[ingest_krx] {step}: {json.dumps({k: v for k, v in r.items() if k != 'missing'}, ensure_ascii=False)[:400]}", file=sys.stderr)
    out["files"] = {
        "investor_flow": krx.summarize_parquet(krx.P_INVESTOR_FLOW, "date", "scope"),
        "ohlcv_unadj": krx.summarize_parquet(krx.P_OHLCV_UNADJ, "date", "code"),
        "ohlcv_adj": krx.summarize_parquet(krx.P_OHLCV_ADJ, "date", "code"),
        "constituents": krx.summarize_parquet(krx.P_CONSTITUENTS, "asof", "code"),
        "market_cap": krx.summarize_parquet(krx.P_MARKET_CAP, "asof", "code"),
        "ohlcv_adj_constituents": krx.summarize_parquet(krx.P_OHLCV_ADJ_CONST, "date", "code"),
        "investor_flow_constituents": krx.summarize_parquet(krx.P_INVESTOR_FLOW_CONST, "date", "scope"),
    }
    out["steps"] = {s: out["steps"][s] for s in STEPS if s in out["steps"]}
    out["total_seconds"] = round(sum(s.get("seconds", 0) for s in out["steps"].values()), 1)   # 보존 단계 포함(최초 적재 합계)
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    write_doc(out)
    return out


def write_doc(out: dict) -> None:
    files = out["files"]
    steps = out["steps"]
    miss_o = steps.get("const_ohlcv", {}).get("missing", {})
    miss_f = steps.get("const_flow", {}).get("missing", {})
    L = [
        "# MT-PRO T3-A — KRX bronze 적재 요약 (`jobs/ingest_krx.py`)",
        "",
        f"- 실행: {out['run_ts_utc']} (UTC) · 실행 단계: {', '.join(steps)} · 소요 합계 {out['total_seconds']}s",
        "- 원천: pykrx(KRX 로그인 세션, `settings.krx_env()` = 기존 저장소 `.env.local`의 KRX_ID/KRX_PW만) · 스키마 `schema.BRONZE_*` · 모든 행 source/fetch_ts(UTC)/price_adjusted 기록",
        "- loud-failure: KRX_ENV(계정 없음)·KRX_SESSION(핵심 시계열 0행)·KRX_API(3회 재시도 실패) → 예외 + logs/alerts.jsonl. 구성종목 개별 0행은 결측 목록으로 기록(저장 생략).",
        "",
        "| 파일 (data/bronze) | 행 수 | 구간 | 키 수(scope/code) | 결측 셀 | 비고 |",
        "|---|---|---|---|---|---|",
    ]
    notes = {
        "investor_flow": "005930·000660·KOSPI(시장 전체) 순매수, krx_session=True",
        "ohlcv_unadj": "price_adjusted=False; KOSPI 행은 거래대금(매수 총액)만, OHLC None",
        "ohlcv_adj": "price_adjusted=True, trading_value None; KOSPI200 = 지수 1028",
        "constituents": "월초 첫 거래일 PIT 스냅샷 (asof)",
        "market_cap": "같은 asof KOSPI 시총 단면 (price_adjusted=False)",
        "ohlcv_adj_constituents": f"역대 PIT 합집합, 결측 종목 {len(miss_o)}",
        "investor_flow_constituents": f"C-1 대사 캐시, 결측 종목 {len(miss_f)}",
    }
    for k, v in files.items():
        rng = f"{v['range'][0]} ~ {v['range'][1]}" if v.get("range") else "-"
        L.append(f"| {k}.parquet | {v.get('rows', 0):,} | {rng} | {v.get('keys', '-')} | {v.get('na_cells', '-')} | {notes[k]} |")
    L += ["", "## 단계별 실행 결과", ""]
    for s, r in steps.items():
        rr = {k: v for k, v in r.items() if k not in ("missing",)}
        carried = f", 직전 실행 {r['carried_from']} 결과 보존" if r.get("carried_from") else ""
        L.append(f"- **{s}** ({r.get('seconds')}s{carried}): `{json.dumps(rr, ensure_ascii=False, default=str)[:600]}`")
        if r.get("missing"):
            L.append(f"  - 결측 종목 {len(r['missing'])}: " + ", ".join(f"{c}({why[:24]})" for c, why in sorted(r["missing"].items())))
        if r.get("rolled"):
            L.append(f"  - 월초 롤링: {r['rolled']}")
    L.append("")
    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=",".join(STEPS), help="comma list of " + ",".join(STEPS))
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default today)")
    a = ap.parse_args()
    end = dt.date.fromisoformat(a.end) if a.end else None
    only = [s.strip() for s in a.only.split(",") if s.strip()]
    bad = [s for s in only if s not in STEPS]
    if bad:
        raise SystemExit(f"unknown steps {bad}")
    res = run(only, end)
    print(json.dumps({"files": res["files"], "total_seconds": res["total_seconds"]}, ensure_ascii=False, indent=1))
