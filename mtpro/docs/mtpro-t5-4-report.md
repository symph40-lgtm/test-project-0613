# T5-4 — 부품 5 diffusion 축(semi_diffusion_z) 구현·조달 실측 보고 (2026-08-17)

스펙: `docs/mtpro-t5-plan.md` §3.3 `semi_diffusion_z` 행 + §12.4(z = t−1까지 120거래일, 표본<60 None) + WORKORDER AM-8 정의 구분(diffusion = 반도체 종목군 **내** 확산 / Transmission = 미국→개별 종목, 별개 필드). 범위는 **semi_diffusion 만**(breadth.py 본체·다른 부품·다른 config 블록은 손대지 않음, config는 `semi_diffusion` 블록만 추가). 커밋 없음.

## 1. 산출물

| 종류 | 경로 |
|---|---|
| 조달(ingest) | `src/mtpro/ingest/semi_group.py` — 반도체 종목군 월초 asof PIT 조달(pykrx KRX 지수 PDF ∩ K200 PIT), `SILVER_SEMI_GROUP_MONTHLY` 스키마 |
| 부품 코드 | `src/mtpro/components/semi_diffusion.py` — `compute_semi_diffusion_panel`, `GOLD_SEMI_DIFFUSION_PANEL`, 상수 |
| 테스트 | `tests/test_semi_diffusion.py` (10건, 합성 데이터) |
| 빌드 잡 | `jobs/build_semi_diffusion.py` (`--no-fetch`: silver 재사용, `--start`, `--summary-json`) |
| config | `config/mtpro.yaml` `semi_diffusion` 블록 (source·leaders·constants) |
| silver | `data/silver/semi_group_monthly.parquet` — month, asof, code, name, source, in_k200, survivorship_bias, fetch_ts (56개월 × 3~4종목 = 188행) |
| gold | `data/gold/semi_diffusion_panel.parquet` — date, semi_asof, n_semi, semi_above20, market_above20, diffusion_spread, semi_diffusion_z, leader_gap, semi_impulse, engine_ver (882행, 2023-01-03~2026-08-14, `semi_diffusion-0.1`) |

breadth.py 재사용(수정 없음): `_validate_adjusted`(C-2), `_pivot_close`, `_stock_indicators().above20`, `_snapshot_for_dates`(PIT asof ≤ t), `_mean_or_none`, `breadth_impulse`, `compute_breadth_panel`(market_above20).

## 2. 조달 실측 — 반도체 종목군 (월초 asof 동결)

### 2.1 (a) pykrx KRX 지수 PDF — 채택
- `stock.get_index_ticker_list(market="KOSPI")` 50개(1001~1894) 중 **"반도체" 업종지수는 없음**(KOSPI 업종은 `1013 전기전자`가 최소 단위, KOSPI200 섹터도 `1155 정보기술`). → 지시의 "KOSPI 반도체"는 존재하지 않음(실측 기록).
- `market="KRX"`: **`5044 KRX 반도체`**, 5064 KRX 정보기술 / `market="테마"`: **`5422 KRX 반도체 Top 15`**, 5450 KRX AI 반도체, 5453 KRX K-AI 반도체TOP2+.
- 두 지수의 PDF(`get_index_portfolio_deposit_file(code, asof)`)를 bronze `constituents.parquet`의 56개 asof(2022-01-03~2026-08-03) 전부에서 조회 → **PIT로 응답**(5044 구성수 44→40→41→50→55→36→35로 정기변경 시점에 변함).
- **발견**: `5044 KRX 반도체`는 **2023-09 정기변경 전까지 삼성전자(005930) 미편입**(지수 방법론 — 2023-10-04 asof부터 편입). 종목군 정의(업종)와 어긋나고 leader_gap(005930·000660)이 전제하는 구성원이 아님. `5422 Top 15`는 전 구간 편입.
- **채택 = 5044 ∪ 5422 PDF ∩ KOSPI200 PIT** (config `semi_diffusion.source.index_codes: ["5044","5422"]`, `method: pykrx_index_pdf_union`). 실측상 합집합 ∩ K200 = 5422 ∩ K200 과 동일. 각 종목이 어느 PDF에서 왔는지 `source` 열("5044|5422" 161행 / "5422"만 27행)로 남겨 5044 단독안으로 재산출 가능.
- 생존 편향: **없음**(`survivorship_bias=False`, asof별 PIT). (b) 네이버 WICS 폴백은 **미사용**.

