"""mt_state 빌드 잡 (T5-5) — gold/{gap3g,transmission,flow,breadth,semi_diffusion}_panel + psa_events → gold/mt_state.parquet
(+ gold/{reaction,price_accept,participation,upper_state}_panel.parquet, gold/challengers/{energy_*,dmt_*,div_*}.parquet).

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_mt_state.py [--start 2023-01-03] [--end 2026-08-14] [--scopes KOSPI200 005930 000660]
                                                    [--summary-json path] [--no-write]

- config/mtpro.yaml 의 energy_family · upper_state · outputs 블록 = 모듈 상수 검증 (불일치 exit 2, 입력 결손 exit 3).
- 입력은 읽기만 한다. Energy-Lite(gold/energy_lite_panel) 는 건드리지 않는다(소급 기록).
- --start/--end 는 출력 절단만(계산은 입력 전 구간).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from mtpro import settings  # noqa: E402
from mtpro.state import build as B  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=str, default=None)
    ap.add_argument("--end", type=str, default=None)
    ap.add_argument("--scopes", nargs="*", default=list(B.SCOPES))
    ap.add_argument("--summary-json", type=str, default=None)
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args(argv)

    try:
        block = B.assert_config_matches(B.load_config())
    except B.MtStateInputError as e:
        print(f"MT_STATE_CONFIG_MISMATCH {e}", file=sys.stderr)
        return 2
    try:
        inputs = B.read_inputs()
    except B.MtStateInputError as e:
        print(f"MT_STATE_INPUT_MISSING {e}", file=sys.stderr)
        return 3

    meta = {}
    for k, p in B.INPUT_FILES.items():
        df = inputs[k]
        meta[k] = {"path": str(p), "rows": int(len(df)), "mtime": datetime.fromtimestamp(Path(p).stat().st_mtime).isoformat(timespec="seconds"),
                   "engine_ver": str(df["engine_ver"].iloc[0]) if "engine_ver" in df.columns and len(df) else None}

    start = date.fromisoformat(args.start) if args.start else None
    end = date.fromisoformat(args.end) if args.end else None
    res = B.build_all(inputs["gap3g"], inputs["transmission"], inputs["flow"], inputs["breadth"], inputs["semi_diffusion"], inputs["psa"],
                      scopes=args.scopes, start=start, end=end)

    outputs: dict = {}
    if not args.no_write:
        settings.ensure_dirs()
        outputs["mt_state"] = str(B.write_mt_state(res["mt_state"]))
        outputs.update({k: str(v) for k, v in B.write_family_panels(res).items()})
        outputs["challengers"] = {k: str(v) for k, v in B.write_challengers(res["challengers"]).items()}

    summary = {
        "built_at": datetime.now().isoformat(timespec="seconds"),
        "engine_ver": B.ENGINE_VER,
        "config_blocks": block,
        "inputs": meta,
        "outputs": outputs,
        "rows": int(len(res["mt_state"])),
        "summary": B.summarize(res["mt_state"], res["challengers"]),
    }
    text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
    print(text)
    if args.summary_json:
        Path(args.summary_json).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
