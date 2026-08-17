"""Gate R1 측정 잡 (T4). 실행(cwd=mtpro): `.venv\\Scripts\\python.exe jobs\\run_gate_r1.py [--skip-truncation] [--workdir DIR] [--keep-workdirs]`

- 사전 등록 문서(docs/mtpro-t4-gate-r1-prereg.md) §6 상수 블록과 `mtpro.gate.r1.PREREG` 대조 → 불일치면 즉시 종료(exit 2).
- P1~P5 전부 실행 → logs/gate_r1_summary.json + docs/mtpro-t4-gate-r1-result.md. 진행 로그 stdout.
- P4(a) 절단 재산출은 임시 데이터 디렉토리(기본 .cache/gate_r1_trunc/<절단일>)에 대해 전 파이프라인을 서브프로세스로 재실행한다
  (MTPRO_DATA_DIR 환경변수). 원본 data/·gold 는 읽기만 한다.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from mtpro import settings  # noqa: E402
from mtpro.gate import r1  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, default=None, help="기본 settings.DATA_DIR")
    ap.add_argument("--skip-truncation", action="store_true", help="P4(a) 절단 재산출 생략(개발용 — 결과는 판정 불가로 기록)")
    ap.add_argument("--workdir", type=Path, default=None, help="절단 재산출 임시 디렉토리(기본 .cache/gate_r1_trunc)")
    ap.add_argument("--keep-workdirs", action="store_true")
    ap.add_argument("--out-json", type=Path, default=r1.SUMMARY_JSON)
    ap.add_argument("--out-md", type=Path, default=r1.DOC_RESULT)
    a = ap.parse_args(argv)
    settings.ensure_dirs()
    t0 = time.time()

    def log(msg: str) -> None:
        print(f"[{time.time() - t0:7.1f}s] {msg}", flush=True)

    try:
        summary = r1.evaluate(a.data_dir, run_truncation=not a.skip_truncation, workdir=a.workdir, keep_workdirs=a.keep_workdirs, log=log)
    except r1.PreregMismatch as e:
        print(f"GATE_R1_PREREG_MISMATCH {e}", file=sys.stderr)
        return 2
    jp, mp = r1.write_outputs(summary, a.out_json, a.out_md)
    log(f"wrote {jp}")
    log(f"wrote {mp}")
    log(f"FINAL: {summary['final']}  verdicts={summary['verdicts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