### 2.2 종목군 시계열 (∩ KOSPI200 PIT)
| asof 구간 | 종목군 | n |
|---|---|---|
| 2022-01 ~ 2022-06 | 삼성전자·SK하이닉스·DB하이텍 | 3 |
| 2022-07 ~ 2023-12 | + SK스퀘어(402340; KRX 지수가 반도체로 분류) | 4 |
| 2024-01 ~ 2024-06 | 삼성전자·SK하이닉스·DB하이텍 (SK스퀘어 Top15 제외) | 3 |
| 2024-07 ~ 2026-06 | 삼성전자·SK하이닉스·한미반도체(042700) (DB하이텍 K200 편출) | 3 |
| 2026-07 ~ 2026-08 | + DB하이텍 재편입 | 4 |

역대 종목 5개(000660·000990·005930·042700·402340), 전부 `ohlcv_adj_constituents` 가격 이력 보유(결측 종목 0). 5044 단독이면 2022-01~2023-09 는 삼성전자 없이 2~3종목.

### 2.3 WICS 교차 확인(현재 시점만, 참고)
네이버 업종 `반도체와반도체장비`(no=278, 170종목) ∩ K200(2026-08-03) = 삼성전자·SK하이닉스·DB하이텍·한미반도체·**SK스퀘어·이수페타시스(007660)** = 6. 채택 목록(4)과 SK스퀘어·이수페타시스 2종목 차이. WICS는 시점별 조달 불가(현재 리스트뿐 → 생존 편향)라 채택하지 않음.

## 3. 정의 (사전 등록 — 모듈 상수 = config, 테스트로 일치)

| 항목 | 정의 | 상수 |
|---|---|---|
| 종목군 PIT | 날짜 t 의 종목군 = `asof ≤ t` 최근 월초 스냅샷(`semi_asof` 기록). 첫 asof 이전 → 전부 None | — |
| semi_above20 | 종목군 중 above_20d 유효 종목의 `close > MA20` 비율(breadth 동일 정의), `n_semi` = 유효 종목 수, 0 → None | `MA_SHORT_DAYS=20`(breadth) |
| market_above20 | `breadth.compute_breadth_panel(전 구간).above_20d_ratio` — gold `breadth_panel`과 882일 겹침 **max diff 0.0·결측 불일치 0**(잡이 검사, 불일치 시 exit 4) | — |
| diffusion_spread | `semi_above20 − market_above20` (어느 쪽 None → None) | — |
| semi_diffusion_z | `x_t = spread_t − spread_{t−5}`; `z_t = (x_t − μ)/σ(ddof=1)`, 기준 = **t−1까지 직전 120거래일**의 x, 표본<60 또는 σ=0 → None. **클립 ±3은 family 결합 단계(§3.5)** — 이 모듈은 원 z 기록(breadth_impulse_z와 같은 관례) | `SPREAD_CHANGE_DAYS=5`, `Z_WINDOW_DAYS=120`, `Z_MIN_SAMPLES=60` |
| leader_gap(진단) | `mean(above20 of 005930·000660) − mean(above20 of 종목군 중 리더 제외)`; 리더 유효 0 또는 나머지 0종목 → None | `LEADERS=("005930","000660")` |
| semi_impulse(진단) | `breadth.breadth_impulse(semi_above20)` = mean 최근 5 − mean 이전 15 | breadth `IMPULSE_*` |
| C-2 | `price_adjusted=True` 원천만(비수정 → AssertionError) | — |
| 결측 | None (0 대체 금지). 편출·결측 종목은 그날 분모에서 제외(n_semi로 드러남) | — |

## 4. 실데이터 요약 (jobs/build_semi_diffusion.py, 2026-08-17)

