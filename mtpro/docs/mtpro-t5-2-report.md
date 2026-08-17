# MT-PRO T5-2 — 미국 4자산 일봉 적재 + 부품 3G(일봉) + 부품 10 Semi Transmission 구현·실측 보고

- 작성: 2026-08-17 (월) · 스펙 = `docs/mtpro-t5-plan.md` §1(3G)·§3.2·§3.4+§12.3(Transmission 방법 A)·§12.4(z 창 = t−1까지 120일·표본<60 None)·§7 스키마 — 승인된 사전 등록, 임의 변경 없음. 애매한 곳은 **가장 엄격한 해석**을 택하고 §5 "해석 기록"에 남겼다.
- 원칙: 결측 None(0 대체 금지) · 룩어헤드 hard assert(테스트) · SOX/US 세션 정렬 = `components/gradec.align_prev_us_session` **재사용**(d ≤ t−1 엄격, reused → None) · 인용 수치는 전부 아래 실행 결과(`logs/gap3g_summary.json`, `logs/transmission_summary.json`).
- **A-1R 계열**: 3G·Transmission 은 마감 후 상태 산출용(갭·close→close 사용). 소급 Gate R1 `gold/gradec_panel.parquet`(A-1 open→close)·`ingest/sox.py`·`components/gradec.py` 는 **수정하지 않았다**(결과 소급 변경 없음). 커밋 안 함. `components/psa.py`·breadth diffusion·`events/` 미접촉. config 는 `us_assets`·`gap3g`·`transmission` 3블록만 추가.

## 1. 산출물

| 파일 | 내용 |
|---|---|
| `src/mtpro/ingest/us_daily.py` | yfinance `SOXX·NVDA·MU·TSM` 일봉(auto_adjust) 2022-06-01~ → `data/bronze/us_daily.parquet`(롱 포맷: date·ticker·close·ret_pct·source·fetch_ts). 실패(예외·빈 응답·자산별 행<200·기존 대비 10%+ 급감·비양수 종가)는 `alerts.loud_failure("COLLECT_FAIL")` 후 `UsDailyIngestError`, **4자산 전부 성공해야 쓴다**(부분 적재 없음). ^SOX(`sox_daily`)는 그대로 |
| `src/mtpro/components/rolling.py` | 공용 과거 전용 롤링 통계(`past_z`·`past_std`·`past_window`·`clip`) — §12.4 통일 규정(t−1까지 window 행, 유효 표본<min None, 클립 ±3) 한 곳에 구현 |
| `src/mtpro/components/gap3g.py` | 부품 3G: `scope_ohlcv`(C-2 assert) · `build_scope_panel`/`build_panel` · `write_gold`/`read_gold` · `summarize` · 사전 등록 상수 `Gap3GParams`(`load_params`가 config `gap3g.constants` 읽음) → `data/gold/gap3g_panel.parquet` |
| `src/mtpro/components/transmission.py` | 부품 10 방법 A: `align_assets`(자산별 등급C 정렬기 재사용) · `ols_multi` · `build_scope_panel`/`build_panel` · `write_gold`/`read_gold` · `summarize` · `TransmissionParams` · `DESIGN_COLUMNS = (z_soxx, resid_nvda, resid_mu, resid_tsm)` 고정 → `data/gold/transmission_panel.parquet` |
| `jobs/build_gap3g.py` | ^SOX 재적재(`--no-fetch`) → `bronze/ohlcv_adj` 대기(`--wait-minutes`, 초과 exit 3 loud) → gold + 요약 JSON(`--summary-json`) |
| `jobs/build_transmission.py` | 4자산 재적재(`--no-fetch`) → `bronze/ohlcv_adj` 대기 → gold + 요약 JSON. 자산 누락 시 `PROCURE_FAIL` exit 2 |
| `tests/test_gap3g.py` | 12개 — 정의(gap_hold 임계·클립·부호, CLV·high=low None, C-2·t0_mode 불변) · z 표본<60 None·과거 전용·수동 대조·클립 · β_gap 회복·<40 None·t 미포함(β·σ) · 재료 규칙·err_z=err/σ·σ<60 None·floor·캘리브레이션 · reused → expected_gap None · 룩어헤드 2(미래 OHLCV / d ≥ t SOX 변조) · 상수=config(+grade_c 동일 상수) · 스키마 roundtrip/0 대체 없음 · gradec_panel 분리 |
| `tests/test_transmission.py` | 12개 — **설계행렬 = [z_SOXX, resid×3] 수동 재계산 일치 + raw 4변수 동시 OLS 의 SOXX 계수와 다름(>0.05)** · 직교화 b_j 수동 대조 · 참 계수 부호/상대 크기 회복 · 비대칭 β_up−β_down 회복·표본<25 None · 표본 규칙(z<60, orth<60, β<40, asym z/change20 z <60)·클립·change20 z 수동 대조 · z/b_j 는 t 미포함 · 자산별 reused → None(세션 = t−1) · 룩어헤드 2(d ≥ t US 변조 / 미래 OHLCV) · 상수=config·role · 스키마 roundtrip · us_daily 정규화(MultiIndex·tz·ret)·부분 실패 loud + 파일 미기록 |
| `config/mtpro.yaml` | `us_assets` / `gap3g` / `transmission` 블록 추가(사전 등록값 = 모듈 dataclass, 일치 테스트) |
| `data/bronze/us_daily.parquet` | 4 × 1,056행 (2022-06-01 ~ 2026-08-17, ticker 별) |
| `data/gold/gap3g_panel.parquet` | 2,646행 = 3 scope × 882 국내 거래일 (2023-01-03 ~ 2026-08-14) |
| `data/gold/transmission_panel.parquet` | 2,646행 = 3 scope × 882 (005930·000660 role=component, KOSPI200 role=diagnostic) |
| `logs/gap3g_summary.json`, `logs/transmission_summary.json` | 아래 §3·§4 수치 원본 |

