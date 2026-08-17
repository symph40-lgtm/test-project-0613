# T2 첫 검증 (발주자 지시 8/17 ③): MT-PRO 전용 KIS 실전 키로 토큰 발급 + 국내주식 분봉 1회 실측.
# 출력: 토큰 캐시 경로·발급 시각(토큰 값은 출력하지 않음), 종목·일자·봉 수·첫/끝 시각·호출 수·이력 깊이 샘플.
import json, sys, time
from datetime import datetime, timedelta
sys.path.insert(0, "src")
from mtpro import settings
from mtpro.kis.client import KisClient, KST
from mtpro.kis.minute import fetch_day_minutes

out = {"probe_ts": datetime.now(KST).isoformat(timespec="seconds"), "base": settings.kis_base(),
       "token_cache_path": str(settings.KIS_TOKEN_CACHE)}
c = KisClient()
t0 = time.time(); c.token(); out["token_issue_sec"] = round(time.time() - t0, 2)
out["token_issued_at"] = c._token.issued_at
out["token_expires_at"] = datetime.fromtimestamp(c._token.expires_at, KST).isoformat(timespec="seconds")

# 최근 거래일(2026-08-14) 005930 분봉 1회
r = fetch_day_minutes(c, "005930", "20260814")
out["005930_20260814"] = {"bars": len(r.bars), "calls": r.calls, "raw_rows": r.raw_rows,
                          "first": r.bars["time"].iloc[0] if len(r.bars) else None,
                          "last": r.bars["time"].iloc[-1] if len(r.bars) else None}
# 이력 깊이 샘플: 120일 전후 (앵커 1개만, 호출 절약)
for days in (60, 118, 125, 140):
    d = (datetime.now(KST) - timedelta(days=days))
    # 주말 회피
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    ymd = d.strftime("%Y%m%d")
    try:
        rr = fetch_day_minutes(c, "005930", ymd, up_to="100000")
        out[f"depth_{days}d_{ymd}"] = {"bars": len(rr.bars), "raw_rows": rr.raw_rows}
    except Exception as ex:
        out[f"depth_{days}d_{ymd}"] = {"error": str(ex)[:120]}
print(json.dumps(out, ensure_ascii=False, indent=1))
