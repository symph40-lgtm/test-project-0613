# MT-PRO T3-A — KRX bronze 적재 요약 (`jobs/ingest_krx.py`)

- 실행: 2026-08-17T10:20:22+00:00 ~ 2026-08-17T10:21:32+00:00 (UTC) · 실행 단계: flow, ohlcv_unadj, ohlcv_adj, pit, const_ohlcv, const_flow · 소요 합계 442.5s
- 원천: pykrx(KRX 로그인 세션, `settings.krx_env()` = 기존 저장소 `.env.local`의 KRX_ID/KRX_PW만) · 스키마 `schema.BRONZE_*` · 모든 행 source/fetch_ts(UTC)/price_adjusted 기록
- loud-failure: KRX_ENV(계정 없음)·KRX_SESSION(핵심 시계열 0행)·KRX_API(3회 재시도 실패) → 예외 + logs/alerts.jsonl. 구성종목 개별 0행은 결측 목록으로 기록(저장 생략).

| 파일 (data/bronze) | 행 수 | 구간 | 키 수(scope/code) | 결측 셀 | 비고 |
|---|---|---|---|---|---|
| investor_flow.parquet | 2,646 | 2023-01-03 ~ 2026-08-14 | 3 | 0 | 005930·000660·KOSPI(시장 전체) 순매수, krx_session=True |
| ohlcv_unadj.parquet | 2,646 | 2023-01-03 ~ 2026-08-14 | 3 | 4410 | price_adjusted=False; KOSPI 행은 거래대금(매수 총액)만, OHLC None |
| ohlcv_adj.parquet | 3,387 | 2022-01-03 ~ 2026-08-14 | 3 | 0 | price_adjusted=True, trading_value None; KOSPI200 = 지수 1028 |
| constituents.parquet | 11,203 | 2022-01-03 ~ 2026-08-03 | 252 | 0 | 월초 첫 거래일 PIT 스냅샷 (asof) |
| market_cap.parquet | 53,253 | 2022-01-03 ~ 2026-08-03 | 1000 | 0 | 같은 asof KOSPI 시총 단면 (price_adjusted=False) |
| ohlcv_adj_constituents.parquet | 275,223 | 2022-01-03 ~ 2026-08-14 | 252 | 0 | 역대 PIT 합집합, 결측 종목 0 |
| investor_flow_constituents.parquet | 214,907 | 2023-01-03 ~ 2026-08-14 | 252 | 0 | C-1 대사 캐시, 결측 종목 0 |

## 단계별 실행 결과

- **flow** (10.1s): `{"path": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\investor_flow.parquet", "rows_total": 2646, "per_scope": {"005930": {"rows_new": 882}, "000660": {"rows_new": 882}, "KOSPI": {"rows_new": 882}}, "seconds": 10.1}`
- **ohlcv_unadj** (4.1s): `{"path": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\ohlcv_unadj.parquet", "rows_total": 2646, "per_code": {"005930": {"rows_new": 882}, "000660": {"rows_new": 882}, "KOSPI": {"rows_new": 882}}, "seconds": 4.1}`
- **ohlcv_adj** (7.4s): `{"path": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\ohlcv_adj.parquet", "rows_total": 3387, "per_code": {"005930": {"rows_new": 1129}, "000660": {"rows_new": 1129}, "KOSPI200": {"rows_new": 1129}}, "seconds": 7.4}`
- **pit** (37.1s): `{"path_constituents": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\constituents.parquet", "rows_constituents": 11203, "path_market_cap": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\market_cap.parquet", "rows_market_cap": 53253, "months_total": 56, "months_new": ["2022-01", "2022-02", "2022-03", "2022-04", "2022-05", "2022-06", "2022-07", "2022-08", "2022-09", "2022-10", "2022-11", "2022-12", "2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08", "2023-09", "2023-10", "2023-11", "2023-12", "2024-01", "2024-02", "2024-03", "2024-04", "202`
- **const_ohlcv** (43.7s): `{"path": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\ohlcv_adj_constituents.parquet", "rows_total": 275223, "tickers": 252, "ok": 252, "rows_new": 275223, "seconds": 43.7}`
- **const_flow** (340.1s): `{"path": "D:\\vivecoding\\test project_0613\\mtpro\\data\\bronze\\investor_flow_constituents.parquet", "rows_total": 214907, "tickers": 252, "ok": 252, "rows_new": 214907, "seconds": 340.1}`

## 부품 4 flow_panel 요약

- `jobs/build_flow.py` → `data/gold/flow_panel.parquet` (engine flow-0.1, KOSPI200 수급 소스 = `KOSPI_MARKET`), 행 2,646

| scope | 행 | 구간 | None 비율 (norm/β/잔차z/추세z) | \|β\|>1 일수(비율) | 잔차 z 2.5~97.5% | 잔차 z std | β 중앙값(외국인/기관) |
|---|---|---|---|---|---|---|---|
| 000660 | 882 | 2023-01-03~2026-08-14 | 0.022/0.088/0.155/0.094 | 0 (0.0) | [-1.956, 2.563] | 1.148 | 0.1067/0.1454 |
| 005930 | 882 | 2023-01-03~2026-08-14 | 0.022/0.088/0.155/0.094 | 0 (0.0) | [-2.319, 2.701] | 1.173 | 0.058/0.0596 |
| KOSPI200 | 882 | 2023-01-03~2026-08-14 | 0.022/0.088/0.155/0.094 | 0 (0.0) | [-2.362, 2.536] | 1.193 | 0.1665/0.1656 |