pytest: `.venv\Scripts\python -m pytest tests -q` → **291 passed** (기존 239 + 본 태스크 24 + 동시 진행 중인 다른 에이전트 테스트 28). 본 태스크 24개는 단독 실행도 통과.

## 2. 구현 규칙 (사전 등록 상수 = config = dataclass)

### 2.1 부품 3G (`Gap3GParams`, config `gap3g.constants`)
- `gap_pct = (open_t/close_{t−1} − 1)·100`. `close_ret_pct`(close→close, 참고) 병기.
- `gap_hold = (close_t − close_{t−1})/(open_t − close_{t−1})`, **|gap| < 0.3% → None**, 클립 **[−1, 2]**. `gap_hold_signed = gap_hold × sign(gap)` → `gap_hold_z`.
- `close_acceptance = (close−low)/(high−low)` (high=low → None) → `close_acceptance_z`.
- z: 스코프별 **t−1까지 120 국내 거래일**, 유효 표본<60 None, **클립 ±3**.
- Gap Reaction ERR(등급C 재료 = 전일밤 ^SOX, 정렬 = gradec 정렬기 재사용): `β_gap` = 과거 60행(t 미포함) OLS(절편 포함) 기울기 gap_pct ~ sox_ret_prev, 표본<40 None, 클립 [0.3, 3.0](`beta_gap_raw` 병기) → `expected_gap = β_gap × sox_ret_prev`, |expected_gap| < 0.3% → `no_material_flag=True` → ERR None → `σ_gap` = 과거 120행(t−1까지) 재료일 잔차 rolling std(`core.errata.expected_std_rolling` 재사용, floor 0.1%, 표본<60 None) → `gap_reaction_err = gap − expected_gap`, `gap_reaction_err_z = err/σ_gap`.
- `expected_gap_source ∈ {gradeC, gradeA}`: 여기서는 전부 gradeC(정의 시) — **등급A 값은 T5-6이 채우는 인터페이스 컬럼**. `grade="C"`, `t0_mode="A1_open"`(C-3 불변), `time_axis="A-1R"`, `price_adjusted=True`.
- 그 외 상수: β·정렬 상수는 grade_c 와 동일(60/40/[0.3,3.0]/stale 7) — 테스트로 동일성 고정.

