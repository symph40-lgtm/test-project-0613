# T5-6 — 등급A Expected Reaction · 장중 부품 3(분봉 축적+흡수) · 라이브 크론 구현·실측 보고 (2026-08-17)

스펙: `docs/mtpro-t5-plan.md` §1(부품 3 장중 6점 A-1, t0=09:00, t6 없음)·§3.1(등급A Expected Reaction 종목 독립: Implicit/Explicit/shrinkage/결합·expected_std=정오표 A-1)·§2.2(검증 라벨 = Gap Reaction ERR 등급A)·§11 T5-6·§12.4·§12.5 + WORKORDER 개념 고정(종목 독립: pooling 금지·hierarchical shrinkage=challenger) + Amendment A-1(부품 3 = 개장 후 6점 흡수, 갭 제외) + 발주자 KIS 지시(전용 키 `mtpro/.env`, 캐시 `mtpro/.cache`, 기존 시스템 env·캐시 접근 금지). 커밋 없음. **동시 작업 중인 T5-5(`src/mtpro/state/`)는 건드리지 않음** — config 에는 `expected_reaction`·`intraday`·`live` 블록만 추가.

## 1. 산출물

| 종류 | 경로 |
|---|---|
| 등급A Expected Reaction | `src/mtpro/events/expected_reaction.py` (종목 독립 산출·overlay_gap3g 인터페이스) → `gold/expected_reaction_events.parquet` |
| VIX·TNX 재료 | `src/mtpro/ingest/macro_daily.py` (^VIX·^TNX 일봉, us_daily 재사용) → `bronze/macro_daily.parquet` |
| 분봉 축적기 | `src/mtpro/ingest/kis_minute_store.py` (전용 KIS 키, 소급·증분·결측 감지·이력창 경계) → `bronze/minute/{code}/{YYYY-MM-DD}.parquet` + `_status.json` |
| 장중 6점 | `src/mtpro/components/absorption.py` (A-1 6점·absorption_ratio·half_life·shock_absorption_z) → `gold/absorption_panel.parquet` |
| 잡 | `jobs/build_expected_reaction.py`, `jobs/accumulate_minutes.py`, `jobs/build_absorption.py`, `jobs/live_daily.py` |
| 라이브 운영 문서 | `docs/mtpro-live-ops.md` (Windows 작업 스케줄러 등록 명령·실패 확인 루틴) |
| config | `config/mtpro.yaml` `expected_reaction`·`intraday`·`live` 블록 (모듈 상수 = config, 일치 테스트) |
| 테스트 | `tests/test_expected_reaction.py`(16) · `tests/test_absorption.py`(11) · `tests/test_kis_minute_store.py`(9) · `tests/test_live_daily.py`(3) |

재사용(수정 없음): `kis/{client,minute}.py`, `events/{registry,independence,kr_calendar,scheduler}.py`, `core/errata.py`(`expected_std_rolling`·`attribution_quality`), `components/gap3g.py`(`align_prev_us_session`·`gap_pct`), `components/rolling.py`(`past_z`), `ingest/{us_daily,sox,store}.py`.

## 2. 등급A Expected Reaction (`expected_reaction.py`) — 종목 독립

