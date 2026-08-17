"""KIS 1분봉 자체 축적기 (T5-6, 부품 3 장중 6점 재료; 계획서 §1 "분봉 필요, 전진 12개월 창"·§11 T5-6).

- 전용 KIS 키(mtpro/.env, settings.env)·토큰 캐시(mtpro/.cache/kis_token.json)만 쓴다 — kis/client.py 규약. 기존 시스템 env·캐시 접근 없음.
- 종목: 005930·000660 정규장(J) 1분봉. **KOSPI200 지수 분봉은 TR 이 다르므로(FHKUP03500200 inquire-time-indexchartprice) 이번 범위 제외**
  (`EXCLUDED` 에 사유 기록 — 발주자 확인 사항).
- 저장: data/bronze/minute/{code}/{YYYY-MM-DD}.parquet, schema.BRONZE_MINUTE (price_adjusted=False, market_div J, source, fetch_ts).
  하루 = 파일 하나(원자적 write). 상태: data/bronze/minute/{code}/_status.json — 세션별 {bars, state ok|empty|partial, attempts, last_fetch}
  + depth_boundary(소급 적재로 확인한 KIS 이력 창의 가장 오래된 유효 세션).
- 호출: kis/minute.fetch_day_minutes (60분 앵커 7호출/일, 호출 간 0.15초). 최초 실행 = 이력 창(≈12개월, T2 실측 365일) 소급 적재:
  **최신 → 과거** 순으로 진행하다 오래된 구간(today − DEPTH_PROBE_AGE_DAYS 이전)에서 연속 무응답 DEPTH_STOP 세션이면 창 경계로 보고 중단.
  이후 실행 = 증분(미적재 세션만). 당일은 COMPLETE_AFTER_KST(15:40) 이후에만 적재(그 전엔 미완결이라 건너뜀).
- **결측일 감지**: XKRX 세션(kr_calendar) 대비 [depth_boundary(또는 첫 적재일), 마지막 완결 세션] 안의 state≠ok 세션 목록 →
  alerts.loud_failure('MINUTE_GAP'). 무응답 세션은 EMPTY_RETRY_MAX 회까지 재시도 후 gap 으로 확정 기록(조용히 넘기지 않는다).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence

import pandas as pd
import pyarrow.parquet as pq

from mtpro import alerts, settings
from mtpro.ingest import store
from mtpro.kis.client import KST
from mtpro.kis.minute import TR_ID, fetch_day_minutes
from mtpro.schema import BRONZE_MINUTE

MINUTE_ROOT = settings.BRONZE / "minute"
CODES: tuple[str, ...] = ("005930", "000660")
EXCLUDED: dict[str, str] = {"KOSPI200": "index minute TR differs (FHKUP03500200 inquire-time-indexchartprice); out of T5-6 scope"}
MARKET_DIV = "J"
SOURCE = f"kis:{TR_ID}"
DEPTH_DAYS = 365                       # config kis.minute_depth_days_measured / intraday.minute_store.depth_days
DEPTH_PROBE_AGE_DAYS = 300             # 이보다 오래된 구간에서만 "연속 무응답 = 이력 창 경계" 판단
DEPTH_STOP_CONSECUTIVE_EMPTY = 3
EMPTY_RETRY_MAX = 3
COMPLETE_AFTER_KST = dtime(15, 40)
MIN_BARS_FULL_DAY = 300                # 정규장 381봉; 10:00 개장일(첫 거래일·수능일) 331
MINUTE_GAP = "MINUTE_GAP"
STATUS_FILE = "_status.json"
STATE_OK, STATE_EMPTY, STATE_PARTIAL = "ok", "empty", "partial"


class MinuteStoreError(RuntimeError):
    """저장소 규칙 위반 (loud-failure)."""


# ---------------------------------------------------------------------------
# 경로·상태
# ---------------------------------------------------------------------------

def code_dir(code: str, root: Path = MINUTE_ROOT) -> Path:
    return Path(root) / str(code)


def day_path(code: str, d: date, root: Path = MINUTE_ROOT) -> Path:
    return code_dir(code, root) / f"{d.isoformat()}.parquet"


def status_path(code: str, root: Path = MINUTE_ROOT) -> Path:
    return code_dir(code, root) / STATUS_FILE


def load_status(code: str, root: Path = MINUTE_ROOT) -> dict[str, Any]:
    p = status_path(code, root)
    if not p.exists():
        return {"code": str(code), "days": {}, "depth_boundary": None, "last_run": None}
    d = json.loads(p.read_text(encoding="utf-8"))
    d.setdefault("days", {})
    d.setdefault("depth_boundary", None)
    d.setdefault("last_run", None)
    return d


def save_status(code: str, status: dict[str, Any], root: Path = MINUTE_ROOT) -> Path:
    p = status_path(code, root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(status, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(p)
    return p


def stored_days(code: str, root: Path = MINUTE_ROOT) -> list[date]:
    """파일이 있는 날짜(파일명 기준, 오름차순)."""
    d = code_dir(code, root)
    if not d.exists():
        return []
    out = []
    for p in d.glob("*.parquet"):
        try:
            out.append(date.fromisoformat(p.stem))
        except ValueError:
            continue
    return sorted(out)


def reconcile_status(code: str, status: dict[str, Any], root: Path = MINUTE_ROOT, min_bars_full_day: int = MIN_BARS_FULL_DAY) -> int:
    """파일은 있는데 상태에 없는 날(중단된 실행 등) → 파일 행 수로 ok/partial 복원. 반환: 복원 건수. (상태 없이 파일만 믿고 재적재하지 않는다.)"""
    n = 0
    days = status.setdefault("days", {})
    for d in stored_days(code, root):
        k = d.isoformat()
        if k in days and days[k].get("state") in (STATE_OK, STATE_PARTIAL):
            continue
        p = day_path(code, d, root)
        try:
            rows = int(pq.read_metadata(p).num_rows)
        except Exception:  # noqa: BLE001
            continue
        if rows <= 0:
            continue
        rec = days.get(k, {"attempts": 0})
        rec.update(bars=rows, state=STATE_OK if rows >= min_bars_full_day else STATE_PARTIAL,
                   attempts=max(1, int(rec.get("attempts", 0))),
                   last_fetch=datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds"), reconciled=True)
        days[k] = rec
        n += 1
    return n


# ---------------------------------------------------------------------------
# 읽기/쓰기
# ---------------------------------------------------------------------------

def bars_to_frame(code: str, d: date, bars: pd.DataFrame, fetch_ts: Optional[datetime] = None, market_div: str = MARKET_DIV) -> pd.DataFrame:
    """kis/minute 봉(time, open, high, low, close, volume) → BRONZE_MINUTE 행."""
    ts = fetch_ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    b = bars.copy() if bars is not None else pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
    b = b.sort_values("time").drop_duplicates("time", keep="last").reset_index(drop=True) if len(b) else b
    return pd.DataFrame({
        "date": [d] * len(b), "code": [str(code)] * len(b), "time": b["time"].astype(str).tolist() if len(b) else [],
        "open": b["open"].astype(float).tolist() if len(b) else [], "high": b["high"].astype(float).tolist() if len(b) else [],
        "low": b["low"].astype(float).tolist() if len(b) else [], "close": b["close"].astype(float).tolist() if len(b) else [],
        "volume": b["volume"].astype(float).tolist() if len(b) else [],
        "price_adjusted": [False] * len(b), "market_div": [market_div] * len(b), "source": [SOURCE] * len(b),
        "fetch_ts": [pd.Timestamp(ts).tz_convert("UTC").floor("s")] * len(b),
    })


def write_day(code: str, d: date, frame: pd.DataFrame, root: Path = MINUTE_ROOT) -> Path:
    if len(frame) == 0:
        raise MinuteStoreError(f"{code} {d}: refusing to write empty day file (record state=empty in status instead)")
    if not (frame["code"].astype(str) == str(code)).all() or not (pd.to_datetime(frame["date"]).dt.date == d).all():
        raise MinuteStoreError(f"{code} {d}: frame code/date mismatch")
    p = day_path(code, d, root)
    store.write(frame, BRONZE_MINUTE, p)
    return p


def read_day(code: str, d: date, root: Path = MINUTE_ROOT) -> Optional[pd.DataFrame]:
    p = day_path(code, d, root)
    if not p.exists():
        return None
    df = pq.read_table(p).to_pandas()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.sort_values("time").reset_index(drop=True)


def read_range(code: str, start: Optional[date] = None, end: Optional[date] = None, root: Path = MINUTE_ROOT) -> pd.DataFrame:
    """[start, end] 의 날짜 파일을 이어 붙인다 (없으면 0행, BRONZE_MINUTE 열)."""
    parts = []
    for d in stored_days(code, root):
        if (start is not None and d < start) or (end is not None and d > end):
            continue
        f = read_day(code, d, root)
        if f is not None and len(f):
            parts.append(f)
    if not parts:
        return pd.DataFrame(columns=[f.name for f in BRONZE_MINUTE])
    return pd.concat(parts, ignore_index=True).sort_values(["date", "time"]).reset_index(drop=True)


# ---------------------------------------------------------------------------
# 계획·결측 감지 (순수)
# ---------------------------------------------------------------------------

def _now_kst(now: Optional[datetime] = None) -> datetime:
    n = now or datetime.now(KST)
    if n.tzinfo is None:
        n = n.replace(tzinfo=KST)
    return n.astimezone(KST)


def last_complete_session(sessions: Sequence[date], now: Optional[datetime] = None, complete_after: dtime = COMPLETE_AFTER_KST) -> Optional[date]:
    """지금(KST) 기준 완결된 마지막 세션: 오늘이 세션이고 시각 ≥ complete_after 면 오늘, 아니면 오늘 이전 마지막 세션."""
    n = _now_kst(now)
    today = n.date()
    last = None
    for s in sessions:
        if s < today or (s == today and n.time() >= complete_after):
            last = s
        else:
            break
    return last


def plan_days(sessions: Sequence[date], status: dict[str, Any], now: Optional[datetime] = None,
              empty_retry_max: int = EMPTY_RETRY_MAX) -> list[date]:
    """적재 대상 = 완결된 세션 중 state≠ok 이고 (empty/partial 은 attempts < empty_retry_max) 이고 depth_boundary 이전이 아닌 날. **최신 → 과거** 순."""
    last = last_complete_session(sessions, now)
    if last is None:
        return []
    boundary = status.get("depth_boundary")
    b = date.fromisoformat(boundary) if boundary else None
    out = []
    for s in sorted(sessions, reverse=True):
        if s > last:
            continue
        if b is not None and s < b:
            continue
        rec = status.get("days", {}).get(s.isoformat())
        if rec is None:
            out.append(s)
        elif rec.get("state") != STATE_OK and int(rec.get("attempts", 0)) < empty_retry_max:
            out.append(s)
    return out


def missing_days(sessions: Sequence[date], status: dict[str, Any], now: Optional[datetime] = None) -> dict[str, list[str]]:
    """[시작, 마지막 완결 세션] 안의 state≠ok 세션. 시작 = depth_boundary(있으면) 아니면 첫 ok 세션. 반환 {"empty": [...], "partial": [...], "never": [...]}."""
    last = last_complete_session(sessions, now)
    days = status.get("days", {})
    ok_days = sorted(date.fromisoformat(k) for k, v in days.items() if v.get("state") == STATE_OK)
    boundary = status.get("depth_boundary")
    start = date.fromisoformat(boundary) if boundary else (ok_days[0] if ok_days else None)
    out: dict[str, list[str]] = {"empty": [], "partial": [], "never": []}
    if start is None or last is None:
        return out
    for s in sessions:
        if s < start or s > last:
            continue
        rec = days.get(s.isoformat())
        if rec is None:
            out["never"].append(s.isoformat())
        elif rec.get("state") == STATE_EMPTY:
            out["empty"].append(s.isoformat())
        elif rec.get("state") == STATE_PARTIAL:
            out["partial"].append(s.isoformat())
    return out


# ---------------------------------------------------------------------------
# 축적
# ---------------------------------------------------------------------------

@dataclass
class AccumulateResult:
    code: str
    fetched_days: list[str] = field(default_factory=list)
    ok: int = 0
    empty: int = 0
    partial: int = 0
    calls: int = 0
    seconds: float = 0.0
    depth_boundary: Optional[str] = None
    depth_stop_hit: bool = False
    gaps: dict[str, list[str]] = field(default_factory=dict)
    stored_range: Optional[tuple[str, str]] = None
    stored_days: int = 0
    stopped_reason: Optional[str] = None
    error: Optional[str] = None

    def as_dict(self) -> dict[str, Any]:
        return {**self.__dict__}


def accumulate(
    client: Any,
    code: str,
    sessions: Sequence[date],
    now: Optional[datetime] = None,
    root: Path = MINUTE_ROOT,
    fetcher: Callable[..., Any] = fetch_day_minutes,
    pause_sec: float = 0.15,
    max_days: Optional[int] = None,
    alert: Callable[..., dict[str, Any]] = alerts.loud_failure,
    depth_probe_age_days: int = DEPTH_PROBE_AGE_DAYS,
    depth_stop: int = DEPTH_STOP_CONSECUTIVE_EMPTY,
    min_bars_full_day: int = MIN_BARS_FULL_DAY,
    empty_retry_max: int = EMPTY_RETRY_MAX,
    save_every: int = 10,
) -> AccumulateResult:
    """세션 목록에 대해 미적재 완결 세션을 최신→과거 순으로 KIS 에서 받아 저장한다. 결측일은 alert(MINUTE_GAP). 예외는 status 저장 후 재전파."""
    if str(code) in EXCLUDED:
        raise MinuteStoreError(f"{code}: excluded — {EXCLUDED[str(code)]}")
    t_start = time.time()
    n_kst = _now_kst(now)
    status = load_status(code, root)
    if reconcile_status(code, status, root, min_bars_full_day):
        save_status(code, status, root)
    res = AccumulateResult(code=str(code), depth_boundary=status.get("depth_boundary"))
    todo = plan_days(sessions, status, n_kst, empty_retry_max)
    if max_days is not None:
        todo = todo[: max(0, int(max_days))]
    consecutive_empty = 0
    try:
        for n_done, d in enumerate(todo, start=1):
            if n_done % save_every == 0:                       # 긴 소급 중 중단돼도 상태 보존
                save_status(code, status, root)
            fetch_ts = datetime.now(timezone.utc)
            r = fetcher(client, str(code), d.strftime("%Y%m%d"), pause_sec=pause_sec)
            res.calls += int(getattr(r, "calls", 0) or 0)
            bars = getattr(r, "bars", None)
            n_bars = int(len(bars)) if bars is not None else 0
            rec = status["days"].get(d.isoformat(), {"attempts": 0})
            rec["attempts"] = int(rec.get("attempts", 0)) + 1
            rec["last_fetch"] = fetch_ts.isoformat(timespec="seconds")
            rec["bars"] = n_bars
            res.fetched_days.append(d.isoformat())
            if n_bars == 0:
                rec["state"] = STATE_EMPTY
                res.empty += 1
                consecutive_empty += 1
            else:
                write_day(code, d, bars_to_frame(code, d, bars, fetch_ts), root)
                if n_bars < min_bars_full_day:
                    rec["state"] = STATE_PARTIAL
                    res.partial += 1
                else:
                    rec["state"] = STATE_OK
                    res.ok += 1
                consecutive_empty = 0
            status["days"][d.isoformat()] = rec
            # 이력 창 경계: 오래된 구간에서 연속 무응답 → 그 앞은 KIS 가 주지 않는 구간 (경계 = 마지막 유효 세션)
            if consecutive_empty >= depth_stop and (n_kst.date() - d).days >= depth_probe_age_days:
                ok_days = sorted(k for k, v in status["days"].items() if v.get("state") in (STATE_OK, STATE_PARTIAL))
                status["depth_boundary"] = ok_days[0] if ok_days else None
                res.depth_boundary = status["depth_boundary"]
                res.depth_stop_hit = True
                res.stopped_reason = f"{depth_stop} consecutive empty sessions ending {d.isoformat()} (age ≥ {depth_probe_age_days}d) → depth boundary"
                # 경계 이전의 empty 기록은 gap 이 아니라 창 밖 — 상태에서 지운다(재시도 방지)
                if status["depth_boundary"]:
                    for k in [k for k, v in status["days"].items() if v.get("state") == STATE_EMPTY and k < status["depth_boundary"]]:
                        status["days"].pop(k, None)
                break
    except Exception as e:  # noqa: BLE001
        res.error = f"{type(e).__name__}: {e}"
        status["last_run"] = n_kst.isoformat(timespec="seconds")
        save_status(code, status, root)
        raise
    status["last_run"] = n_kst.isoformat(timespec="seconds")
    save_status(code, status, root)
    res.gaps = missing_days(sessions, status, n_kst)
    sd = stored_days(code, root)
    res.stored_days = len(sd)
    res.stored_range = (sd[0].isoformat(), sd[-1].isoformat()) if sd else None
    res.seconds = round(time.time() - t_start, 1)
    if any(res.gaps.values()):
        alert(MINUTE_GAP, {"code": str(code), "calendar": "XKRX", **res.gaps,
                           "n_missing": sum(len(v) for v in res.gaps.values()),
                           "range_checked": [status.get("depth_boundary") or (min(k for k, v in status["days"].items() if v.get("state") == STATE_OK) if any(v.get("state") == STATE_OK for v in status["days"].values()) else None),
                                             (last_complete_session(sessions, n_kst) or n_kst.date()).isoformat()],
                           "action": "KIS 재시도(attempts<3 자동) / 3회 초과면 수동 확인 — 분봉 부품 3 은 그 날 None"})
    return res


def summarize_store(codes: Iterable[str] = CODES, root: Path = MINUTE_ROOT) -> dict[str, Any]:
    out: dict[str, Any] = {"root": str(root), "excluded": dict(EXCLUDED), "codes": {}}
    for c in codes:
        sd = stored_days(c, root)
        st = load_status(c, root)
        days = st.get("days", {})
        out["codes"][str(c)] = {
            "stored_days": len(sd), "range": [sd[0].isoformat(), sd[-1].isoformat()] if sd else None,
            "state_counts": {s: sum(1 for v in days.values() if v.get("state") == s) for s in (STATE_OK, STATE_PARTIAL, STATE_EMPTY)},
            "depth_boundary": st.get("depth_boundary"), "last_run": st.get("last_run"),
        }
    return out


__all__ = [
    "MINUTE_ROOT", "CODES", "EXCLUDED", "MARKET_DIV", "SOURCE", "DEPTH_DAYS", "DEPTH_PROBE_AGE_DAYS", "DEPTH_STOP_CONSECUTIVE_EMPTY",
    "EMPTY_RETRY_MAX", "COMPLETE_AFTER_KST", "MIN_BARS_FULL_DAY", "MINUTE_GAP", "MinuteStoreError", "AccumulateResult",
    "code_dir", "day_path", "status_path", "load_status", "save_status", "stored_days", "bars_to_frame", "write_day", "read_day",
    "read_range", "reconcile_status", "last_complete_session", "plan_days", "missing_days", "accumulate", "summarize_store",
]