### 2.2 부품 10 Transmission (`TransmissionParams`, config `transmission.constants`) — §12.3 방법 A 그대로
- 정렬: 자산 j 마다 `align_prev_us_session`(d ≤ t−1 엄격, reused/stale/missing → None) → `x_j`. `z_j` = x_j 의 z(t−1까지 120행, 표본<60 None, 클립 ±3).
- 1단계 직교화: j ∈ {NVDA, MU, TSM}: `resid_j = z_j − b_j·z_SOXX`, `b_j` = 과거 120행(t 미포함) OLS(절편 포함) 기울기, 표본<60 None.
- 2단계: 종목별 독립 **하나의 다변량 OLS**(절편 포함) `r_i(close→close) ~ [z_SOXX, resid_NVDA, resid_MU, resid_TSM]`, 창 [t−59, t] 완전 관측만, 표본<40 None → `beta_soxx, beta_resid_{nvda,mu,tsm}`, `beta_n`. raw 4변수 동시 투입 없음(설계행렬 상수 `DESIGN_COLUMNS` + 테스트).
- 비대칭: 같은 60행 창에서 z_SOXX>0 행만(표본≥25) / <0 행만(≥25) 각각 같은 다변량 OLS 의 SOXX 계수 = `beta_up`/`beta_down`(`n_up`/`n_down` 병기) → `transmission_asym = β_up − β_down` → `transmission_asym_z`(t−1까지 120행, <60 None, ±3).
- change20: `Δβ(t) = β(t) − β(t−20행)` → 자기 과거 120행(t−1까지) Δβ 분포의 z(<60 None, ±3) → `beta_change20_z_{soxx,nvda,mu,tsm}`.
- 005930·000660 = role component(Reaction family 입력), KOSPI200 = role diagnostic. TR-B(.4/.2/.2/.2 combiner)는 challenger 등록만(미구현).

## 3. 실데이터 요약 — 3G (`logs/gap3g_summary.json`, 2023-01-03 ~ 2026-08-14, 882행/scope, SOX 정렬 ok 853 · reused 29)

| scope | \|gap\|≥0.3% 비율 | gap_hold 정의(n) | gap_hold p05/p25/p50/p75/p95 | 반전(<0) / 유지·확장(≥1) / 클립 걸림 | gap_hold_signed 평균(std) | gap_hold_z std | CLV 평균 | CLV_z std |
|---|---|---|---|---|---|---|---|---|
| KOSPI200 | 71.7% | 632 | −1.00 / 0.35 / 1.02 / 1.77 / 2.00 | 17.2% / 50.9% / 28.6% | +0.25 (1.28) | 1.02 | 0.525 | 1.00 |
| 005930 | 78.3% | 691 | −1.00 / 0.00 / 0.93 / 1.76 / 2.00 | 21.6% / 48.6% / 34.2% | +0.08 (1.28) | 1.01 | 0.481 | 1.00 |
| 000660 | 83.0% | 732 | −1.00 / 0.00 / 0.87 / 1.75 / 2.00 | 24.0% / 46.7% / 32.5% | +0.11 (1.27) | 1.01 | 0.504 | 1.01 |

- gap_pct 분포: KOSPI200 std 1.29%(min −6.17 · max +7.00), 005930 std 2.10%(−10.94 · +24.15), 000660 std 2.87%(−10.86 · +28.37) — 극값은 2026-03~07 실제 일봉(bronze 그대로).
- **gap_hold 의 1/3 안팎이 클립 [−1, 2]에 걸린다**(양쪽 합). 사전 등록 클립이라 그대로 두었다.
- None 비율: gap_hold(=signed=z) 28.3 / 21.7 / 17.0% (전부 |gap|<0.3% 규칙; **z 표본 규칙으로 추가 None 은 0** — 120행 창에 항상 ≥60 표본). CLV·CLV_z None 0%.

Gap Reaction ERR(등급C, 갭 기준 β 재추정):

| scope | β_gap 정의 | β_gap_raw p05/p50/p95 | 절단 걸림 비율 | expected_gap 정의 | 재료 없는 날(비율/정의) | σ_gap None 비율 | err_z 정의 | std(err_z) [0.7,1.3] | \|err_z\|<5 |
|---|---|---|---|---|---|---|---|---|---|
| KOSPI200 | 859 | 0.14 / 0.24 / 0.70 | **72.5%** (하한 0.3) | 832 | 320 (38.5%) | 35.6% | 355 | 1.215 ✓ | 99.7% |
| 005930 | 859 | 0.11 / 0.30 / 1.01 | 49.5% | 832 | 300 (36.1%) | 33.7% | 382 | 1.229 ✓ | 99.0% |
| 000660 | 859 | 0.41 / 0.69 / 1.18 | 0.0% | 832 | 170 (20.4%) | 12.8% | 602 | 1.141 ✓ | 99.5% |

- T3-C(open→close)에서 β_SOX≈0 이던 것과 달리 **갭 기준 β_gap 은 000660 0.69·005930 0.30·KOSPI200 0.24(중앙값)** 로 재료가 살아 있다(A-1R 취지 확인). 다만 KOSPI200·005930 은 원값이 하한 0.3 아래인 날이 많아 절단에 자주 걸린다.
- **σ_gap None 이 KOSPI200 35.6% · 005930 33.7%** — 첫 정의 2023-07-18/19 이후에도 "과거 120행 안 재료일 잔차 ≥60" 조건이 깨지는 구간(2023 71~75%·2025 32~36% None, 2024 18%, 2026 ≈0%)이 있다. 000660 은 첫 정의(2023-06-20) 후 None 0. → §5 해석 기록 ③·§6 확인 ②.
- err_z 캘리브레이션 std 1.14~1.23 (범위 안), |err_z|<5 99%+.

