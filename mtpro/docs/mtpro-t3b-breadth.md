# T3-B — 부품 5 Breadth 구현 보고 (2026-08-17)

발주서 WORKORDER_MTPRO_v10.1 §2.1 소급 트랙 부품 5 · T1-2 승인 제안 · config `breadth` 블록 · 부록 C-2. 범위는 **부품 5만**(다른 부품·bronze 적재·config·ingest 코드는 손대지 않음).

## 1. 산출물

| 종류 | 경로 |
|---|---|
| 부품 코드 | `src/mtpro/components/breadth.py` |
| 테스트 | `tests/test_breadth.py` (21건, 합성 데이터) |
| 빌드 잡 | `jobs/build_breadth.py` (`--wait-minutes N`: bronze 대기, `--start`, `--summary-json`) |
| silver | `data/silver/constituents_monthly.parquet` — `schema.SILVER_CONSTITUENTS_MONTHLY` (month, asof, code, mcap_rank, tier) |
| gold | `data/gold/breadth_panel.parquet` — `breadth.GOLD_BREADTH_PANEL` (date, constituents_asof, n_available, above_20d_ratio, above_60d_ratio, new_high_252, new_low_252, adv_ratio, large_above20, mid_above20, small_above20, leadership, breadth_impulse, breadth_impulse_z, engine_ver) |

입력(읽기 전용, T3-A 적재): `bronze/constituents.parquet`(월초 PIT), `bronze/market_cap.parquet`(월초 시총 단면, price_adjusted=False), `bronze/ohlcv_adj_constituents.parquet`(구성종목 수정주가, price_adjusted=True), 달력은 `bronze/ohlcv_adj.parquet`의 code `KOSPI200`(=지수 1028) 일자(없으면 종목 일자 합집합).

## 2. 정의 (사전 등록 — 모듈 상수, 측정 후 변경 금지)

| 항목 | 정의 | 상수 |
|---|---|---|
| 월별 PIT | 날짜 d 의 구성 리스트 = `asof ≤ d` 인 가장 최근 월초 스냅샷 → `constituents_asof` 기록. 첫 스냅샷 이전 날짜는 전부 None | — |
| 시총 분위 | 그 asof 시총 단면(비수정)에서 **구성종목 내** 시총 내림차순 순위(동률은 code 순) 1~50 large / 51~150 mid / 151~200 small. 단면에 없는 종목은 rank·tier None(나머지는 시총 보유 종목끼리 1..N) | `DEFAULT_TIERS` = config `breadth.tiers` (테스트로 일치 검증) |
| above_20d / 60d | 종목별 `close > MA(20/60)`, MA는 창 전부 유효할 때만(min_periods=창). 비율 = 유효 플래그 보유 구성종목의 평균 | `MA_SHORT_DAYS=20`, `MA_LONG_DAYS=60` |
| new_high_252 / new_low_252 | 종목별 `close ≥ rolling max(252, 당일 포함)` / `≤ rolling min`, 252일 전부 유효할 때만. 값 = 유효 종목 중 해당 개수(count) | `HIGH_LOW_WINDOW_DAYS=252` |
| adv_ratio | 전일 대비 상승 종목 수 / 전일·당일 종가 모두 유효한 종목 수 (보합은 분모에만) — 등락종목수 이력 대체 | — |
| n_available | 그날 구성종목 중 유효 종가 보유 종목 수(가용 분모). 편출·상장폐지·가격 이력 없는 종목은 자동 제외 | — |
| tier above20 | tier 별 above_20d 비율(유효 종목 평균) | — |
| leadership | large>0.4 & mid<0.25 → `large_cap_only` / large>0.3 & mid>0.3 → `broad` / else `mixed`; large·mid 결측 → None | `LEADERSHIP_LARGE_ONLY={large_gt:.40, mid_lt:.25}`, `LEADERSHIP_BROAD={large_gt:.30, mid_gt:.30}` |
| breadth_impulse | mean(above_20d 최근 5일) − mean(이전 15일); 20일 중 하나라도 결측이면 None | `IMPULSE_RECENT_DAYS=5`, `IMPULSE_PRIOR_DAYS=15` |
| breadth_impulse_z | (impulse − μ)/σ(ddof=1), 기준 분포 = **당일 제외** 직전 120 거래일 impulse; 유효 표본 < 60 또는 σ=0 → None | `IMPULSE_Z_WINDOW_DAYS=120`, `IMPULSE_Z_MIN_SAMPLES=60` |
| C-2 | ohlcv 의 `price_adjusted` 가 True 단일값이 아니면(비수정·혼용) `assert_same_adjustment` + AssertionError. 시총 단면에 True 가 섞이면 AssertionError. 시총은 순위 산출에만 쓰고 가격 식에 넣지 않음 | — |
| 산출 구간 | 내부 계산은 스냅샷 존재 전 구간(2022-01-03~ lookback)에서 수행 → 2023-01-03 부터 출력. 따라서 impulse·z 는 출력 시작일부터 2022 이력을 기준으로 유효 | `OUTPUT_START=2023-01-03` |
| 결측 | 전부 None(parquet null). 0 대체 없음. 유효 종목 0 인 날의 비율·count 는 None(n_available=0 은 실제 계수) | — |