- **입력**: 레지스트리 등급A(동결·consensus·actual) 이벤트 → surprise = actual − consensus, surprise_z = surprise / 유형별 **과거** 서프라이즈 rolling std(정오표 A-1 `expected_std_rolling`, window 20, floor 0, 표본<3 None). 피처(이벤트 단위, t0_kr 09:00 이전만): vix_z(^VIX 종가 z), sox_shift_z(전일밤 ^SOX z, `align_prev_us_session` d ≤ t0_kr−1 엄격·reused None), rate_change_bp(^TNX 5세션 변화 ×100). 반응 = **Gap Reaction** = `gap3g.gap_pct`(t0_kr·scope).
- **Implicit** = 동일 event_type·|Δsurprise_z|<0.8·최근 5건 gap 의 EWMA(반감기 30 **달력일** — 해석 기록), 표본<3 None.
- **Explicit** = 최근 120건 OLS(gap ~ 1 + 4피처) 와 전 이력 OLS 의 shrinkage `β=(1−α)β_recent+α·β_full`, α = 0.5(최근 30건 R²>0.3)/0.8. 최근 120건 중 피처 완비 표본<20 또는 현재 피처 결측 → None. (해석: α = 전 이력 쪽 가중.)
- **결합** = attribution_quality q(정오표 A-5, t0=09:00 KST·A1_open·같은 scope): q>0.85 → 0.7E+0.3I / q>0.7 → 0.5/0.5 / else 0.2E+0.8I. 한쪽만 있으면 그 값(method=explicit_only/implicit_only), 둘 다 없으면 None. **같은 날 등급A 2건(SAME_DAY_MULTI) → q=0.5 → 저가중** 자동 적용.
- **expected_std** = 같은 scope·유형의 과거 잔차(gap − expected) rolling std(A-1, floor 0.1%, 표본<3 None). err = gap − expected, err_z = err/std(클립 없음 — 캘리브레이션 원값). available_at = t0_kr **15:30 KST**(A-1R: 마감 후에만).
- **종목 독립(핵심)**: `build_scope_events(scope,…)` 는 다른 스코프의 반응을 절대 읽지 않는다. 테스트 `test_scope_independence_no_pooling` — 000660 반응을 부호반전·잡음으로 변조해도 005930 출력이 **완전 동일**(`assert_frame_equal`), 그리고 스코프별 독립 호출 = 전체 호출. SHRINK-H(종목 pooling shrinkage)는 `CHALLENGERS` 에 등록만, 미구현(`test_shrink_h_registered_not_implemented`).
- **룩어헤드**: surprise_z·피처·반응 모두 t0_kr **엄격 이전** 이벤트만 사용(같은 t0_kr 이벤트는 서로 이력 아님). t_cut 이후 피처/반응 변조 → 그 이전 행 불변(테스트 2건). 현재 이벤트의 expected 는 반응 변조에 불변(과거만 학습), gap·err 만 변함.
- **gap3g 인터페이스**: `overlay_gap3g(gap3g_panel, er_events)` 순수 함수 — gap3g 패널 **사본**에 등급A expected 를 얹어 `expected_gap_source="gradeA"`·grade A·err_z 갱신(gap3g 파일은 건드리지 않음). `gap3g.py` config `expected_gap_sources: [gradeC, gradeA]` 인터페이스와 일치.

**실데이터**: 레지스트리에 등급A 이벤트(동결+consensus+actual) **0건** → 잡이 0행 파일 + 정직 출력("0 grade-A events … wrote empty table"). 이는 계획서 §9 사전 표기대로(등급A는 라이브 시작일부터 축적) — 로직·독립성·shrinkage·q·None·룩어헤드는 **합성 데이터 16 테스트**로 검증(스코프 독립성·shrinkage α 분기·q 결합·err_z 캘리브레이션 std∈[0.7,1.3]·0 이벤트 포함). `^VIX·^TNX` 는 실제 적재(각 ≈1057행, 2022-06-01~2026-08-17) — 등급A 발생 시 즉시 피처 가용.

## 3. 분봉 축적기 (`kis_minute_store.py` + `jobs/accumulate_minutes.py`) — 실측

- 전용 KIS 키(`settings.env`=mtpro/.env)·토큰 캐시(mtpro/.cache)만. 005930·000660 정규장(J) 1분봉을 `bronze/minute/{code}/{YYYY-MM-DD}.parquet`(BRONZE_MINUTE, price_adjusted=False)에. 하루=파일 하나, 상태 `_status.json`(세션별 bars·state·attempts + depth_boundary).
- 소급 = **최신→과거**, 완결 세션만(당일은 15:40 KST 이후), 오래된 구간 연속 3세션 무응답 → 이력창 경계로 중단. 이후 증분(미적재·재시도 대상만). 무응답은 3회까지 재시도 후 gap 확정.
- **결측 감지**: XKRX 세션 대비 [경계/첫ok, 마지막 완결] 안의 state≠ok → `alerts.loud_failure('MINUTE_GAP')`. 중단·재시작 대비 `reconcile_status`(파일 있는데 상태 없으면 행 수로 복원), 10세션마다 상태 저장.

### 3.1 소급 적재 실측 (2026-08-17 실행, `jobs/accumulate_minutes.py`, DEPTH_DAYS=365)

| 종목 | 저장 세션 | 구간 | ok | empty(gap) | 이력창 경계 | 비고 |
|---|---|---|---|---|---|
| 005930 | 243 | 2025-08-18 ~ 2026-08-14 | 243 | 2 | 미도달(None) | 12개월 전 구간 응답 → KIS 이력 깊이 ≥12개월 재확인(T2 실측 365일과 일치) |
| 000660 | 243 | 2025-08-18 ~ 2026-08-14 | 243 | 2 | 미도달(None) | 005930 과 동일 gap 2건(2026-06-03·2026-07-17) — XKRX phantom 세션 |

