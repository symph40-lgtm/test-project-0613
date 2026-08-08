# T1 — 데이터 조달 판정 프로브 (WORKORDER §2 / 스펙 §2.1~2.4)
# 각 소스에 실제 다운로드를 시도하고 커버리지·결측률·타임스탬프 의미를 실측한다.
# 이 파일은 판정 도구다 — 본 수집(fetch.py)은 T2에서 별도 구현.
import sys
import io
import json
import datetime as dt

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

START = "2023-01-01"
TODAY = dt.date.today().isoformat()
out: dict = {}


def biz_days_between(cal_name: str, start: str, end: str) -> int:
    import exchange_calendars as xcals
    cal = xcals.get_calendar(cal_name)
    return len(cal.sessions_in_range(start, end))


def probe_pykrx() -> None:
    from pykrx import stock
    res = {}
    for code, name in [("005930", "삼성전자"), ("000660", "SK하이닉스")]:
        try:
            df = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), code, adjusted=True)
            krx_days = biz_days_between("XKRX", START, TODAY)
            res[code] = {
                "name": name, "rows": len(df),
                "first": str(df.index[0].date()), "last": str(df.index[-1].date()),
                "krx_sessions": krx_days,
                "missing_pct": round(100 * (1 - len(df) / krx_days), 2),
                "cols": list(df.columns),
                "zero_or_nan_open": int(((df["시가"] == 0) | df["시가"].isna()).sum()),
            }
        except Exception as e:
            res[code] = {"name": name, "error": f"{type(e).__name__}: {e}"[:200]}
    # KOSPI200 지수
    try:
        df = stock.get_index_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "1028")
        res["1028"] = {"name": "KOSPI200", "rows": len(df),
                       "first": str(df.index[0].date()), "last": str(df.index[-1].date()),
                       "cols": list(df.columns)}
    except Exception as e:
        res["1028"] = {"name": "KOSPI200", "error": f"{type(e).__name__}: {e}"[:200]}
    # 락일 이벤트 (삼전 배당) — T3 ex_date 플래그용 가용성만
    try:
        div = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "005930", adjusted=False)
        adj = stock.get_market_ohlcv(START.replace("-", ""), TODAY.replace("-", ""), "005930", adjusted=True)
        diff_days = int((div["종가"] != adj["종가"]).sum())
        res["adjust_check"] = {"unadjusted_vs_adjusted_diff_days": diff_days,
                               "note": "0이면 조정 이벤트 없음(액면분할 2018이라 기간 밖) — 배당은 현금배당이라 가격조정 없음"}
    except Exception as e:
        res["adjust_check"] = {"error": str(e)[:200]}
    out["pykrx"] = res


def probe_yfinance() -> None:
    import yfinance as yf
    res = {}
    tickers = ["^GSPC", "SOXX", "TSM", "MU", "NVDA", "EWY", "KRW=X", "SMSN.IL", "^N225", "^AXJO", "RSP", "SPY"]
    for t in tickers:
        try:
            tk = yf.Ticker(t)
            df = tk.history(start=START, auto_adjust=True)
            if df.empty:
                res[t] = {"error": "empty"}
                continue
            cal = "XNYS" if t not in ("^N225", "^AXJO", "KRW=X", "SMSN.IL") else None
            expected = biz_days_between(cal, START, TODAY) if cal else None
            meta_cur = None
            try:
                meta_cur = tk.fast_info.get("currency")
            except Exception:
                pass
            res[t] = {
                "rows": len(df),
                "first": str(df.index[0].date()), "last": str(df.index[-1].date()),
                "missing_pct_vs_xnys": (round(100 * (1 - len(df) / expected), 2) if expected else None),
                "currency": meta_cur,
                "tz": str(df.index.tz),
                "nan_close": int(df["Close"].isna().sum()),
            }
        except Exception as e:
            res[t] = {"error": f"{type(e).__name__}: {e}"[:200]}
    out["yfinance_daily"] = res


