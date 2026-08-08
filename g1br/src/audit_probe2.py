# T1 후속 프로브 — 1차에서 실패·미확정 3건 재검
# ① KOSPI200: pykrx 지수 엔드포인트 실패(KRX 로그인 요구 의심) → 대안 3종 비교
# ② 삼전 수정주가 연속성: adjusted=False 재시도
# ③ FRED 게시 지연: 1차는 프로브 코드 버그(일요일을 previous_session에 직접 전달) — 수정 재실행
import io
import json
import sys
import datetime as dt

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
out: dict = {}
START = "2023-01-01"
TODAY = dt.date.today().isoformat()

# ① KOSPI200 대안
def kospi200_alternatives() -> None:
    res = {}
    from pykrx import stock
    # 1a. pykrx 지수 재시도 + 로그인 필요 여부 판별
    try:
        df = stock.get_index_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "1028")
        res["pykrx_1028"] = {"rows": len(df), "first": str(df.index[0].date()), "last": str(df.index[-1].date())}
    except Exception as e:
        res["pykrx_1028"] = {"error": f"{type(e).__name__}: {e}"[:150],
                             "suspect": "pykrx 신버전이 지수 API에 KRX 데이터 계정(KRX_ID/KRX_PW) 요구"}
    import yfinance as yf
    # 1b. yfinance ^KS200
    try:
        df = yf.Ticker("^KS200").history(start=START, auto_adjust=True)
        res["yf_^KS200"] = {"rows": len(df), "first": str(df.index[0].date()), "last": str(df.index[-1].date()),
                            "nan_close": int(df["Close"].isna().sum()),
                            "has_open": bool((df["Open"] > 0).all())}
    except Exception as e:
        res["yf_^KS200"] = {"error": str(e)[:150]}
    # 1c. yfinance ^KS11 (KOSPI 종합 — 최후 대안)
    try:
        df = yf.Ticker("^KS11").history(start=START, auto_adjust=True)
        res["yf_^KS11"] = {"rows": len(df), "first": str(df.index[0].date()), "last": str(df.index[-1].date())}
    except Exception as e:
        res["yf_^KS11"] = {"error": str(e)[:150]}
    # 1d. pykrx KODEX200 ETF (069500) — 종목 API는 로그인 없이 됨을 1차에서 확인
    try:
        df = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "069500", adjusted=True)
        res["pykrx_KODEX200"] = {"rows": len(df), "first": str(df.index[0].date()), "last": str(df.index[-1].date()),
                                 "note": "ETF라 분배금 조정 필요 — 지수 프록시로는 ^KS200 우선"}
    except Exception as e:
        res["pykrx_KODEX200"] = {"error": str(e)[:150]}
    out["kospi200"] = res


# ② 수정주가 연속성 — 삼전 배당락일 전후
def adjust_continuity() -> None:
    from pykrx import stock
    res = {}
    try:
        adj = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "005930", adjusted=True)
        raw = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "005930", adjusted=False)
        both = adj.join(raw, lsuffix="_adj", rsuffix="_raw")
        diff = both[both["종가_adj"] != both["종가_raw"]]
        res["diff_days"] = int(len(diff))
        res["note"] = ("차이 0 = 기간 내 가격조정 이벤트 없음(현금배당은 KRX 시세 조정 없음, 액면분할 2018년이라 기간 밖)"
                       if len(diff) == 0 else f"조정 발생 구간 존재 — 첫 차이일 {diff.index[0].date()}")
        # 일일 수익률 이상치(±25% 초과)로 미조정 점프 잔존 여부 확인
        r = adj["종가"].pct_change().abs()
        res["max_daily_move_pct"] = round(100 * float(r.max()), 2)
        res["moves_over_25pct"] = int((r > 0.25).sum())
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"[:200]
    out["adjust_check"] = res


# ③ FRED 게시 지연 실측 (버그 수정판)
def fred_lag() -> None:
    import pandas_datareader.data as web
    import exchange_calendars as xcals
    res = {}
    xnys = xcals.get_calendar("XNYS")
    # 오늘이 세션이 아니면 직전 세션으로 — date_to_session(direction="previous")
    prev_us = xnys.date_to_session(TODAY, direction="previous").date()
    for s in ["DGS2", "DGS10"]:
        try:
            df = web.DataReader(s, "fred", START, TODAY)
            ser = df[s].dropna()
            last_obs = ser.index[-1].date()
            lag_sessions = len(xnys.sessions_in_range(last_obs.isoformat(), prev_us.isoformat())) - 1
            res[s] = {
                "rows": len(df), "non_nan": len(ser), "nan_pct": round(100 * (1 - len(ser) / len(df)), 2),
                "first": str(ser.index[0].date()), "last_obs": str(last_obs),
                "prev_us_session": str(prev_us), "lag_us_sessions": lag_sessions,
            }
        except Exception as e:
            res[s] = {"error": f"{type(e).__name__}: {e}"[:200]}
    res["available_by_0715_verdict"] = (
        "H.15는 미 동부 오후 4시대(≈KST 익일 05~06시) 게시가 정상이나, FRED 반영은 통상 1영업일 지연. "
        "위 lag_us_sessions 실측이 1 이상이면 R1(07:15)에 '당일치'는 없다고 판정 — 전일치 사용 원칙 확정."
    )
    out["fred"] = res


def main() -> None:
    for fn in [kospi200_alternatives, adjust_continuity, fred_lag]:
        try:
            fn()
            print(f"[OK] {fn.__name__}")
        except Exception as e:
            out[fn.__name__] = {"fatal": str(e)[:300]}
            print(f"[FAIL] {fn.__name__}: {e}")
    with open("reports/audit_probe2.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2, default=str)
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