## 4. 실데이터 요약 — Transmission (`logs/transmission_summary.json`, 882행/scope, 4자산 정렬 각각 ok 853 · reused 29)

| scope(role) | β 정의(표본≥40 비율) | beta_soxx p05/p50/p95 | beta_resid_nvda p50 | beta_resid_mu p50 | beta_resid_tsm p50 | beta_up 평균 | beta_down 평균 | asym 평균(std) | asym_z std / 클립 걸림 |
|---|---|---|---|---|---|---|---|---|---|
| 005930 (component) | 861 (97.6%) | 0.25 / 0.73 / 2.07 | −0.28 | +0.37 | −0.01 | 0.69 | 1.06 | **−0.48** (1.28) | 1.34 / 1.9% |
| 000660 (component) | 861 (97.6%) | 0.70 / 1.26 / 2.59 | +0.07 | +0.77 | +0.17 | 1.26 | 1.55 | **−0.35** (2.08) | 1.37 / 3.3% |
| KOSPI200 (diagnostic) | 861 (97.6%) | 0.21 / 0.58 / 1.79 | −0.15 | +0.17 | −0.02 | 0.58 | 0.77 | −0.25 (0.92) | 1.32 / 1.6% |

- 직교화 기울기 b_j(z_j ~ z_SOXX, 120행): NVDA 0.70 · MU 0.80 · TSM 0.77(중앙값). 직교화 후 `corr(resid_j, z_SOXX)` = −0.038 / −0.008 / −0.014 (≈0, 방법 A 의도대로).
- 첫 정의일(005930): β 2023-02-03 · change20 z 2023-06-01 · asym z 2023-07-13. None 비율: z·resid 3.3%(=reused), β 2.4%(초기 21행), change20 z 11.5%(β+20+60), beta_up 11.5% / beta_down 11.2% / asym 19.8%(둘 다 ≥25 필요) / asym_z 26.6%. asym 첫 정의 후 None 137행(부호 편중으로 n_up 또는 n_down < 25).
- n_up / n_down: 평균 28.1 / 28.3, p05 23 / 20 → 60행 창에서 25 하한이 자주 경계에 닿는다(사전 등록 25 유지).
- 부호: 3 scope 모두 **β_down > β_up(평균)** — 표본 기간 평균으로는 SOXX 하락일 전달이 상승일보다 크다(asym 평균 음). asym_z 는 t−1까지 120행 분포 z 라 std가 1보다 크다(롤링 계열의 자기상관 → 참조 분포가 좁음; 클립 ±3 걸림 2~3%).
- change20 z: 4 β 모두 std 1.1~1.3, 평균 ≈0.
- 최근(2026-08-14, 005930): beta_soxx 1.73 · beta_resid_mu 1.71 · beta_up 2.90 · beta_down −1.13 · asym +4.03 → asym_z +1.43.

## 5. 해석 기록 (스펙이 명시하지 않은 곳 — 가장 엄격한 해석 채택)

