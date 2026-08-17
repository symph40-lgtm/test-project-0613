# T1 조달 실측 프로브 (WORKORDER_MTPRO_v10 §1) — 조달 여부·행 수·구간·결측만 본다. 값 사용 없음.
import os, json, time, datetime as dt
from pathlib import Path
env = Path(r"D:\vivecoding\test project_0613\.env.local")
for line in env.read_text(encoding="utf-8").splitlines():
    if line.startswith(("KRX_ID=", "KRX_PW=")):
        k, v = line.split("=", 1); os.environ[k] = v.strip().strip('"').strip("'")
from pykrx import stock
import pandas as pd

S, E = "20220103", dt.date.today().strftime("%Y%m%d")
out = {"probe_ts": dt.datetime.now().isoformat(timespec="seconds")}

def rng(df):
    return {"rows": int(len(df)), "range": [str(df.index.min())[:10], str(df.index.max())[:10]] if len(df) else None,
            "na_ratio": float(df.isna().mean().mean()) if len(df) else None}

def safe(name, fn):
    t = time.time()
    try:
        r = fn(); r["sec"] = round(time.time() - t, 1); out[name] = r
    except Exception as ex:
        out[name] = {"error": f"{type(ex).__name__}: {str(ex)[:160]}", "sec": round(time.time() - t, 1)}

# T1-2 (a) 구성종목 point-in-time: 지수 1028 포트폴리오를 과거 날짜로 조회
def pit():
    r = {}
    for d in ["20230103", "20240102", "20250102", E]:
        lst = stock.get_index_portfolio_deposit_file("1028", d)
        r[d] = {"n": len(lst), "head": list(lst[:3])}
    a = set(stock.get_index_portfolio_deposit_file("1028", "20230103")); b = set(stock.get_index_portfolio_deposit_file("1028", E))
    r["turnover_2023_vs_now"] = {"only_2023": len(a - b), "only_now": len(b - a), "common": len(a & b)}
    return r
safe("T1-2_constituents_pit", pit)

# T1-2 (b) 시가총액 — 종목 3년 시계열 + 단면(분위 정의용)
safe("T1-2_mcap_005930_series", lambda: rng(stock.get_market_cap_by_date(S, E, "005930")))
def mcap_cross():
    df = stock.get_market_cap(E, market="KOSPI")
    return {"rows": int(len(df)), "cols": [str(c) for c in df.columns][:6]}
safe("T1-2_mcap_cross_section", mcap_cross)
def mcap_cross_2023():
    df = stock.get_market_cap("20230103", market="KOSPI")
    return {"rows": int(len(df))}
safe("T1-2_mcap_cross_section_2023", mcap_cross_2023)

# T1-2 (c) 가격 이력 2022~ (lookback) — pykrx OHLCV(거래대금 포함) 종목 1개·지수 1028
safe("T1-2_ohlcv_005930_2022", lambda: dict(rng(stock.get_market_ohlcv(S, E, "005930")), cols=[str(c) for c in stock.get_market_ohlcv("20260801", E, "005930").columns]))
safe("T1-2_index_ohlcv_1028_2022", lambda: rng(stock.get_index_ohlcv(S, E, "1028")))

# T1-1 (a) 지수 단위 후보 ①선물 수급 — pykrx에 파생 투자자별 API가 있는지
def fut():
    r = {}
    for fn in ["get_market_trading_value_by_date"]:
        try:
            df = getattr(stock, fn)("20260701", E, "KOSPI200")  # 이름으로 지수 지정 시도
            r[fn + ":KOSPI200"] = rng(df)
        except Exception as ex:
            r[fn + ":KOSPI200"] = f"error {str(ex)[:80]}"
    import pykrx
    names = [n for n in dir(pykrx.stock) if "trading" in n or "invest" in n]
    r["available_fns"] = names
    return r
safe("T1-1_futures_flow_attempt", fut)

# T1-1 (b) 구성종목 합산 경로 — 5종목 소요 시간으로 197종목 외삽
def const_sum():
    tick = ["005930", "000660", "005380", "000270", "035420"]
    t = time.time(); rows = []
    for tk in tick:
        df = stock.get_market_trading_value_by_date("20230103", E, tk); rows.append(len(df))
    sec = time.time() - t
    return {"tickers": len(tick), "rows_each": rows, "sec_5": round(sec, 1), "est_sec_197": round(sec / 5 * 197)}
safe("T1-1_constituent_sum_timing", const_sum)

# T1-1 (c) 정규화 분모: 거래대금 (OHLCV에 포함) — 위 ohlcv cols에서 확인 / 시총은 위 mcap
# T1-1 (d) 세션: pykrx 로그인 만료 — 로그 문구 "만료 시간" 1시간 (표준출력 관찰) — 여기선 재로그인 여부만
out["session_note"] = "pykrx 로그인 시 stdout에 '만료 시간 = 로그인+60분' 출력됨 (8/16 22:45·23:32 관찰). 크론은 실행마다 새 로그인."

print(json.dumps(out, ensure_ascii=False, indent=1))
