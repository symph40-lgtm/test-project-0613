# MT-PRO T3-C — 소급 트랙 등급C 부품 0~2 (전일밤 ^SOX → 일봉 반응 ERR) 구현·실측 보고

- 작성: 2026-08-17 (월) · 실행 19:3x KST · 발주: WORKORDER_MTPRO_v10.1 §2.1 "부품 0~2 등급C 모드: 방향만 아는 이벤트 + 일봉 반응, Expected Reaction 일봉 기준, ERR 일봉 종가 기준, Implicit only" + T1-3 "소급 구간 부품 0~2 = 등급C(전일밤 ^SOX 부호·크기)".
- 원칙: 결측 None(0 대체 금지) · 룩어헤드 hard assert(테스트) · A-1 `expected_std_rolling`·A-4 `asymmetry`는 `core/errata.py` **재사용**(재구현 없음) · 인용 수치는 전부 아래 실행 결과.
- 커밋 안 함. config/core/events/kis/krx 파일 수정 없음.

## 1. 산출물

| 파일 | 내용 |
|---|---|
| `src/mtpro/ingest/sox.py` | ^SOX 일봉 적재 (yfinance `^SOX`, 2022-12-01~, auto_adjust) → `data/bronze/sox_daily.parquet`(date·close·ret_pct·source·fetch_ts). 실패(예외·빈 응답·행 수 <200·기존 대비 10%+ 급감)는 `alerts.loud_failure("COLLECT_FAIL")` 후 `SoxIngestError` |
| `src/mtpro/components/gradec.py` | 정렬 `align_prev_us_session` · 반응 `reactions_from_ohlcv` · 패널 `build_panel`/`build_scope_panel` · `write_gold`/`read_gold` · `summarize` · 사전 등록 상수 `GradeCParams`(`load_params`가 config grade_c 블록 3개를 읽음) |
| `jobs/build_gradec.py` | SOX 재적재(`--no-fetch` 가능) → `bronze/ohlcv_adj.parquet` 대기(`--wait-minutes`, 없으면 exit 3 loud) → `data/gold/gradec_panel.parquet` + 요약 JSON(`--summary-json`). `--basis open_to_close|close_to_close` |
| `tests/test_gradec.py` | 18개 (정렬 5·반응/C-2 1·룩어헤드 2·재료없는날 1·β 2·표본부족 None 1·expected_std 과거만 1·스키마/0대체없음 1·요약 1·config 1·SOX 정규화/loud-failure 2) |
| `data/gold/gradec_panel.parquet` | 2,646행 = 3 scope × 882 국내 거래일(2023-01-03~2026-08-14). 열: date, scope, sox_session_date, sox_align_status, sox_ret_prev, beta_sox_raw, beta_sox, justified_pct, expected_std, actual_ret, err_pct, err_z, no_material_flag, good_acceptance_z, bad_resilience_z, good_n, bad_n, good_beta, bad_beta, grade="C", t0_mode="A1_open", reaction_basis, engine_ver="gradec-0.1" |
| `logs/gradec_summary.json` | 아래 §4 수치 원본 |

pytest: `.venv\Scripts\python -m pytest tests -q` → **전체 통과** (본 태스크 18 포함; 수치는 §6).

## 2. SOX 정렬 규칙 (부품 0 등급C, 룩어헤드 금지)

미국 세션 d(NY 달력)는 16:00 ET = **익일(d+1) 05:00/06:00 KST** 종료. 국내 t일 09:00 KST 이전에 끝난 세션 = **d ≤ t−1 (달력 날짜, 엄격 부등호)**. d = t(t일 밤 미국장)는 t+1 새벽에 끝나므로 t일 값에 섞이면 룩어헤드 위반 → `pd.merge_asof(..., allow_exact_matches=False, direction="backward")`로 구조적으로 배제.

| status | 조건 | sox_ret_prev |
|---|---|---|
| `ok` | 최신 세션 d<t, 직전 국내 거래일이 쓰지 않은 새 세션 | ret(d) |
| `reused` | 미국 휴장 등으로 직전 국내 거래일과 **같은 세션** (예: 미국 7/4 휴장 → 국내 7/5는 7/3 세션 재사용) | **None** — 같은 재료를 두 국내 거래일에 중복 사용하지 않음(설계 결정, 발주자 확인 ③) |
| `stale` | (t − d) > 7일 (데이터 결손 의심) | None |
| `missing` | 세션 없음/ret None | None |