| # | 항목 | 채택 | 대안(미채택) |
|---|---|---|---|
| ① | 모든 z 창 | §12.4 통일 규정 그대로: **t−1까지 120 국내 거래일(행) 창, 그 안 유효 표본<60 None**, 클립 ±3. z_j(자산 충격 z)·gap_hold_z·CLV_z·asym_z·change20 z 전부 동일 | "최근 120개 유효 관측"(gradec expected_std 방식) |
| ② | z 클립 ±3 적용 지점 | §3 공통 "모든 z 클립 ±3"을 **z 산출 시점**에 적용(패널 값이 이미 클립). 회귀 입력인 z_j 도 클립(문언 그대로) | family 결합 시에만 클립(§12.2-1) — 결합 시 재클립해도 동일 |
| ③ | σ_gap 표본 규칙 | "z 창" 통일 규정을 σ_gap 에도 적용: 과거 120행 창 안 재료일 잔차 **≥60**(floor 0.1%). 결과 None 이 많음(§3) | gradec 방식(최근 120개 잔차, min 20) — None 급감하나 §12.4 문언과 어긋남 |
| ④ | gap_reaction_err_z 클립 | **클립하지 않음**(ERR 원값 — std(err_z) 캘리브레이션 검사 유지). family 결합 시 §12.2-1 이 ±3 클립 | z 산출 시 클립 |
| ⑤ | 직교화 resid 정의 | 문언대로 `resid_j = z_j − b_j·z_SOXX`(절편 미차감, b_j 는 절편 포함 OLS 기울기) | 절편까지 차감한 회귀 잔차 |
| ⑥ | 2단계 β 창 위치 | **[t−59, t] (t 포함)** — β 는 t 마감 확정 상태값(A-1R "MT_t = t 마감까지 가용 자료"), 룩어헤드 아님. flow 부품 β 와 동일 관행 | t−1까지(gradec β 관행 — 그쪽은 t 의 기대값 산출용이라 t 제외가 필수였음) |
| ⑦ | 비대칭 창 | 같은 60행 창의 부호 부분집합(z_SOXX>0 / <0), 각 ≥25, **잔차 항 포함 다변량 OLS 의 SOXX 계수**(§12.3 문언). z_SOXX = 0 정확히인 행은 양쪽 제외 | 부호별로 60개씩 모으는 창 |
| ⑧ | change20 | β(t) − β(t−20 **행**)(둘 다 정의) → 과거 120행 Δβ 분포 z. 4 β 각각 | 달력 20일 |
| ⑨ | reused 세션 | 자산별 독립 판정. 어느 자산이든 None 이면 그 행은 회귀 표본에서 제외(완전 관측만) | 자산별 부분 투입 |
| ⑩ | 자산 정렬 stale | grade_c 와 동일 7일 | — |
| ⑪ | 3G 의 `t0_mode` | C-3 유지 `A1_open`(§7 문언) + `time_axis="A-1R"` 별도 컬럼 | — |
| ⑫ | 미국 적재 시작 | 2022-06-01: 2023-01 지표용 lookback = z 120 + 직교화 120 국내 거래일(≈2022-06 → 2023-01 딱 맞음. 실측 β 첫 정의 2023-02-03) | — |

## 6. 발주자 확인 사항

1. **§5 ⑥ 2단계 β 창 [t−59, t]** (t 포함) — t−1까지로 바꾸려면 상수 하나(창 오프셋) 변경·재산출. 룩어헤드와 무관, "상태 정의" 문제.
2. **σ_gap 표본 규칙(§5 ③)** — 엄격 해석으로 KOSPI200·005930 의 gap_reaction_err_z 가 34~36% None(2023·2025 집중). gradec 방식(최근 120개 잔차, min 20)으로 완화할지 결정 필요. 완화 시 config `gap3g.constants.sigma_gap_min_samples`·창 의미 변경 = 사전 등록 amendment.
3. **β_gap 하한 0.3 절단**이 KOSPI200 72.5% · 005930 49.5% 에 걸림(원값 중앙값 0.24 / 0.30). grade_c 와 같은 상수를 썼다(스펙 "등급C 재료 갭 기준 재추정"). 3G 전용 클립을 두려면 amendment.
4. **z 클립 ±3 을 z 산출 시점에 적용**(§5 ②) — 회귀 입력 z_j 도 클립된다. 결합 시점만 클립으로 바꾸려면 `z_clip_abs` 를 z_j 에 대해 None 처리(1줄).
5. **gap_hold 클립 [−1, 2] 걸림 29~34%** — 사전 등록값 그대로. 정보 손실 여부는 T5-5 family 결합·T5.5 소급 판정에서 관찰.
6. **yfinance 당일 세션 부분 종가**: 8/17 적재에 2026-08-17 행(미국 세션 진행 중 값)이 들어왔다. 정렬 규칙(d ≤ t−1)상 국내 t 행에 섞이지 않고 국내 8/18 행에서만 쓰이며 그때 재적재하면 갱신되지만, **재적재 없이 쓰면 부분 종가**다. `sox.py` 도 동일 동작(그대로 둠). 잡 실행 시각을 미국 마감 후로 고정하거나 "NY 16:05 이전이면 당일 행 제외" 가드 추가 여부 결정 요청.
7. TR-B(가중 합성 combiner)·잔차 자산 비대칭 진단은 미구현(§12.3 "진단 출력만"·challenger shadow) — T5-5 challenger 단계에서.
8. 다른 에이전트 동시 작업으로 config 에 `semi_diffusion`·`psa` 블록이 이미 있었고 그대로 두었다(내 블록은 `us_assets`·`gap3g`·`transmission` 3개, `kis:` 앞).