- 소급 완료(2026-08-17 실행, exit=4 = MINUTE_GAP 있음): 2종목 각 245세션 시도 → 243 저장(각 2건이 XKRX phantom → empty), depth_boundary 미도달(12개월 전 구간까지 KIS 응답). 종목당 ≈1,700호출.
- 호출: 세션당 7호출(60분 앵커), 245세션 × 2종목 ≈ 3,430호출 + 호출 간 0.15초 → 종목당 약 15~25분(네트워크 포함).
- 봉 수: 대부분 381봉(09:00~15:30). <381 인 날 실측(005930): 대개 하루 중 ~30분 블록 결측(예: 2026-03-04 11:20~11:48, 2026-07-28 10:14~10:43) — KIS 앵커 응답의 부분 누락으로 보이며 모두 ≥300봉이라 `ok`. 10:00 개장일(수능 2025-11-13 = 331봉)은 late_open 으로 t1·t3 None 처리됨(6점 규칙).

### 3.2 결측일(MINUTE_GAP) — 발주자 확인 사항

- **005930 gap 2건: 2026-06-03·2026-07-17**. 둘 다 **XKRX 캘린더에는 세션인데 KRX 는 실제 휴장** — 확인: 두 날짜 모두 **일봉 bronze `ohlcv_adj` 에도 없음**(KRX 자체가 그 날 데이터 없음). 즉 KIS 무응답이 아니라 **XKRX(exchange_calendars 4.13.2)가 실제 휴장일을 세션으로 잘못 포함**한 것. 분봉 결측 감지가 이를 정확히 loud 로 잡았다.
  - 영향: 이 2세션은 재시도 3회 후 `empty` 로 남아 매 실행 MINUTE_GAP 을 낸다(조용히 넘기지 않음). 부품 3·gap3g·flow 등 **일봉 부품은 애초에 이 날 행이 없어** 무영향. **권고**: XKRX 세션을 관측 일봉(bronze) 과 교차검증해 phantom 세션을 거르는 규칙을 캘린더 래퍼에 추가할지 결정 요망(현재는 §12.5 champion=XKRX·폴백=관측일 그대로). 우선 이 2일은 알려진 예외로 기록.

## 4. 장중 6점 흡수 (`absorption.py`) — Amendment A-1

- 시간축 **A-1**(갭 제외): t0=09:00 시가 앵커, t1 09:05·t3 09:30·t4 14:30 = "시작시각 < HH:MM 인 마지막 완성봉 종가"(5분 초과 결측 None), t5 종가, **t2 = 재료 방향 극값**(호재 max high / 악재 min low, 시가 대비 — intake 검토 "호재는 high.max" 결함 반영). t6 없음.
- absorption_ratio = 악재 `1−|t5|/|t2|`, 호재 `t5/t2`(t2=0 None) — 계획서 §3.2 문구 그대로. half_life_min = t2 이후 절반 되돌림 첫 봉까지 분(진단). close_acceptance(CLV)는 3G 중복 → 미산출.
- **방향(그날 재료 부호)**: 등급A surprise 부호(expected_reaction_events, 같은 t0_kr·scope; 여러 건 부호 충돌 → None) 우선, 없으면 등급C 전일밤 ^SOX 부호(gap3g.sox_ret_prev; reused/missing None). `material_table` 로 결합.
- shock_absorption_z = 스코프별 absorption_ratio 의 z(과거 전용 120세션 t−1까지, 표본<60 None, 클립 ±3). 봉<300 → partial → 6점 미산출.

### 4.1 실데이터 요약 (`gold/absorption_panel.parquet`, 490행 = 245세션×2, 등급A 0건이라 방향=등급C SOX 부호)

| scope | session_state(ok/late_open/missing) | 방향(good/bad/none) | ratio 정의 n / p05·p50·p95 / min | shock_absorption_z n / std | bad인데 상승마감 | half_life None(ratio 있음) |
|---|---|---|---|---|---|---|
| 005930 | 238 / 5 / 2 | 147 / 90 / 8 | 225 / −14·−0.25·+0.97 / −75 | 165 / 0.65 | 54 | 45 |
| 000660 | 234 / 9 / 2 | 147 / 90 / 8 | 231 / −11.7·0·+0.96 / −185 | 171 / 0.95 | 57 | 47 |

- **absorption_ratio raw 는 꼬리가 두껍다**(min −75/−185) — 재료 없는 날 t2(peak)가 0 근처면 비율이 발산(스펙 정의의 본질). p50 ≈ 0. **family 결합에 쓰는 값은 클립 ±3 된 `shock_absorption_z`**(std 0.65/0.95, |극단| 흡수) 이므로 발산은 문제 없음(3G·다른 z 축과 동일 관례). session_state `late_open`(005930 5·000660 9)은 09:00 봉이 없거나(그날 첫 봉 > 09:00) 10:00 개장일 → t1·t3 None 로 정직 처리.
- 해석 기록: 등급C 방향(전일밤 SOX 부호)은 종목별 재료 강도가 약해 t2 가 작은 날이 많다 → ratio 원값의 의미는 약하고 **등급A 라이브(강한 방향 재료) 구간에서 진짜 의미**를 갖는다. bad(악재 방향)인데 상승 마감한 날(005930 54·000660 57)은 스펙 문구 `1−|t5|/|t2|` 상 ratio 가 1 미만으로 내려간다(§4 해석 기록 — 부호 반영안은 발주자 결정 사항).

