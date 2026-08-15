# 야간선물 히스토리 재조달 — 정본 산출 (발주 8/14 ①(a) 확보 성공분)
#
# 소스: KRX 정보데이터시스템 [15003] 개별종목 시세추이, bld MDCSTAT12902
#   aggBasTpCd: "0"=정규(주간), "2"=야간 (MDCSTAT129.jsp 라디오 실측)
#   공식 규약(JSP 각주 4): 자체 야간거래('25.6.9~)의 조회기준 = 야간거래종료일(T+1).
#   실측은 '다음 거래일' 라벨 (금요일 밤 8/14 세션 → 8/18 화 라벨: 8/15 광복절·8/17 대체휴일 건너뜀)
#   = G1B g1b_days.date(갭 판정일 아침) 규약과 동일. CME 시절('20.12 이전)은 개시일 라벨 — 제외(발주 (c)).
#
# 월물 코드 (ISIN 체크섬 검증·실조회 확인 8/15):
#   2025년 만기 3종은 구코드(KR4101W…), 2026년~ 는 신코드(KR4A01…) — 혼용이 실측 결과.
#
# u1 내재갭 정의: u1(L) = 야간 종가(L, 최근월) / 직전 거래일 주간 종가(같은 월물) - 1
#   최근월 규약: front(L) = 만기일 >= L 인 월물 중 만기 최소 (만기일 밤 세션부터 차월물 = 라벨 L > 만기).
#   0715 감사: 야간 세션 마감 06:00 < R1 절단 07:15 — 구조적으로 룩어헤드 없음 (audit 기록).
#
# 실행: g1br 루트에서 .venv\Scripts\python src\fetch_night_krx.py
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd

root = Path(__file__).resolve().parents[2]
for line in (root / ".env.local").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

from pykrx.website.krx.krxio import KrxWebIo  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "data"

# (월물, ISU 전체코드, 만기일 — 분기월 둘째 목요일)
CONTRACTS = [
    ("202506", "KR4101W60000", "2025-06-12"),
    ("202509", "KR4101W90007", "2025-09-11"),
    ("202512", "KR4101WC0003", "2025-12-11"),
    ("202603", "KR4A01630008", "2026-03-12"),
    ("202606", "KR4A01660005", "2026-06-11"),
    ("202609", "KR4A01690002", "2026-09-10"),
]
NIGHT_START = "2025-06-10"  # 자체 야간 첫 라벨 (6/9 밤 세션)


class Bld(KrxWebIo):
    def __init__(self, b):
        super().__init__()
        self._b = b

    @property
    def bld(self):
        return self._b

    def fetch(self, **p):
        return self.read(**p)


def _num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _fetch_window(io, isu_cd, agg, strt, end):
    # KRX 쓰로틀링(비JSON 에러페이지) 대비 — 지수 백오프 3회
    for attempt in range(3):
        try:
            return io.fetch(prodId="KRDRVFUK2I", strtDd=strt, endDd=end, isuCd=isu_cd, isuCd2=isu_cd, aggBasTpCd=agg)
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(4 * (attempt + 1))
    return {}


