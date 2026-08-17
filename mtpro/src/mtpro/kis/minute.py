"""국내주식 일별 1분봉 (FHKST03010230, inquire-time-dailychartprice).

실측 규약(기존 시스템 2026-07-16 실측을 MT-PRO에서 재검증, probes/t2_kis_minute_probe.py):
- 1회 호출 = 요청 시각(FID_INPUT_HOUR_1)에서 과거로 최대 ~61봉 → 60분 앵커 7회로 하루(09:00~15:30) 커버.
- 이력 깊이 약 120일 (rolling). 봉 시각은 봉 시작 기준.
- 당일 미래 시각 요청 시 직전 거래일 봉이 당일 라벨로 섞여 오는 함정 → stck_bsop_date == 요청일 필터 + 현재 분 이전만.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime

import pandas as pd

from mtpro.kis.client import KST, KisClient

ANCHORS = ["100000", "110000", "120000", "130000", "140000", "150000", "153000"]
PATH = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"
TR_ID = "FHKST03010230"


@dataclass
class MinuteFetchResult:
    code: str
    date: str  # YYYYMMDD
    bars: pd.DataFrame  # columns: time(HH:MM), open, high, low, close, volume ; index reset
    calls: int
    raw_rows: int


def _to_num(x) -> float:
    try:
        return float(str(x).replace(",", ""))
    except Exception:
        return float("nan")


def fetch_day_minutes(client: KisClient, code: str, ymd: str, up_to: str = "153000",
                      market_div: str = "J", pause_sec: float = 0.15) -> MinuteFetchResult:
    anchors = [h for h in ANCHORS if h <= up_to]
    if not anchors or anchors[-1] != up_to:
        anchors.append(up_to)
    rows: dict[str, dict] = {}
    raw = 0
    for hour in anchors:
        j = client.get(PATH, TR_ID, {
            "FID_COND_MRKT_DIV_CODE": market_div,
            "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": ymd,
            "FID_INPUT_HOUR_1": hour,
            "FID_PW_DATA_INCU_YN": "N",
            "FID_FAKE_TICK_INCU_YN": "",
        })
        out2 = j.get("output2") or []
        raw += len(out2)
        for r in out2:
            if str(r.get("stck_bsop_date", "")) != ymd:
                continue
            h = str(r.get("stck_cntg_hour", ""))
            if len(h) != 6 or not h.isdigit():
                continue
            o, hi, lo, c = (_to_num(r.get(k)) for k in ("stck_oprc", "stck_hgpr", "stck_lwpr", "stck_prpr"))
            if not all(v == v and v > 0 for v in (o, hi, lo, c)):
                continue
            v = _to_num(r.get("cntg_vol"))
            rows[h[:4]] = {"time": f"{h[:2]}:{h[2:4]}", "open": o, "high": hi, "low": lo, "close": c,
                           "volume": v if v == v else 0.0}
        time.sleep(pause_sec)
    df = pd.DataFrame(sorted(rows.values(), key=lambda d: d["time"]),
                      columns=["time", "open", "high", "low", "close", "volume"])
    # 당일이면 현재 분 이전 완성봉만
    now = datetime.now(KST)
    if ymd == now.strftime("%Y%m%d") and len(df):
        df = df[df["time"] < now.strftime("%H:%M")].reset_index(drop=True)
    return MinuteFetchResult(code, ymd, df, len(anchors), raw)
