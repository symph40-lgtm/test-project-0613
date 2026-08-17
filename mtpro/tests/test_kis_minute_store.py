"""T5-6 KIS 분봉 축적기 (ingest/kis_minute_store.py) — 가짜 fetcher 로 경로·상태·결측 감지·이력 창 경계 테스트 (네트워크 없음)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

import pandas as pd
import pytest

from mtpro.ingest import kis_minute_store as MS
from mtpro.kis.client import KST
from mtpro.schema import BRONZE_MINUTE


@dataclass
class FakeResult:
    code: str
    date: str
    bars: pd.DataFrame
    calls: int = 7
    raw_rows: int = 0


def _bars(n=381):
    t0 = 9 * 60
    times = [f"{(t0 + i) // 60:02d}:{(t0 + i) % 60:02d}" for i in range(n)]
    return pd.DataFrame({"time": times, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 10.0})


class FakeFetcher:
    """ymd → bars 사전. 없으면 빈 프레임(무응답). 호출 기록."""

    def __init__(self, data: dict[str, int], fail_on: str | None = None):
        self.data = data
        self.calls: list[str] = []
        self.fail_on = fail_on

    def __call__(self, client, code, ymd, pause_sec=0.0, **kw):
        self.calls.append(ymd)
        if self.fail_on == ymd:
            raise RuntimeError("boom")
        n = self.data.get(ymd, 0)
        return FakeResult(code, ymd, _bars(n) if n else _bars(0).iloc[0:0])


def _sessions(start: date, n: int) -> list[date]:
    return [d.date() for d in pd.bdate_range(start, periods=n)]


def test_paths_and_write_read(tmp_path):
    d = date(2026, 8, 14)
    assert MS.day_path("005930", d, tmp_path) == tmp_path / "005930" / "2026-08-14.parquet"
    f = MS.bars_to_frame("005930", d, _bars(381), datetime(2026, 8, 17, 7, tzinfo=KST))
    assert list(f.columns) == [x.name for x in BRONZE_MINUTE]
    assert (f["price_adjusted"] == False).all() and (f["market_div"] == "J").all() and f["source"].iloc[0] == MS.SOURCE  # noqa: E712
    p = MS.write_day("005930", d, f, tmp_path)
    assert p.exists()
    back = MS.read_day("005930", d, tmp_path)
    assert len(back) == 381 and back["time"].iloc[0] == "09:00" and back["time"].iloc[-1] == "15:20"
    assert MS.stored_days("005930", tmp_path) == [d]
    with pytest.raises(MS.MinuteStoreError):
        MS.write_day("005930", d, f.iloc[0:0], tmp_path)
    with pytest.raises(MS.MinuteStoreError):
        MS.write_day("000660", d, f, tmp_path)
    rng = MS.read_range("005930", None, None, tmp_path)
    assert len(rng) == 381
    assert len(MS.read_range("000660", None, None, tmp_path)) == 0


def test_last_complete_session_and_plan(tmp_path):
    ss = _sessions(date(2026, 8, 3), 10)          # 8/3 ~ 8/14
    today = date(2026, 8, 14)
    before = datetime.combine(today, datetime.min.time(), tzinfo=KST).replace(hour=15, minute=0)
    after = before.replace(hour=15, minute=45)
    assert MS.last_complete_session(ss, before) == date(2026, 8, 13)
    assert MS.last_complete_session(ss, after) == today
    st = MS.load_status("005930", tmp_path)
    plan = MS.plan_days(ss, st, before)
    assert plan[0] == date(2026, 8, 13) and plan[-1] == date(2026, 8, 3) and len(plan) == 9      # 최신→과거, 당일 제외
    st["days"]["2026-08-13"] = {"state": "ok", "attempts": 1}
    st["days"]["2026-08-12"] = {"state": "empty", "attempts": 3}
    st["days"]["2026-08-11"] = {"state": "empty", "attempts": 1}
    st["depth_boundary"] = "2026-08-05"
    plan = MS.plan_days(ss, st, after)
    assert today in plan and date(2026, 8, 13) not in plan and date(2026, 8, 12) not in plan and date(2026, 8, 11) in plan
    assert min(plan) == date(2026, 8, 5)


def test_accumulate_stores_files_and_detects_gaps(tmp_path):
    ss = _sessions(date(2026, 8, 3), 10)          # 8/3~8/14
    now = datetime(2026, 8, 14, 16, 0, tzinfo=KST)
    data = {d.strftime("%Y%m%d"): 381 for d in ss}
    data.pop("20260810")                            # KIS 무응답 세션 하나
    data["20260806"] = 120                          # partial
    fetch = FakeFetcher(data)
    alerts_seen = []
    r = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch, pause_sec=0,
                      alert=lambda kind, detail, **kw: alerts_seen.append((kind, detail)) or {})
    assert r.ok == 8 and r.partial == 1 and r.empty == 1 and r.calls == 7 * 10
    assert fetch.calls[0] == "20260814" and fetch.calls[-1] == "20260803"                # 최신→과거
    assert sorted(MS.stored_days("005930", tmp_path)) == [d for d in ss if d != date(2026, 8, 10)]
    assert r.gaps == {"empty": ["2026-08-10"], "partial": ["2026-08-06"], "never": []}
    assert len(alerts_seen) == 1 and alerts_seen[0][0] == MS.MINUTE_GAP
    assert alerts_seen[0][1]["code"] == "005930" and alerts_seen[0][1]["empty"] == ["2026-08-10"]
    st = MS.load_status("005930", tmp_path)
    assert st["days"]["2026-08-10"]["state"] == "empty" and st["days"]["2026-08-10"]["attempts"] == 1
    assert st["days"]["2026-08-06"]["state"] == "partial" and st["depth_boundary"] is None
    # 증분 실행: ok 는 다시 안 받고, empty/partial 만 재시도 (attempts 2)
    fetch2 = FakeFetcher({**data, "20260810": 381, "20260806": 381})
    r2 = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch2, pause_sec=0, alert=lambda *a, **k: {})
    assert sorted(fetch2.calls) == ["20260806", "20260810"]
    assert r2.ok == 2 and r2.gaps == {"empty": [], "partial": [], "never": []}
    assert len(MS.stored_days("005930", tmp_path)) == 10
    # 세 번째 실행: 할 일 없음
    fetch3 = FakeFetcher(data)
    r3 = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch3, pause_sec=0, alert=lambda *a, **k: {})
    assert fetch3.calls == [] and r3.stored_days == 10


def test_accumulate_retry_cap_and_never_gap(tmp_path):
    ss = _sessions(date(2026, 8, 3), 5)
    now = datetime(2026, 8, 7, 16, 0, tzinfo=KST)
    data = {d.strftime("%Y%m%d"): 381 for d in ss}
    data.pop("20260805")
    seen = []
    for _ in range(4):
        MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=FakeFetcher(data), pause_sec=0,
                      alert=lambda kind, detail, **kw: seen.append(kind) or {})
    st = MS.load_status("005930", tmp_path)
    assert st["days"]["2026-08-05"]["attempts"] == MS.EMPTY_RETRY_MAX          # 3회 후 재시도 중단
    assert seen == [MS.MINUTE_GAP] * 4                                          # 그래도 매 실행 loud
    # never: 상태에도 없는 세션(예: 캘린더에 새로 생긴 날) → never 로 보고
    ss2 = ss + [date(2026, 8, 10)]
    now2 = datetime(2026, 8, 10, 16, 0, tzinfo=KST)
    r = MS.accumulate(None, "005930", ss2, now=now2, root=tmp_path, fetcher=FakeFetcher(data), pause_sec=0, max_days=0, alert=lambda *a, **k: {})
    assert r.gaps["never"] == ["2026-08-10"] and r.gaps["empty"] == ["2026-08-05"]


def test_depth_boundary_stop(tmp_path):
    # 400 세션 소급: 최근 250 세션만 KIS 응답, 그 앞은 무응답 → 연속 3회 무응답(오래된 구간)에서 중단, 경계 = 가장 오래된 유효 세션, 그 앞은 gap 아님
    ss = _sessions(date(2025, 1, 1), 400)
    now = datetime.combine(ss[-1], datetime.min.time(), tzinfo=KST) + timedelta(hours=16)
    data = {d.strftime("%Y%m%d"): 381 for d in ss[-250:]}
    fetch = FakeFetcher(data)
    seen = []
    r = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch, pause_sec=0,
                      alert=lambda kind, detail, **kw: seen.append(detail) or {})
    assert r.depth_stop_hit and r.depth_boundary == ss[-250].isoformat()
    assert len(fetch.calls) == 250 + MS.DEPTH_STOP_CONSECUTIVE_EMPTY
    assert r.ok == 250 and r.gaps == {"empty": [], "partial": [], "never": []} and seen == []
    st = MS.load_status("005930", tmp_path)
    assert all(v["state"] == "ok" for v in st["days"].values())                # 경계 이전 empty 기록은 제거
    # 다음 실행: 경계 이전 세션은 계획에서 빠진다
    assert MS.plan_days(ss, st, now) == []


def test_recent_consecutive_empty_is_gap_not_boundary(tmp_path):
    ss = _sessions(date(2026, 7, 1), 30)
    now = datetime.combine(ss[-1], datetime.min.time(), tzinfo=KST) + timedelta(hours=16)
    data = {d.strftime("%Y%m%d"): 381 for d in ss}
    for d in ss[10:15]:                                                          # 최근 구간 5세션 무응답 (KIS 장애 가정)
        data.pop(d.strftime("%Y%m%d"))
    seen = []
    r = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=FakeFetcher(data), pause_sec=0,
                      alert=lambda kind, detail, **kw: seen.append(detail) or {})
    assert not r.depth_stop_hit and r.depth_boundary is None
    assert r.gaps["empty"] == [d.isoformat() for d in ss[10:15]] and len(seen) == 1


def test_error_propagates_after_status_save(tmp_path):
    ss = _sessions(date(2026, 8, 3), 5)
    now = datetime(2026, 8, 7, 16, 0, tzinfo=KST)
    data = {d.strftime("%Y%m%d"): 381 for d in ss}
    fetch = FakeFetcher(data, fail_on="20260805")
    with pytest.raises(RuntimeError):
        MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch, pause_sec=0, alert=lambda *a, **k: {})
    st = MS.load_status("005930", tmp_path)
    assert st["days"]["2026-08-07"]["state"] == "ok" and st["days"]["2026-08-06"]["state"] == "ok" and "2026-08-05" not in st["days"]


def test_excluded_index_and_constants(tmp_path):
    with pytest.raises(MS.MinuteStoreError):
        MS.accumulate(None, "KOSPI200", [], root=tmp_path, fetcher=FakeFetcher({}))
    import pathlib
    import yaml
    cfg = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    ms = cfg["intraday"]["minute_store"]
    assert list(ms["codes"]) == list(MS.CODES) and "KOSPI200" in ms["excluded"] and "KOSPI200" in MS.EXCLUDED
    assert ms["depth_days"] == MS.DEPTH_DAYS == cfg["kis"]["minute_depth_days_measured"]
    assert ms["empty_retry_max"] == MS.EMPTY_RETRY_MAX and ms["depth_stop_consecutive_empty"] == MS.DEPTH_STOP_CONSECUTIVE_EMPTY
    assert ms["min_bars_full_day"] == MS.MIN_BARS_FULL_DAY and ms["complete_after_kst"] == MS.COMPLETE_AFTER_KST.strftime("%H:%M")
    assert ms["tr_id"] == MS.TR_ID
    s = MS.summarize_store(["005930"], tmp_path)
    assert s["codes"]["005930"]["stored_days"] == 0 and "KOSPI200" in s["excluded"]


def test_reconcile_status_from_files_after_interrupted_run(tmp_path):
    ss = _sessions(date(2026, 8, 3), 5)
    now = datetime(2026, 8, 7, 16, 0, tzinfo=KST)
    # 파일은 있는데 상태 파일이 없는 상황(중단된 실행) 재현
    for d in ss[:3]:
        MS.write_day("005930", d, MS.bars_to_frame("005930", d, _bars(381)), tmp_path)
    MS.write_day("005930", ss[3], MS.bars_to_frame("005930", ss[3], _bars(100)), tmp_path)
    fetch = FakeFetcher({d.strftime("%Y%m%d"): 381 for d in ss})
    r = MS.accumulate(None, "005930", ss, now=now, root=tmp_path, fetcher=fetch, pause_sec=0, alert=lambda *a, **k: {})
    # ok 3일은 재적재 안 함, partial 1일 + 미적재 1일만 받는다
    assert sorted(fetch.calls) == [ss[3].strftime("%Y%m%d"), ss[4].strftime("%Y%m%d")]
    st = MS.load_status("005930", tmp_path)
    assert all(st["days"][d.isoformat()]["state"] == "ok" for d in ss)
    assert st["days"][ss[0].isoformat()].get("reconciled") is True and r.stored_days == 5