def fetch_series(io, isu_cd, agg, strt, end):
    # 실측(8/15): 연도 경계를 넘는 범위 요청이 두 차례 모두 같은 지점(202603, 20250601~20260319)에서
    # 비JSON 응답으로 죽음 — 범위를 분기(3개월) 창으로 쪼개 연도 교차를 피한다. 창별 실패는 기록 후 계속.
    d1 = dt.date(int(strt[:4]), int(strt[4:6]), int(strt[6:]))
    d2 = dt.date(int(end[:4]), int(end[4:6]), int(end[6:]))
    j = {"output": []}
    cur = d1
    while cur <= d2:
        nxt = min(dt.date(cur.year + (cur.month + 2) // 12, (cur.month + 2) % 12 + 1, 1) - dt.timedelta(days=1), d2)
        try:
            part = _fetch_window(io, isu_cd, agg, cur.isoformat().replace("-", ""), nxt.isoformat().replace("-", ""))
            j["output"].extend(part.get("output", []))
        except Exception as e:  # noqa: BLE001
            print(f"    창 실패 {cur}~{nxt}: {type(e).__name__}", flush=True)
        time.sleep(1.2)
        cur = nxt + dt.timedelta(days=1)
    rows = []
    for r in j.get("output", []):
        d = str(r.get("TRD_DD", "")).replace("/", "-")
        rows.append({
            "label_date": d, "open": _num(r.get("TDD_OPNPRC")), "high": _num(r.get("TDD_HGPRC")),
            "low": _num(r.get("TDD_LWPRC")), "close": _num(r.get("TDD_CLSPRC")), "volume": _num(r.get("ACC_TRDVOL")),
        })
    return pd.DataFrame(rows)


def main():
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    today = dt.date.today().isoformat().replace("-", "")
    io = Bld("dbms/MDC/STAT/standard/MDCSTAT12902")
    frames = []
    for cname, isu, expiry in CONTRACTS:
        # 월물 수명 창: 야간 개시(25-06-01)부터 만기+7일(마지막 라벨 여유)까지 — 미만기면 오늘까지
        end = min(dt.date.fromisoformat(expiry) + dt.timedelta(days=7), dt.date.today()).isoformat().replace("-", "")
        for agg, sess in [("2", "night"), ("0", "day")]:
            df = fetch_series(io, isu, agg, "20250601", end)
            if not df.empty:
                df["contract"], df["session"], df["isu_cd"] = cname, sess, isu
                frames.append(df)
            print(f"  {cname} {sess}: {len(df)}행", flush=True)
            time.sleep(1.6)
    raw = pd.concat(frames, ignore_index=True)
    raw["source"] = "KRX MDCSTAT12902"
    raw["fetch_ts"] = now
    DATA.mkdir(exist_ok=True)
    raw.to_parquet(DATA / "krx_nightfut_daily.parquet", index=False)

    # ── u1 스티칭 ──
    night = raw[raw.session == "night"].set_index(["contract", "label_date"])
    day = raw[raw.session == "day"].set_index(["contract", "label_date"])
    # 거래일 달력 = 주간 라벨의 합집합 (전 월물)
    cal = sorted(set(raw[raw.session == "day"].label_date))
    expiry_map = {c: e for c, _, e in CONTRACTS}
    out = []
    for L in [d for d in cal if d >= NIGHT_START]:
        fronts = [c for c, e in expiry_map.items() if e >= L]
        if not fronts:
            continue
        front = min(fronts, key=lambda c: expiry_map[c])
        prevs = [d for d in cal if d < L]
        if not prevs:
            continue
        T = prevs[-1]
        n_close = night.close.get((front, L))
        d_close = day.close.get((front, T))
        u1 = (n_close / d_close - 1) * 100 if (n_close and d_close) else None
        out.append({
            "label_date": L, "session_start": T, "contract": front,
            "night_open": night.open.get((front, L)), "night_close": n_close,
            "night_volume": night.volume.get((front, L)),
            "day_close_ref": d_close, "u1_pct": round(u1, 4) if u1 is not None else None,
        })
    u1df = pd.DataFrame(out)
    u1df["source"] = "KRX MDCSTAT12902 (T+1 라벨)"
    u1df["fetch_ts"] = now
    u1df.to_parquet(DATA / "nightfut_u1.parquet", index=False)
    u1df.to_csv(DATA / "nightfut_u1.csv", index=False, encoding="utf-8-sig")

    # ── 감사 ──
    miss = u1df[u1df.u1_pct.isna()]
    audit = {
        "rows": len(u1df), "coverage": [u1df.label_date.min(), u1df.label_date.max()],
        "missing_u1": len(miss), "missing_dates": miss.label_date.tolist()[:20],
        "audit_0715": "야간 세션 마감 06:00(KST) < R1 절단 07:15 — 전 행 구조적 충족 (세션 정의 18:00~06:00, KRX 공식)",
        "label_convention": "KRX T+1(다음 거래일) = g1b_days.date 동일 / KIS CM은 개시일 라벨 (변환: KIS[T] = KRX[T의 다음 거래일])",
        "cme_era_excluded": "발주 (c) — '20.12 이전 CME 연계는 라벨 규약 다름(개시일)·미포함",
        "stats": {
            "abs_u1_median": round(u1df.u1_pct.abs().median(), 3),
            "abs_u1_p90": round(u1df.u1_pct.abs().quantile(0.9), 3),
            "max": round(u1df.u1_pct.max(), 3), "min": round(u1df.u1_pct.min(), 3),
        },
        "fetch_ts": now,
    }
    (DATA / "nightfut_u1_audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(audit, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
