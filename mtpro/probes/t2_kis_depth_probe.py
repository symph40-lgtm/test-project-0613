# KIS 분봉 이력 깊이 경계 실측 (앵커 1개/일, 호출 절약)
import json, sys
from datetime import datetime, timedelta
sys.path.insert(0, "src")
from mtpro.kis.client import KisClient, KST
from mtpro.kis.minute import fetch_day_minutes
c = KisClient(); out = {}
for days in (180, 240, 300, 365, 450, 550, 730):
    d = datetime.now(KST) - timedelta(days=days)
    while d.weekday() >= 5: d -= timedelta(days=1)
    ymd = d.strftime("%Y%m%d")
    try:
        r = fetch_day_minutes(c, "005930", ymd, up_to="100000")
        out[f"{days}d_{ymd}"] = {"bars": len(r.bars), "raw_rows": r.raw_rows}
    except Exception as ex:
        out[f"{days}d_{ymd}"] = {"error": str(ex)[:100]}
print(json.dumps(out, ensure_ascii=False))
