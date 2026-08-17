import os, json
from pathlib import Path
env = Path(r"D:\vivecoding\test project_0613\.env.local")
for line in env.read_text(encoding="utf-8").splitlines():
    if line.startswith(("KRX_ID=", "KRX_PW=")):
        k, v = line.split("=", 1); os.environ[k] = v.strip().strip('"').strip("'")
from pykrx import stock
r={}
df = stock.get_market_trading_value_by_date("20260801","20260814","005930", on="매수")
r["buy_cols"]=[str(c) for c in df.columns]; r["buy_rows"]=len(df); r["buy_last_total_positive"]=bool(df.iloc[-1][df.columns[-1]]>0)
df2 = stock.get_market_trading_value_by_date("20260801","20260814","005930", detail=True)
r["detail_cols"]=[str(c) for c in df2.columns]
df3 = stock.get_market_ohlcv("20260801","20260814","005930", adjusted=False)
r["ohlcv_cols"]=[str(c) for c in df3.columns]
print(json.dumps(r,ensure_ascii=False))
