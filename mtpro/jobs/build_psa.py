"""부품 9 PSA 빌드 잡 (T5-3) — bronze/ohlcv_adj.parquet → gold/psa_events.parquet (+ challengers shadow).

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\build_psa.py [--asof YYYY-MM-DD] [--no-challengers] [--summary-json path]

- 입력은 읽기만 한다(price_adjusted=True 만, C-2). 스코프·상수는 config/mtpro.yaml `psa` 블록(모듈 상수와 일치 테스트).
- --asof: 그 날짜 이하 자료만 사용(그 시점의 pending/final 재현). 기본 = 전체.
- 출력: gold/psa_events.parquet (champion), gold/challengers/psa_early.parquet · psa_k2.parquet · psa_w7.parquet (shadow 전용).
- 상위 결합은 gold/psa_events 를 `psa.psa_state_at(events, date, scope, sessions=...)` 로만 읽는다 (pending 미포함).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import pandas as pd  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
import yaml  # noqa: E402

from mtpro import settings  # noqa: E402
from mtpro.components import psa as P  # noqa: E402

BRONZE_IN = settings.BRONZE / "ohlcv_adj.parquet"
GOLD_OUT = settings.GOLD / "psa_events.parquet"
CHALLENGER_DIR = settings.GOLD / "challengers"
CHALLENGER_FILES = {"PSA-EARLY": "psa_early.parquet", "PSA-K2": "psa_k2.parquet", "PSA-W7": "psa_w7.parquet"}


def load_config() -> dict:
    return yaml.safe_load((settings.CONFIG_DIR / "mtpro.yaml").read_text(encoding="utf-8"))


def _check_constants(cfg: dict) -> None:
    c = cfg["constants"]
    pairs = {
        "k_sigma": (c["k_sigma"], P.K_SIGMA), "k_gap": (c["k_gap"], P.K_GAP),
        "sigma_window_days": (c["sigma_window_days"], P.SIGMA_WINDOW_DAYS),
        "window_sessions": (c["window_sessions"], P.WINDOW_SESSIONS), "settle_sessions": (c["settle_sessions"], P.SETTLE_SESSIONS),
        "z_ref_window_days": (c["z_ref_window_days"], P.Z_REF_WINDOW_DAYS), "z_ref_min_samples": (c["z_ref_min_samples"], P.Z_REF_MIN_SAMPLES),
        "level_hold_clip": (tuple(c["level_hold_clip"]), P.LEVEL_HOLD_CLIP), "z_clip": (c["z_clip"], P.Z_CLIP),
        "ewma_halflife_days": (c["ewma_halflife_days"], P.EWMA_HALFLIFE_DAYS),
    }
    bad = {k: v for k, v in pairs.items() if v[0] != v[1]}
    if bad:
        raise SystemExit(f"PSA_CONFIG_MISMATCH {bad} (config psa.constants ≠ psa.py 모듈 상수 — 사전 등록 위반)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asof", type=str, default=None, help="이 날짜 이하 자료만 사용 (pending/final 재현)")
    ap.add_argument("--no-challengers", action="store_true")
    ap.add_argument("--summary-json", type=str, default=None)
    args = ap.parse_args(argv)

    if not BRONZE_IN.exists():
        print(f"PSA_INPUT_MISSING {BRONZE_IN}", file=sys.stderr)
        return 3
    cfg = load_config()["psa"]
    _check_constants(cfg)
    scopes = [str(s) for s in cfg["scopes"]]
    asof = date.fromisoformat(args.asof) if args.asof else None

    ohlcv = pq.read_table(BRONZE_IN).to_pandas()
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.date
    present = set(ohlcv["code"].astype(str).unique())
    missing = [s for s in scopes if s not in present]
    if missing:
        print(f"PSA_SCOPE_MISSING {missing} (present: {sorted(present)})", file=sys.stderr)
        return 3

    settings.ensure_dirs()
    events = P.compute_psa_events(ohlcv, scopes=scopes, asof=asof)
    pq.write_table(P.events_to_arrow(events), GOLD_OUT)

    summary = P.summarize_events(events)
    summary["asof"] = str(asof) if asof else None
    summary["input"] = {"path": str(BRONZE_IN), "rows": int(len(ohlcv)),
                        "date_range": [str(ohlcv["date"].min()), str(ohlcv["date"].max())]}
    summary["outputs"] = {"gold": str(GOLD_OUT)}
    summary["constants"] = {"k_sigma": P.K_SIGMA, "k_gap": P.K_GAP, "sigma_window": P.SIGMA_WINDOW_DAYS,
                            "window": P.WINDOW_SESSIONS, "settle": P.SETTLE_SESSIONS, "level_hold_clip": P.LEVEL_HOLD_CLIP,
                            "z_ref": [P.Z_REF_WINDOW_DAYS, P.Z_REF_MIN_SAMPLES], "z_clip": P.Z_CLIP,
                            "ewma_halflife": P.EWMA_HALFLIFE_DAYS, "sessions": cfg.get("sessions")}

    # 상태 접점 예시 (마지막 자료일 시점, 스코프별) — pending 미포함 확인용
    last = ohlcv["date"].max() if asof is None else asof
    summary["state_at_last"] = {
        s: {k: (str(v) if isinstance(v, date) else v)
            for k, v in P.psa_state_at(events, last, s, sessions=P.sessions_from_ohlcv(ohlcv, s)).items()}
        for s in scopes
    }
    summary["state_at_last"]["date"] = str(last)

    if not args.no_challengers:
        CHALLENGER_DIR.mkdir(parents=True, exist_ok=True)
        ch = P.compute_challengers(ohlcv, scopes=scopes, asof=asof)
        summary["challengers"] = {}
        for name, ev in ch.items():
            path = CHALLENGER_DIR / CHALLENGER_FILES[name]
            pq.write_table(P.challenger_to_arrow(ev), path)
            cs = P.summarize_events(ev)
            summary["challengers"][name] = {
                "path": str(path),
                "scopes": {sc: {"n_shocks": v["n_shocks"], "n_final": v["n_final"], "n_pending": v["n_pending"],
                                "n_overlap": v["n_overlap"], "psa_z": v["psa_z"], "psa_z_coverage_of_final": v["psa_z_coverage_of_final"]}
                           for sc, v in cs["scopes"].items()},
            }

    text = json.dumps(summary, ensure_ascii=False, indent=2, default=str)
    print(text)
    if args.summary_json:
        Path(args.summary_json).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