주의(정직 기록): above_60d·new_high/low 의 실제 분모는 위 `n_available` 보다 작을 수 있다(신규 상장 종목은 60일/252일 이력이 찰 때까지 그 지표만 결측). 패널에는 요구 컬럼만 두었고, 분모 차이는 아래 실데이터 요약의 None 비율로 드러난다.

## 3. 룩어헤드 테스트 (tests/test_breadth.py)

- `test_lookahead_future_price_change_does_not_alter_past`: 합성 12종목×420일. 기준 패널 산출 후 (a) cutoff 이후 가격을 ×3 → cutoff 이전 행 전부 `assert_frame_equal` 동일(미래 행의 new_high 는 실제로 달라졌음을 함께 확인), (b) cutoff 이후 행·스냅샷 삭제 → 이전 행 동일.
- `test_lookahead_future_constituent_change_does_not_alter_past`: 미래 스냅샷에서 종목 절반 편출 → 과거 행 불변, 미래 n_available=6.
- `test_impulse_z_uses_only_past_window`: z_t 가 t 제외 직전 120개로 계산됨을 수치로 검산, 표본<60 None, 미래 impulse 변경 시 과거 z 불변.
- 그 외: 결측이 분모를 줄이지 0 으로 채우지 않음(수기 계산과 일치), 전 종목 결측일 → 전부 None + 그 날을 포함하는 impulse 창 None, 창이 찰 때까지 None(20/60/252/impulse 38/z 98), 편출 종목은 가격이 있어도 제외, `constituents_asof` = 스냅샷 날짜, new_high/low·adv_ratio 정의 검산, impulse 공식, leadership 규칙·경계, tier 비율, C-2 거부(비수정·혼용·수정 시총), config tiers = 모듈 상수, arrow 저장 시 null, 빌드 잡 엔드투엔드(합성 bronze→silver·gold, 대기 타임아웃 exit 3).

## 4. 실데이터 스모크 (2026-08-17 19:22, `jobs/build_breadth.py --wait-minutes 45`, bronze 는 T3-A 적재분 그대로)

입력 실측: constituents 11,203행·56 스냅샷(2022-01-03~2026-08-03, 월 200종목·**2024-10~12 는 201**)·PIT 합집합 252종목 / market_cap 53,253행 / ohlcv_adj_constituents 275,223행·252종목·2022-01-03~2026-08-14(price_adjusted=True 단일) / 달력 = ohlcv_adj `KOSPI200` 일자.

