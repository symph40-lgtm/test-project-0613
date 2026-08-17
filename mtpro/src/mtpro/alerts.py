"""loud-failure 알림 (WORKORDER §5 불변 규칙 3·6: 조용한 None·조용한 수정 금지).

- loud_failure(kind, detail): logs/alerts.jsonl 에 1행 append + stderr 출력. 반환값은 기록한 dict.
- notify(kind, detail): 정보성 알림(실패 아님, 예: UNCONFIRMED_SCHEDULE_D7). 같은 파일에 level="info" 로 1행 append + stderr.
- 예외를 대신 던지지는 않는다 — 호출자가 예외를 던질지(수집 실패) 격하 기록만 할지(등급C) 결정한다.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mtpro import settings

ALERTS_FILE = settings.LOG_DIR / "alerts.jsonl"


def loud_failure(
    kind: str,
    detail: Any,
    *,
    ts: datetime | None = None,
    path: Path | None = None,
    stream=None,
) -> dict[str, Any]:
    """알림 1건 기록. kind 예: COLLECT_FAIL / DEGRADE_C / FREEZE_FAIL / REGISTRY_ERROR.

    detail은 JSON 직렬화 가능한 dict/str. path·stream은 테스트 주입용."""
    return _append(kind, detail, ts=ts, path=path, stream=stream, level=None, tag="ALERT")


def notify(
    kind: str,
    detail: Any,
    *,
    ts: datetime | None = None,
    path: Path | None = None,
    stream=None,
) -> dict[str, Any]:
    """정보성 알림 1건 기록 (loud_failure 아님). kind 예: UNCONFIRMED_SCHEDULE_D7.
    레코드에 level="info" 를 붙여 실패 알림과 구분한다. path·stream은 테스트 주입용."""
    return _append(kind, detail, ts=ts, path=path, stream=stream, level="info", tag="NOTICE")


def _append(kind: str, detail: Any, *, ts: datetime | None, path: Path | None, stream, level: str | None, tag: str) -> dict[str, Any]:
    ts = ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    rec: dict[str, Any] = {"ts": ts.astimezone(timezone.utc).isoformat(), "kind": kind, "detail": detail}
    if level is not None:
        rec["level"] = level
    p = path or ALERTS_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(rec, ensure_ascii=False, default=str)
    with p.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(f"[MTPRO {tag}] {line}", file=stream or sys.stderr)
    return rec


def read_alerts(path: Path | None = None) -> list[dict[str, Any]]:
    p = path or ALERTS_FILE
    if not p.exists():
        return []
    out = []
    for ln in p.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if ln:
            out.append(json.loads(ln))
    return out
