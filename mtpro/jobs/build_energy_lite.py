"""Energy-Lite 빌드 잡 (T3-D) — gold/{flow,breadth,gradec}_panel.parquet → gold/energy_lite_panel.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_energy_lite.py [--wait-minutes 20] [--summary-json path]

- 입력 gold 파일이 아직 없으면 --wait-minutes 동안 60초 간격 대기(다른 잡이 산출 중일 수 있음). 시간 초과 시 exit 3 (loud).
- config/mtpro.yaml 의 energy_lite 블록(가중·min_components·z_window·scopes)이 모듈 상수와 일치하는지 먼저 assert (불일치 exit 2).
- 입력은 읽기만 한다. Gate R1 측정은 하지 않는다 (T4, 관문 사전 등록 후).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import pyarrow.parquet as pq  # noqa: E402

from mtpro import settings  # noqa: E402
from mtpro.components import energy_lite as EL  # noqa: E402

INPUT_FILES = {"flow": EL.P_FLOW_PANEL, "breadth": EL.P_BREADTH_PANEL, "gradec": EL.P_GRADEC_PANEL}


def wait_for_inputs(minutes: float, interval_s: int = 60) -> bool:
    deadline = time.time() + minutes * 60
    while True:
        missing = [k for k, p in INPUT_FILES.items() if not p.exists()]
        if not missing:
            return True
        if time.time() >= deadline:
            print(f"ENERGY_LITE_WAIT_TIMEOUT missing={missing}", file=sys.stderr)
            return False
        print(f"[wait] gold missing {missing} — retry in {interval_s}s "
              f"(remaining {int((deadline - time.time()) / 60)} min)", flush=True)
        time.sleep(interval_s)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-minutes", type=float, default=0.0)
    ap.add_argument("--summary-json", type=str, default=None)
    args = ap.parse_args(argv)

    if not wait_for_inputs(args.wait_minutes):
        return 3
    try:
        block = EL.assert_config_matches(EL.load_config())
    except EL.EnergyLiteInputError as e:
        print(f"ENERGY_LITE_CONFIG_MISMATCH {e}", file=sys.stderr)
        return 2

    inputs_meta = {}
    frames = {}
    for k, p in INPUT_FILES.items():
        df = pq.read_table(p).to_pandas()
        frames[k] = df
        inputs_meta[k] = {"path": str(p), "rows": int(len(df)),
                          "mtime": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                          "engine_ver": str(df["engine_ver"].iloc[0]) if "engine_ver" in df.columns and len(df) else None}

    settings.ensure_dirs()
    panel = EL.compute_energy_lite_panel(frames["flow"], frames["breadth"], frames["gradec"],
                                         weights=EL.WEIGHTS, min_components=EL.MIN_COMPONENTS, scopes=EL.SCOPES)
    out = EL.write_gold(panel)

    summary = {
        "built_at": datetime.now().isoformat(timespec="seconds"),
        "engine_ver": EL.ENGINE_VER,
        "constants": {"weights": EL.WEIGHTS, "min_components": EL.MIN_COMPONENTS, "z_window_days": EL.Z_WINDOW_DAYS,
                      "delta_params": EL.DELTA_PARAMS, "gradec_err": EL.GRADEC_ERR_DEFINITION,
                      "config_block": block},
        "inputs": inputs_meta,
        "output": {"path": str(out), "rows": int(len(panel))},
        "by_scope": EL.summarize_panel(panel),
    }
    text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
    print(text)
    if args.summary_json:
        Path(args.summary_json).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