| 항목 | 값 |
|---|---|
| gold 행 수·구간 | **882행, 2023-01-03 ~ 2026-08-14** (스냅샷 44개 사용) |
| silver | 11,203행 · 56개월 · tier None 3행(아래 §5-2) |
| n_available | min 200 · median 200 · max 201 → **구성 월 안에서 가격 결측 종목 0** (PIT 합집합 252종목 전부 가격 행 보유, `members_without_any_price_rows=0`) |
| None 비율 | above_20d/60d·adv_ratio·tier·leadership·impulse·impulse_z **0%** / new_high_252·new_low_252 **0.45%(4일: 2023-01-03~06)** — 2022년 거래일 246 + 4 = 250 < 252 라 252창이 2023-01-09 에 처음 참(첫 유효일 2023-01-09). impulse·z 는 2022 lookback 덕에 2023-01-03 부터 유효 |
| 실제 분모(진단, 패널 컬럼 아님) | above_20d 유효 199~201(n_available 미달일 31일) · above_60d 199~201(141일) · 252창 유효 0~200(median 199, 미달일 627일 — 신규 상장 종목 1~2개가 252일 이력 미충족) |
| leadership 분포 | broad 661 · mixed 215 · large_cap_only 6 (2025: 3, 2026: 3 — 2025-08-22, 10-01, 10-10, 2026-06-01, 06-02, 06-05) |
| new_high_252 | max **52 (2026-02-20)** · 평균 7.2 |
| new_low_252 | max 62 (2024-12-09) · 평균 4.9 |
| above_20d_ratio | mean .490 · min .025 · max .935 |
| breadth_impulse | mean .002 · std .203 · [−.64, .62] |
| breadth_impulse_z | mean .016 · std 1.05 · [−3.27, 3.81] · |z|>3 인 날 11 |
| 마지막 행 2026-08-14 | above_20d .87 · above_60d .495 · nh 5 · nl 0 · adv .76 · large .88/mid .82/small .96 · broad · impulse .397 · z 1.63 |

전체 요약 JSON은 잡 stdout(`--summary-json`)에 그대로 남는다. 전체 pytest: **172 passed**(19:30 시점, T3-A 가 병행 추가 중이라 총수는 변동; 이 중 breadth 21).

## 5. 발주자 확인 사항

1. **상장폐지·편출 결측 규모 = 0.** 소급 구간에서 구성 월 중 가격이 끊긴 종목이 없어 n_available 이 항상 200(201) 이다. T1-2 의 [추정] "편출 후 상폐 종목 가격 미반환"은 이번 적재분에서 발생하지 않았다(PIT 합집합 252종목 전부 가격 행 보유). 다만 위탁 규칙(결측 → None·분모 축소)은 코드·테스트로 유지.
2. **KRX PDF 가 201종목을 돌려준 달(2024-10·11·12)** — 시총 순위 201 인 종목(2024-10 `008730`, 2024-11·12 `178920`)은 tiers(1~200) 밖이라 tier None → 그 달 tier 비율에서만 제외, 전체 비율·n_available 에는 포함(201). 사전 등록 tiers 를 "151~끝"으로 볼지, 201 은 결측으로 둘지 결정 요청(현행: None 유지, 결측 0 대체 금지 원칙 쪽으로 해석).
3. new_high/low 의 252 창은 **당일 포함 252 거래일 전부 유효** 조건이라 2023-01-03~06 4일과 신규 상장 종목(일별 1~2개)이 결측이다. count 라 분모 축소가 값에 직접 드러나지 않음 — Gate R1 에서 count 를 쓸 때 참고(비율이 필요하면 amendment 로 컬럼 추가).
4. impulse_z 의 기준 분포를 **당일 제외** 직전 120일로 등록했다(AM-2 의 "최근 창 이전" 취지와 정합). 당일 포함으로 바꾸려면 amendment.
5. adv_ratio 정의(상승 종목 / 전일·당일 종가 유효 종목, 보합은 분모에만)를 등락종목수 대체로 등록했다 — 다른 정의(상승/하락 배율 등)를 원하면 amendment.
6. `GOLD_BREADTH_PANEL` 스키마는 `schema.py` 충돌을 피하려 `components/breadth.py` 에 두었다(T3-A 와 동시 편집 방지). 통합 시점에 `schema.py` 로 이동 권고.
7. 커밋하지 않았다(지시). 산출 parquet 은 `data/`(git 제외)에만 존재.