- 월요일 → 금요일 세션. KRX 휴장(미국 개장)으로 건너뛴 세션은 측정하지 않는다(사양 "가장 최근 세션" 하나만; 누적 아님).
- 실측: 3 scope 모두 882일 중 `ok` 853 · `reused` 29 · stale/missing 0. reused 예: 2023-01-03(미국 1/2 휴장), 2023-01-17(MLK), 2023-02-21, 2023-04-10(Good Friday), 2023-06-20, 2023-07-05, 2023-09-05, 2023-11-24 …
- 테스트: t 이후(t 포함) 미국 세션 값을 +5 해도 t행 불변·t+1부터만 반영 / 미래 OHLCV 변경 → 과거 행 불변 / t의 반응을 +30% 바꿔도 t의 expected_std 불변(과거 잔차만).

## 3. 계산 규칙 (사전 등록 상수 — `GradeCParams`)

- **반응 기준(reaction_basis)**: 기본 `open_to_close` = (종가/시가−1)% — A-1·불변 규칙 5(t0=09:00 시가, 갭 제외, t5=종가). 비교용 `close_to_close`(전일 종가→종가, 갭 포함). 발주자 확인 ①.
- **β_SOX**: 과거 60 국내 거래일(t 미포함) 롤링 OLS(절편 포함) 기울기, 유효 표본 <40 → None, 절단 [0.3, 3.0] (config `grade_c.beta_window_days`). `beta_sox_raw`(절단 전)도 저장.
- **정당화 반응** justified_pct = clip(β)·sox_ret_prev. |justified| < 0.3%(config `min_justified_abs_pct`) → `no_material_flag=True` → ERR None(제외).
- **expected_std** = `errata.expected_std_rolling({"GRADEC_SOX": 과거 재료일 err_pct}, "GRADEC_SOX", window=120(config `err_z_window_days`), floor=0.1%, min_samples=20)`.
- **ERR**: err_pct = actual − justified, err_z = err_pct / expected_std. good = sox_ret_prev>0, bad = <0.
- **비대칭** = `errata.asymmetry(최근 20 국내 거래일(t 포함) good err_z, bad err_z, min_n=2, halflife=15)` → 부족 시 None(+good_n/bad_n).
- **good/bad beta**: 같은 20일 창, actual ≈ β·justified(원점 통과 OLS), 절단 [0.3, 2.0], 표본 <3 → None.
- 패널 행 가용 시점 = t일 종가 이후.

## 4. 실데이터 요약 (`logs/gradec_summary.json`, 2023-01-03~2026-08-14, 882 국내 거래일/scope)

### 4.1 기본 기준 open_to_close (gold 파일에 저장된 것)

| scope | 행 | 정렬 ok/reused | β 정의 | justified 정의 | 재료 없는 날(비율/정의일) | err_z 정의 | \|err_z\|<5 | std(err_z) [0.7,1.3] | good/bad 도달(≥2) | good/bad beta 정의 | β 절단 비율 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| KOSPI200 | 882 | 853/29 | 859 | 832 | 341 (41.0%) | 471 | 99.8% | 1.198 ✓ | 92.3% / 88.6% | 93.8% / 81.8% | **100%** |
| 005930 | 882 | 853/29 | 859 | 832 | 341 (41.0%) | 471 | 100% | 1.188 ✓ | 92.3% / 88.6% | 93.8% / 81.8% | **100%** |
| 000660 | 882 | 853/29 | 859 | 832 | 341 (41.0%) | 471 | 100% | 1.119 ✓ | 92.3% / 88.6% | 93.8% / 81.8% | **97.3%** |

None 비율(scope 공통): sox_ret_prev 3.3% · beta_sox 2.6% · justified 5.7% · expected_std 5.8% · err_pct 44.3% · err_z 46.6% · good_acceptance_z 7.7% · bad_resilience_z 11.5% · good_beta 6.2% · bad_beta 18.3%.

**핵심 발견**: open→close 기준에서는 β_SOX 원값이 3 scope 모두 **≈0**(중앙값 KOSPI200 +0.003 · 005930 −0.022 · 000660 −0.079; 전일밤 SOX와 당일 시가→종가 상관 +0.09/−0.08/−0.07). 절단 하한 0.3에 사실상 매일 걸려 **justified = 0.3 × SOX** 로 퇴화 → 세 scope의 재료 없는 날 수(341)·err 정의 수가 동일. 즉 A-1대로 갭을 제외하면 "전일밤 SOX"라는 재료는 **시가 갭에서 이미 소화**되고 장중 반응과는 거의 무관하다는 것이 실측 결과다(σ(err_z)≈1.2로 캘리브레이션 자체는 통과하나, 기대값이 상수배 SOX여서 정보성은 갭 제외 반응 자체의 분산뿐).

