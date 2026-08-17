"""C-1 지수 단위 대사 잡 (1회). 실행(cwd=mtpro): `.venv\\Scripts\\python.exe jobs\\reconcile_flow.py [--no-write]`
전제: jobs/ingest_krx.py 로 investor_flow·constituents·investor_flow_constituents 적재 완료.
출력: docs/mtpro-t3-flow-reconcile.md + config/mtpro.yaml flow.index_unit/reconcile_result 갱신 + stdout JSON."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mtpro.components import flow_reconcile                # noqa: E402

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()
    res = flow_reconcile.run(write=not a.no_write)
    print(json.dumps(res, ensure_ascii=False, indent=1, default=str))