- 행 882 (2023-01-03~2026-08-14), 스냅샷 44, **n_semi 3~4**(중앙값 3). None 비율: 전 컬럼 **0.0**(2022 lookback으로 z 표본 확보 → 2023-01-03부터 유효).
- semi_above20: 평균 0.563, 값은 {0, .25, .333, .5, .667, .75, 1}뿐(3~4종목 → 이산). diffusion_spread: 평균 +0.073, std 0.329, [−0.84, +0.835]; 연도별 평균 2023 +0.129 / 2024 −0.045 / 2025 +0.072 / 2026 +0.173.
- semi_diffusion_z: 평균 −0.002, std 1.039, p05 −1.68 / p50 −0.04 / p95 +1.73, min −4.17(2026-03-26), max +3.57(2025-12-23). |z|>2 5.8%, **|z|>3 0.45%(4일)** — 3종목 구간에서 한 종목 플립(0.333 점프)이 5일 변화를 크게 흔드는 날. 연도별 std 0.98~1.10.
- leader_gap: {−1: 23, −0.5: 111, 0: 471, +0.5: 169, +1: 108}일 — 나머지 종목이 1~2개라 ±0.5 단위.
- semi_impulse: 평균 0.001, std 0.323. corr(semi_impulse, breadth_impulse_z) = 0.48 / **corr(semi_diffusion_z, breadth_impulse_z) = −0.06** (spread 차분이라 시장 공통 성분과 거의 직교 — Participation family 내 중복 낮음).
- 5일 변화의 lag-1 자기상관 0.66(겹치는 창의 당연한 결과, 참고).

## 5. 테스트

`tests/test_semi_diffusion.py` 10건 통과: 상수-config 일치(z 창 = breadth와 동일 §12.4) · 컬럼·spread 항등식·semi_above20 수동 검산 · z 창(첫 z = 첫 5일 변화 + 60일, t−120..t−1 수동 검산) · **룩어헤드**(cut 이후 가격 교란 시 cut 이전 전 컬럼 불변) · PIT 스냅샷(첫 asof 이전 None, 월중 asof, 나머지 종목 없음 → leader_gap None) · leader_gap 수동 검산 · 결측 None(종목 결측 → n_semi 감소·0 대체 없음, 전 결측 → None, market 결측 → spread None) · C-2 비수정 거부·빈 종목군 loud · semi_impulse = breadth 정의 · arrow 스키마 왕복.
전체 pytest: 신규 10건 포함 기존 스위트 전부 통과. (동시 작업 중인 `tests/test_psa.py`·`tests/test_gap3g.py`는 다른 에이전트 파일 — 실행 시점에 따라 1건 실패가 관측됨, 본 작업과 무관.)

## 6. 발주자 확인 사항

1. **소스 채택(5044 ∪ 5422)** — 지시의 "KOSPI 반도체" 업종지수는 없고, `KRX 반도체(5044)`는 2023-09까지 삼성전자 미편입. 삼성전자 전 구간 포함을 위해 `KRX 반도체 Top 15(5422)`와 합집합. 5044 단독(삼성전자 2023-01~09 제외, n 2~3)으로 되돌리려면 config `index_codes: ["5044"]` 후 재실행(silver `source` 열로 구분 가능). 승인 요망.
2. **종목군 크기 3~4** — KOSPI200 안의 반도체 종목이 원래 적어 semi_above20이 1/3·1/4 단위 이산값이고 |z|>3이 4일 발생. 정의(KOSPI200 구성 중)에 따른 결과이며 스펙 범위 밖 확장(KOSDAQ 반도체 포함 등)은 하지 않음. family 결합 시 클립 ±3으로 흡수되나, 이 축의 해상도 한계를 사전 등록에 남길지 판단 요망.
3. **SK스퀘어(402340) 포함(2022-07~2023-12)** — KRX 지수가 반도체로 분류한 지주사. 제외하려면 데이터(silver) 수정이 아니라 조달 규칙(예: 제외 목록)을 config에 등재해야 함 — 현재는 지수 분류 그대로.
4. **WICS 기준 문구** — 스펙 "KRX 업종 반도체·반도체장비(WICS 기준)"의 두 기준이 실제로 다름(현재 WICS ∩ K200 = 6, KRX 지수 ∩ K200 = 4; 차이 SK스퀘어·이수페타시스). PIT 가능한 KRX 지수 PDF를 채택. WICS로 바꾸면 현재 리스트 소급 = 생존 편향(true 명시) 필요.
5. **z 클립 위치** — 원 z 기록, ±3 클립은 family 결합에서(breadth_impulse_z와 동일). 확인만.
