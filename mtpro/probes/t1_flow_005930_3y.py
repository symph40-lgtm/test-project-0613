# MT-PRO 접수 판정용 프로브 — 부품 4(Flow) 3년 조달 가능 여부만 본다 (값 사용 없음)
# KRX 계정은 .env.local의 KRX_ID/KRX_PW를 pykrx가 env로 읽음 (g1br/src/fetch.py와 동일 관행)
import os, sys, json, datetime as dt
from pathlib import Path

env = Path(r"D:\vivecoding\test project_0613\.env.local")
for line in env.read_text(encoding="utf-8").splitlines():
    if line.startswith(("KRX_ID=", "KRX_PW=")):
        k, v = line.split("=", 1)
        os.environ[k] = v.strip().strip('"').strip("'")

out = {"has_account": bool(os.environ.get("KRX_ID") and os.environ.get("KRX_PW"))}
try:
    from pykrx import stock
    s, e = "20230103", dt.date.today().strftime("%Y%m%d")
    df = stock.get_market_trading_value_by_date(s, e, "005930")  # 투자자별 거래대금(순매수)
    out["005930_rows"] = int(len(df))
    out["005930_range"] = [str(df.index.min().date()), str(df.index.max().date())] if len(df) else None
    out["005930_cols"] = list(map(str, df.columns))[:8]
    out["005930_na_ratio"] = float(df.isna().mean().mean()) if len(df) else None
    df2 = stock.get_market_trading_value_by_date(s, e, "1028")  # KOSPI200 지수 단위 투자자별
    out["1028_rows"] = int(len(df2))
    out["1028_range"] = [str(df2.index.min().date()), str(df2.index.max().date())] if len(df2) else None
except Exception as ex:
    out["error"] = f"{type(ex).__name__}: {str(ex)[:200]}"
print(json.dumps(out, ensure_ascii=False, indent=1))
