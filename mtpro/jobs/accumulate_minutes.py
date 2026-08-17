"""KIS 1분봉 축적 잡 (T5-6) — 005930·000660 정규장 1분봉 → data/bronze/minute/{code}/{YYYY-MM-DD}.parquet.

사용 (mtpro/ 에서):
    .venv\\Scripts\\python jobs\\accumulate_minutes.py [--codes 005930,000660] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                                                      [--max-days N] [--pause 0.15] [--dry-run] [--summary-json path]

- 세션 = XKRX 캘린더(kr_calendar) [start, end]. start 기본 = 오늘 − 365일(KIS 이력 창 실측), end 기본 = 오늘.
- 최초 실행 = 소급 적재(최신→과거, 창 경계 자동 감지), 이후 = 증분. 당일은 15:40 KST 이후에만.
- 결측일 → alerts.loud_failure(MINUTE_GAP) (kis_minute_store 안에서) + 종료코드 4. KIS/설정 실패 → 종료코드 2.
- KOSPI200 지수 분봉은 범위 밖(기록만). 전용 KIS 키·캐시만 사용.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
for _s in (sys.stdout, sys.stderr):                       # Windows 콘솔(cp949) 에서 JSON/한글 출력 깨짐·예외 방지
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

from mtpro import alerts, settings  # noqa: E402
from mtpro.events import kr_calendar as KC  # noqa: E402
from mtpro.ingest import kis_minute_store as MS  # noqa: E402
from mtpro.kis.client import KST, KisAuthError, KisClient, KisError  # noqa: E402

SUMMARY = settings.LOG_DIR / "accumulate_minutes_summary.json"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default=",".join(MS.CODES))
    ap.add_argument("--start", type=date.fromisoformat, default=None, help="기본 오늘−365일")
    ap.add_argument("--end", type=date.fromisoformat, default=None, help="기본 오늘")
    ap.add_argument("--max-days", type=int, default=None, help="종목당 이번 실행 최대 적재 세션 수")
    ap.add_argument("--pause", type=float, default=0.15, help="KIS 호출 간 대기(초)")
    ap.add_argument("--dry-run", action="store_true", help="계획만 출력 (KIS 호출 없음)")
    ap.add_argument("--summary-json", type=Path, default=SUMMARY)
    a = ap.parse_args(argv)
    settings.ensure_dirs()

    now = datetime.now(KST)
    end = a.end or now.date()
    start = a.start or (end - timedelta(days=MS.DEPTH_DAYS))
    cal = KC.default_calendar()
    sessions = cal.sessions_between(start, end)
    codes = [c.strip() for c in a.codes.split(",") if c.strip()]
    out: dict = {"run_ts_kst": now.isoformat(timespec="seconds"), "window": [start.isoformat(), end.isoformat()], "n_sessions": len(sessions),
                 "calendar": cal.describe(), "excluded": dict(MS.EXCLUDED), "codes": {}}

    if a.dry_run:
        for c in codes:
            st = MS.load_status(c)
            todo = MS.plan_days(sessions, st, now)
            out["codes"][c] = {"planned_days": len(todo), "first": todo[-1].isoformat() if todo else None, "last": todo[0].isoformat() if todo else None,
                               "est_calls": 7 * len(todo), "status": MS.summarize_store([c])["codes"][c]}
        print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
        return 0

    try:
        client = KisClient()
    except Exception as e:  # noqa: BLE001
        alerts.loud_failure("PROCURE_FAIL", {"component": "accumulate_minutes", "stage": "kis_client", "error": f"{type(e).__name__}: {e}"})
        return 2

    rc = 0
    for c in codes:
        try:
            r = MS.accumulate(client, c, sessions, now=now, pause_sec=a.pause, max_days=a.max_days)
        except (KisAuthError, KisError, MS.MinuteStoreError) as e:
            alerts.loud_failure("PROCURE_FAIL", {"component": "accumulate_minutes", "code": c, "error": f"{type(e).__name__}: {e}"})
            out["codes"][c] = {"error": f"{type(e).__name__}: {e}"}
            rc = 2
            continue
        d = r.as_dict()
        d["fetched_days"] = {"n": len(r.fetched_days), "first": min(r.fetched_days) if r.fetched_days else None,
                             "last": max(r.fetched_days) if r.fetched_days else None}
        out["codes"][c] = d
        print(f"[accumulate_minutes] {c}: fetched {len(r.fetched_days)} sessions (ok {r.ok} / partial {r.partial} / empty {r.empty}), "
              f"calls {r.calls}, {r.seconds}s, stored {r.stored_days} {r.stored_range}, boundary {r.depth_boundary}, gaps {r.gaps}", file=sys.stderr)
        if any(r.gaps.values()) and rc == 0:
            rc = 4
    out["store"] = MS.summarize_store(codes)
    txt = json.dumps(out, ensure_ascii=False, indent=1, default=str)
    print(txt)
    if a.summary_json:
        a.summary_json.parent.mkdir(parents=True, exist_ok=True)
        a.summary_json.write_text(txt, encoding="utf-8")
    return rc


if __name__ == "__main__":
    sys.exit(main())