### 4.2 비교 기준 close_to_close (파일 저장 안 함, `--basis close_to_close`로 재현)

| scope | 재료 없는 날 | err_z 정의 | \|err_z\|<5 | std(err_z) | good/bad 도달 | good/bad beta 정의 | β 절단 비율 | β_raw 중앙값 | 상관(SOX, 반응) |
|---|---|---|---|---|---|---|---|---|---|
| KOSPI200 | 310 (37.3%) | 502 | 99.6% | 1.237 ✓ | 92.3% / 89.2% | 93.8% / 85.2% | 63.1% | 0.259 | +0.41 |
| 005930 | 303 (36.4%) | 509 | 99.8% | 1.244 ✓ | 92.6% / 89.2% | 93.8% / 85.9% | 45.4% | 0.312 | +0.35 |
| 000660 | 205 (24.6%) | 607 | 100% | 1.131 ✓ | 92.6% / 93.1% | 93.8% / 94.6% | 5.7% | 0.591 | +0.43 |

close→close(갭 포함)에서는 β가 경제적으로 의미 있는 값(000660 0.59, 005930 0.31, KOSPI200 0.26)이고 상관 0.35~0.43. 다만 이는 불변 규칙 5(갭 제외)와 충돌 — 발주자 결정 사항.

## 5. 발주자 확인 사항

1. **반응 기준 결정 (핵심)**: 등급C의 "일봉 반응"을 ① `open_to_close`(A-1·규칙 5 준수, 그러나 β≈0 → 사실상 0.3×SOX 상수 모델) 로 둘지, ② `close_to_close`(갭 포함, β 유의미, 규칙 5 예외를 amendment로 등재) 로 둘지, ③ 절단 하한 0.3 을 등급C에선 폐지/0 허용할지. 현재 gold는 ①. 코드 변경 없이 `--basis`로 전환 가능. 결정 전엔 Energy-Lite의 `gradec_err` 입력이 ①의 값임을 유의.
2. **β 절단 [0.3, 3.0]의 의미**: 원값이 음수/0이어도 0.3으로 올려 정당화 반응 부호를 SOX와 강제 일치시킨다(발주 지시 그대로). ①에서는 이 규칙이 결과를 지배한다.
3. **reused → None 규칙**(미국 휴장 다음 국내 거래일, 29일/3.3%): "가장 최근 세션" 문언대로면 값이 있어야 하나 직전 거래일과 동일 재료의 중복 사용이라 None 처리했다. 대안: 그대로 사용(중복) 또는 다중 세션 누적. 승인 요청.
4. **모듈 보조 상수(config 밖, 사전 등록 요청)**: beta_min_samples 40 · expected_std floor 0.1%·min_samples 20 · asym window 20·min_n 2·halflife 15 · good/bad beta min_n 3·절단 [0.3, 2.0] · stale 7일. config/mtpro.yaml은 수정 금지 지시라 `GradeCParams`에 등재했다. 승인되면 config `grade_c` 블록으로 옮기는 것을 권고(별도 태스크).
5. 등급C 재료가 3 scope에 **동일**(SOX 하나)이므로 scope 간 차이는 β·반응뿐. KOSPI200은 SOX 민감도가 가장 낮다(c2c β 0.26).
6. Energy-Lite(gradec_err 컴포넌트) 연결 시 사용할 열은 `err_z`(재료 없는 날 None), 비대칭은 `good_acceptance_z`/`bad_resilience_z`(A-4 None) — shadow 인터페이스(AM-5 ④) 열 이름 그대로.

## 6. 실행 기록

```
.venv\Scripts\python -m mtpro.ingest.sox           # sox_daily rows=928 2022-12-01..2026-08-14 (첫 시도는 fetch_ts µs→s 캐스팅 실패로 COLLECT_FAIL 1건 기록 후 수정·재실행)
.venv\Scripts\python jobs\build_gradec.py --no-fetch --wait-minutes 1 --summary-json logs\gradec_summary.json
# ohlcv_adj rows=3387 codes=['000660','005930','KOSPI200'] → gold/gradec_panel.parquet rows=2646
.venv\Scripts\python -m pytest tests -q            # 172 passed (T3-A·T3-B 테스트 포함, 본 태스크 18)
```
