"""홈PC 라이브 크론 진입점 (T5-6) — 평일 16:10 KST 권장 (Windows 작업 스케줄러 등록: docs/mtpro-live-ops.md).

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\live_daily.py [--dry-run] [--only a,b] [--skip a,b] [--date YYYY-MM-DD] [--step-timeout 3600] [--stop-on-fail]

순서 (config live.steps 와 동일):
  (a) consensus_scheduler   python -m mtpro.events.cli run            D-7/D-3/D-1 수집·동결 (전용 collectors)
      build_events_kr       jobs/build_events_kr.py                    t0·독립성 파생 갱신
  (b) ingest_krx            jobs/ingest_krx.py --only flow,ohlcv_unadj,ohlcv_adj,pit,const_ohlcv   KRX 증분 (const_flow 는 C-1 대사 캐시 — 일간 불필요)
      accumulate_minutes    jobs/accumulate_minutes.py                 KIS 분봉 증분 (결측 MINUTE_GAP → rc 4)
      (미국 일봉 증분은 build_gap3g(^SOX)·build_transmission(4자산)·build_expected_reaction(^VIX·^TNX) 안에서)
  (c) build_flow → build_breadth → build_semi_diffusion → build_gap3g → build_transmission → build_psa → build_expected_reaction → build_absorption
      → build_mt_state (jobs/build_mt_state.py 가 있으면; 없으면 skipped 기록)
  (d) step 실패(rc≠0·타임아웃·예외) → alerts.loud_failure(LIVE_STEP_FAIL) + 다음 step 계속(--stop-on-fail 이면 중단) → 최종 종료코드 1.
실행 로그 logs/live_daily_{date}.log (각 step stdout/stderr 그대로) + logs/live_daily_{date}.json 요약.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):                       # Windows 콘솔(cp949) 에서 JSON/한글 출력 깨짐·예외 방지
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

from mtpro import alerts, settings  # noqa: E402

KST = timezone(timedelta(hours=9))
PY = sys.executable
JOBS = ROOT / "jobs"

# (name, argv, optional) — argv 는 ROOT 기준. optional=True 면 파일 없을 때 skipped(실패 아님).
STEPS: list[tuple[str, list[str], bool]] = [
    ("consensus_scheduler", [PY, "-m", "mtpro.events.cli", "run"], False),
    ("build_events_kr", [PY, str(JOBS / "build_events_kr.py")], False),
    ("ingest_krx", [PY, str(JOBS / "ingest_krx.py"), "--only", "flow,ohlcv_unadj,ohlcv_adj,pit,const_ohlcv"], False),
    ("accumulate_minutes", [PY, str(JOBS / "accumulate_minutes.py")], False),
    ("build_flow", [PY, str(JOBS / "build_flow.py")], False),
    ("build_breadth", [PY, str(JOBS / "build_breadth.py")], False),
    ("build_semi_diffusion", [PY, str(JOBS / "build_semi_diffusion.py")], False),
    ("build_gap3g", [PY, str(JOBS / "build_gap3g.py"), "--wait-minutes", "0"], False),
    ("build_transmission", [PY, str(JOBS / "build_transmission.py"), "--wait-minutes", "0"], False),
    ("build_psa", [PY, str(JOBS / "build_psa.py")], False),
    ("build_expected_reaction", [PY, str(JOBS / "build_expected_reaction.py")], False),
    ("build_absorption", [PY, str(JOBS / "build_absorption.py")], False),
    ("build_mt_state", [PY, str(JOBS / "build_mt_state.py")], True),
]
STEP_NAMES = [s[0] for s in STEPS]
LIVE_STEP_FAIL = "LIVE_STEP_FAIL"


def _log_paths(day: str) -> tuple[Path, Path]:
    return settings.LOG_DIR / f"live_daily_{day}.log", settings.LOG_DIR / f"live_daily_{day}.json"


def run_step(name: str, argv: list[str], log, timeout: int) -> dict:
    """서브프로세스 실행, stdout/stderr 를 로그에 그대로 붙인다. 반환 {name, rc, seconds, tail}."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    t0 = time.time()
    header = f"\n===== [{datetime.now(KST).isoformat(timespec='seconds')}] STEP {name}: {' '.join(argv)}\n"
    log.write(header)
    log.flush()
    print(header.strip(), flush=True)
    try:
        cp = subprocess.run(argv, cwd=str(ROOT), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        out = (cp.stdout or "") + (("\n[stderr]\n" + cp.stderr) if cp.stderr else "")
        rc = int(cp.returncode)
    except subprocess.TimeoutExpired as e:
        out = f"TIMEOUT after {timeout}s\n" + ((e.stdout or "") if isinstance(e.stdout, str) else "") + ((e.stderr or "") if isinstance(e.stderr, str) else "")
        rc = 124
    except Exception as e:  # noqa: BLE001
        out = f"EXCEPTION {type(e).__name__}: {e}\n"
        rc = 125
    log.write(out)
    log.write(f"\n----- [{name}] rc={rc} ({time.time() - t0:.1f}s)\n")
    log.flush()
    tail = "\n".join(out.strip().splitlines()[-15:])
    return {"name": name, "rc": rc, "seconds": round(time.time() - t0, 1), "tail": tail}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="계획만 출력, 실행 없음")
    ap.add_argument("--only", default=None, help="쉼표 목록 (이 step 만)")
    ap.add_argument("--skip", default=None, help="쉼표 목록 (이 step 제외)")
    ap.add_argument("--date", default=None, help="로그 파일 날짜 (기본 오늘 KST)")
    ap.add_argument("--step-timeout", type=int, default=3600, help="step 당 최대 초 (기본 3600)")
    ap.add_argument("--stop-on-fail", action="store_true", help="첫 실패에서 중단 (기본: 계속)")
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    only = {s.strip() for s in a.only.split(",")} if a.only else None
    skip = {s.strip() for s in a.skip.split(",")} if a.skip else set()
    unknown = ((only or set()) | skip) - set(STEP_NAMES)
    if unknown:
        print(f"unknown steps: {sorted(unknown)} (valid: {STEP_NAMES})", file=sys.stderr)
        return 2
    plan = [(n, av, opt) for n, av, opt in STEPS if (only is None or n in only) and n not in skip]

    day = a.date or datetime.now(KST).strftime("%Y-%m-%d")
    log_path, json_path = _log_paths(day)
    if a.dry_run:
        for n, av, opt in plan:
            exists = Path(av[1]).exists() if av[1].endswith(".py") else True
            print(f"[dry-run] {n:<24} optional={opt} exists={exists} :: {' '.join(av)}")
        print(f"[dry-run] log → {log_path}")
        return 0

    started = datetime.now(timezone.utc)
    results: list[dict] = []
    failed: list[str] = []
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n########## live_daily start {started.astimezone(KST).isoformat(timespec='seconds')} python={PY}\n")
        for n, av, opt in plan:
            script = Path(av[1]) if av[1].endswith(".py") else None
            if opt and script is not None and not script.exists():
                results.append({"name": n, "rc": None, "seconds": 0.0, "tail": f"skipped: {script.name} not present"})
                log.write(f"\n===== STEP {n}: skipped ({script.name} not present)\n")
                continue
            r = run_step(n, av, log, a.step_timeout)
            results.append(r)
            if r["rc"] != 0:
                failed.append(n)
                alerts.loud_failure(LIVE_STEP_FAIL, {"step": n, "rc": r["rc"], "seconds": r["seconds"], "log": str(log_path), "tail": r["tail"][-800:]})
                if a.stop_on_fail:
                    log.write("\n----- stop-on-fail\n")
                    break
        rc = 1 if failed else 0
        summary = {"date": day, "started_utc": started.isoformat(timespec="seconds"),
                   "finished_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "exit_code": rc, "failed_steps": failed, "steps": results, "log": str(log_path)}
        log.write(f"\n########## live_daily end exit={rc} failed={failed}\n")
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "steps"}, ensure_ascii=False, indent=1))
    for r in results:
        print(f"  {r['name']:<24} rc={r['rc']} {r['seconds']}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
