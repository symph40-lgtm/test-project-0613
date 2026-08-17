# 부품 4 지수(시장) 단위 투자자별 순매수 3년 조달 프로브 — 조달 여부만
import os, json, datetime as dt
from pathlib import Path
env = Path(r"D:\vivecoding\test project_0613\.env.local")
for line in env.read_text(encoding="utf-8").splitlines():
    if line.startswith(("KRX_ID=", "KRX_PW=")):
        k, v = line.split("=", 1); os.environ[k] = v.strip().strip('"').strip("'")
from pykrx import stock
s, e = "20230103", dt.date.today().strftime("%Y%m%d")
out = {}
for key in ["KOSPI", "KOSDAQ"]:
    try:
        df = stock.get_market_trading_value_by_date(s, e, key)
        out[key] = {"rows": int(len(df)), "range": [str(df.index.min().date()), str(df.index.max().date())] if len(df) else None,
                    "cols": [c.encode('utf-8','ignore').decode('utf-8') for c in map(str, df.columns)][:8]}
    except Exception as ex:
        out[key] = {"error": f"{type(ex).__name__}: {str(ex)[:120]}"}
# 000660 종목 단위도 확인
try:
    df = stock.get_market_trading_value_by_date(s, e, "000660")
    out["000660"] = {"rows": int(len(df))}
except Exception as ex:
    out["000660"] = {"error": str(ex)[:120]}
print(json.dumps(out, ensure_ascii=False, indent=1))