## 5. 라이브 크론 (`jobs/live_daily.py`) — `docs/mtpro-live-ops.md`

- 13 step 순차(config `live.steps` 와 일치 테스트): consensus_scheduler → build_events_kr → ingest_krx → accumulate_minutes → build_flow → breadth → semi_diffusion → gap3g → transmission → psa → expected_reaction → absorption → build_mt_state(있으면; 없으면 skipped). 미국 일봉 증분은 각 build 잡 내부(^SOX·4자산·^VIX/^TNX).
- 실패(rc≠0·타임아웃·예외) → `alerts.loud_failure('LIVE_STEP_FAIL')` + 다음 step 계속(--stop-on-fail 이면 중단), 최종 종료코드 1. 로그 `logs/live_daily_{date}.log`(step stdout/stderr 원문) + `.json` 요약. `--dry-run`·`--only`·`--skip`·`--step-timeout` 지원.
- Windows 작업 스케줄러 등록 명령(`schtasks … /SC WEEKLY /D MON..FRI /ST 16:10`)·"놓친 작업 보정" 설정은 운영 문서에.

## 6. 테스트 — 전체 pytest 통과

- 신규 **39건**: expected_reaction 16(종목 독립·shrinkage α·q 결합·implicit EWMA·expected_std/err_z·룩어헤드×2·0 이벤트·overlay·SHRINK-H 미구현·상수-config), absorption 11(6점·price_at 5분 규칙·ratio 공식·half_life·partial/late_open·방향표 우선순위·충돌·z 과거전용·미래 변조 불변·스코프 독립·스키마·intraday gap), minute_store 9(경로·계획·결측 감지·재시도 상한·never/empty·이력창 경계·최근 연속 무응답=gap≠경계·에러 후 상태 보존·reconcile·excluded 지수·상수), live_daily 3(config 일치·가짜 step 실패 loud·타임아웃).
- **전체: 291 → 365 passed** (T5-5 다른 에이전트의 state 테스트 35건 포함, 본 작업과 독립). Windows 콘솔 cp949 대비 잡 stdout/stderr `reconfigure(utf-8)`.

## 7. 발주자 확인 사항

1. **등급A 실데이터 0건** — 레지스트리에 동결+actual 등급A 이벤트가 아직 없어 Expected Reaction 은 합성 검증만. 계획서 §9 사전 표기대로 라이브 시작 후 축적. 첫 등급A 이벤트가 동결·actual 입력되면 잡이 즉시 산출(피처 재료 VIX/TNX/SOX 는 이미 적재).
2. **KOSPI200 지수 분봉 제외** — 지수 분봉 TR(`FHKUP03500200 inquire-time-indexchartprice`)이 종목 분봉(`FHKST03010230`)과 스키마·파라미터가 달라 T5-6 범위에서 뺐다(config `intraday.minute_store.excluded` 기록). 부품 3 장중은 005930·000660 만. 지수 흡수가 필요하면 별도 어댑터+범위 결정 요망.
3. **XKRX phantom 세션 2건(2026-06-03·2026-07-17)** — §3.2. XKRX 가 실제 KRX 휴장일을 세션으로 포함 → 분봉 MINUTE_GAP 이 매 실행 뜬다. 일봉 부품엔 무영향. XKRX↔관측 일봉 교차검증 규칙 추가 여부 결정 요망(그 전까지 알려진 예외로 둠).
4. **absorption_ratio 발산·방향 재료** — 등급C(SOX) 방향은 t2 가 작아 raw ratio 가 두꺼운 꼬리를 갖는다. family 입력은 클립된 shock_absorption_z. 등급A 강재료 구간에서 의미가 살아난다는 점을 사전 등록에 남길지 판단 요망(semi_diffusion 해상도 한계와 동류 기록).
5. **KIS 유량·토큰** — 일간 증분은 2종목×7호출=14호출/일(호출 간 0.15초)로 여유. 소급은 종목당 ≈1,700호출/15~20분. **전용 앱키를 다른 프로세스가 쓰면 토큰 상호 무효화** — mtpro 전용 유지 필수(운영 문서 §4에 401/403 대처 기록).
