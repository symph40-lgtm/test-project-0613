# MT-PRO T3 — C-1 지수 단위 대사 (KOSPI 시장 전체 vs PIT 구성종목 합산)

- 판정일: 2026-08-17 · 사전 등록 문안: `docs/mtpro-t1-procurement.md` 부록 C C-1 · config `flow.reconcile` (window 2023-01-03~2026-06-30, replace_if_below 0.8)
- 실행: `jobs/reconcile_flow.py` → `src/mtpro/components/flow_reconcile.py` (1회, 이후 재론 금지)
- 합산 = 각 거래일의 PIT 월초 스냅샷(`data/bronze/constituents.parquet`, asof ≤ 날짜 최신) 구성종목의 `get_market_trading_value_by_date` 순매수 합 (`data/bronze/investor_flow_constituents.parquet`). 그날 행이 없는 구성종목은 합에서 빠지고 `n_constituents_used` 로 기록.

## 결과

| 지표 | 외국인 | 기관 |
|---|---|---|
| 피어슨 상관 (일별 순매수, n=850) | **0.9967** | **0.9973** |
| 부호 일치율 | 0.9576 | 0.9659 |
| Σ\|합산\| / Σ\|시장\| | 0.9581 | 0.9847 |

- 사용 구성종목 수: 최소 198 · 중앙값 200.0 (스냅샷 200 기준)
- 구성종목 수급 캐시: 종목 252 · 성공 252 · 결측 0 · 행 214907 · 소요 340.1s

## 판정

- 규칙: 외국인·기관 상관 중 **하나라도 < 0.8 이면 PIT_CONSTITUENT_SUM 으로 교체**, 아니면 KOSPI_MARKET 유지.
- **판정: `flow.index_unit = KOSPI_MARKET`** (config/mtpro.yaml 갱신, `flow.reconcile_result` 에 값 기록). 이후 재론 금지.
- 부품 4 KOSPI200 스코프(`components/flow.py`)는 이 판정 소스를 사용한다.