def probe_fred() -> None:
    # DGS2·DGS10 — 게시 지연 실측이 핵심 (당일 07:15 KST 가용 여부)
    import pandas_datareader.data as web
    res = {}
    for s in ["DGS2", "DGS10"]:
        try:
            df = web.DataReader(s, "fred", START, TODAY)
            ser = df[s].dropna()
            last_obs = ser.index[-1].date()
            # 지연 = 마지막 관측일과 직전 미국 영업일의 차이
            import exchange_calendars as xcals
            xnys = xcals.get_calendar("XNYS")
            prev_us_session = xnys.previous_session(TODAY).date()
            res[s] = {
                "rows": len(df), "non_nan": len(ser),
                "first": str(ser.index[0].date()), "last_obs": str(last_obs),
                "prev_us_session": str(prev_us_session),
                "lag_days_now": (prev_us_session - last_obs).days,
                "nan_pct": round(100 * (1 - len(ser) / len(df)), 2),
            }
        except Exception as e:
            res[s] = {"error": f"{type(e).__name__}: {e}"[:200]}
    out["fred"] = res


def probe_intraday() -> None:
    # yfinance 일중 제한 실측 (§2.2) — CLV_us·last30m 구현 가능성 판정
    import yfinance as yf
    res = {}
    for interval, ask_days in [("1m", 8), ("5m", 59), ("15m", 59), ("30m", 59), ("60m", 500), ("60m", 730)]:
        try:
            end = dt.date.today()
            start = end - dt.timedelta(days=ask_days)
            df = yf.Ticker("^GSPC").history(start=start.isoformat(), end=end.isoformat(), interval=interval)
            key = f"{interval}_{ask_days}d"
            res[key] = {"rows": len(df),
                        "first": str(df.index[0]) if len(df) else None,
                        "last": str(df.index[-1]) if len(df) else None}
        except Exception as e:
            res[f"{interval}_{ask_days}d"] = {"error": f"{type(e).__name__}: {e}"[:150]}
    out["yfinance_intraday"] = res


def probe_grade_b() -> None:
    # B등급: 공개·정식 API로 접근 가능한 것만 시도 (크롤링 금지 — WORKORDER §2)
    import yfinance as yf
    res = {}
    # 니케이 선물: CME NKD=F (글로벡스 — 조기 세션 포함 24h 근접) — yfinance 일중
    for t, label in [("NKD=F", "니케이선물(CME·USD)"), ("NIY=F", "니케이선물(CME·JPY)")]:
        try:
            df = yf.Ticker(t).history(period="30d", interval="60m")
            res[t] = {"label": label, "rows": len(df),
                      "first": str(df.index[0]) if len(df) else None,
                      "last": str(df.index[-1]) if len(df) else None,
                      "note": "일중 60m — 히스토리 제한은 yfinance intraday 한도와 동일"}
        except Exception as e:
            res[t] = {"label": label, "error": f"{type(e).__name__}: {e}"[:150]}
    # KRX 야간선물(유렉스 연계)·TAIFEX 야간: yfinance/공개 API에 티커 없음 — 존재 조사 결과만 기록
    res["krx_night_futures"] = {
        "verdict": "조달 불가(공개 무료 히스토리 API 없음)",
        "basis": "유렉스 연계 KOSPI200 야간선물은 시세 히스토리가 유렉스/정보업체 유료 제공. yfinance 티커 부재.",
    }
    res["taifex_night"] = {
        "verdict": "부분 가능성 — TAIFEX 공식 사이트가 애프터아워 통계 CSV 제공(수동 다운로드), 자동화는 크롤링 영역이라 1주차 금지 범위",
        "basis": "공식 오픈 API 없음. 60일 로그 이관 권고.",
    }
    out["grade_b"] = res


def main() -> None:
    for fn in [probe_pykrx, probe_yfinance, probe_fred, probe_intraday, probe_grade_b]:
        name = fn.__name__
        try:
            fn()
            print(f"[OK] {name}")
        except Exception as e:
            out[name] = {"fatal": f"{type(e).__name__}: {e}"[:300]}
            print(f"[FAIL] {name}: {e}")
    with open("reports/audit_probe.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2, default=str)
    print("\n=== 요약 ===")
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
