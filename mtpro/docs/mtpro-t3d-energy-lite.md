# T3-D — Energy-Lite 조립 보고 (2026-08-17)

발주서 WORKORDER_MTPRO_v10.1 §2.1 소급 트랙 "부품 6~7 (부분): Energy-Lite = f(flow, breadth, 등급C ERR) — 가중치 사전 등록 후 측정" · Gate R1 §3(측정은 T4) · AM-2(delta) · AM-5 ④(부품 8 인터페이스) · config `energy_lite` 블록. 범위는 **조립만** — 컴포넌트 계산·ingest·config·core 는 손대지 않았고, Energy/Delta 산식은 `core.errata.energy` / `core.errata.delta_from_history` 를 그대로 재사용했다(재구현 없음).

## 1. 산출물

| 종류 | 경로 |
|---|---|
| 조립 코드 | `src/mtpro/components/energy_lite.py` |
| 테스트 | `tests/test_energy_lite.py` (17건, 합성 데이터) |
| 빌드 잡 | `jobs/build_energy_lite.py` (`--wait-minutes N`: 입력 gold 대기 → 초과 시 exit 3, config 불일치 exit 2, `--summary-json`) |
| gold | `data/gold/energy_lite_panel.parquet` — `energy_lite.GOLD_ENERGY_LITE_PANEL`: date, scope, flow_z, breadth_z, gradec_err_z, energy_lite, delta_lite, available_components, n_components, good_acceptance_z, bad_resilience_z, good_beta, bad_beta, engine_ver |
| 실행 요약 | `logs/energy_lite_summary.json` |

입력(읽기 전용, gold): `flow_panel.parquet`(T3-A/부품 4, flow-0.1) · `breadth_panel.parquet`(T3-B/부품 5, breadth-0.1, 시장 공통) · `gradec_panel.parquet`(T3-C/등급C, gradec-0.1).

## 2. 정의 (사전 등록 — 모듈 상수, 측정 후 변경 금지)

| 항목 | 정의 | 상수 |
|---|---|---|
| 컴포넌트 flow | `flow_panel.flow_impact_residual_z` (스코프별) | `COMPONENT_SOURCES["flow"]` |
| 컴포넌트 breadth | `breadth_panel.breadth_impulse_z` — **시장 공통 값을 각 스코프에 동일 적용** (breadth 패널에 scope 열이 있으면 거부) | `COMPONENT_SOURCES["breadth"]` |
| 컴포넌트 gradec_err | `mean(good_acceptance_z, bad_resilience_z)` — **가용한 것의 평균**: 둘 다 있으면 평균, 하나만 있으면 그 값, 둘 다 None 이면 None | `GRADEC_ERR_DEFINITION` |
| 추가 표준화 | **없음.** 세 컴포넌트는 상류에서 이미 z(각 과거 120 거래일 창). config `z_window_days=120` 은 상류 창과의 일치 선언이며 테스트로 flow `RESID_Z_WINDOW_DAYS`·breadth `IMPULSE_Z_WINDOW_DAYS`·grade_c `err_z_window_days` = 120 을 검증 | `Z_WINDOW_DAYS=120` |
| 가중 | flow .3333 / breadth .3333 / gradec_err .3334 (합 1.0, 무정보 균등) — config `energy_lite.weights` 와 일치(테스트·잡 assert) | `WEIGHTS` |
| Energy-Lite | `core.errata.energy(components, WEIGHTS, min_components=2)`: tanh(z) 가중합 ×100 → 반올림 정수 [-100,100]; None 컴포넌트 제외 후 가중 재정규화(합 1); **가용 < 2 → None** (A-6 규칙 "<3 → None"의 Lite 특례 — 컴포넌트가 3개뿐) | `MIN_COMPONENTS=2` |
| Delta-Lite | `core.errata.delta_from_history(그 스코프 energy 이력[..t], recent=5, hist_window=60, scale=20, min_changes=5)` — AM-2(기준 분포 = 최근 창 이전 변화량, `DELTA_SD_FLOOR=1.0`), [-100,100] 정수. 최근 5창에 None 있으면 None, 기준 변화량 < 5 면 None | `DELTA_PARAMS` |
| available_components / n_components | `energy()` 가 돌려준 가용 목록(등록 순서 flow→breadth→gradec_err)과 개수 | — |
| 부품 8 인터페이스 (AM-5 ④) | `mt_state_records(panel)` → `{date, scope, energy, delta, regime_probs=None, confidence=None, good_acceptance_z, bad_resilience_z, good_beta, bad_beta}`. regime_probs·confidence 는 전진 트랙(완전판 6~7) 범위라 **None 자리만 예약**(`MT_STATE_FORWARD_ONLY`). good/bad_z·beta 는 gradec_panel 값 전달 | `MT_STATE_FIELDS` |
| 날짜 축 | 스코프별 flow ∪ gradec ∪ breadth 날짜 합집합. 어느 입력에 없는 날은 그 컴포넌트 None. (date, scope) 중복은 오류 | — |
| 결측 | 전부 None(parquet null). 0 대체 없음 | — |

## 3. 테스트 (tests/test_energy_lite.py, 17건)

- **룩어헤드**: 합성 3스코프×150일. cutoff 이후 flow ×(−3)·breadth=5·gradec None·beta=9.9 로 변조 → cutoff 이전 행 전부 `assert_frame_equal` 동일(미래 energy 는 실제로 달라짐을 함께 확인); cutoff 이후 행 삭제 → 이전 행 동일.
- **None 전파**: 가용 1개(flow 만) → energy None·`available_components=["flow"]`; 가용 2개(flow+gradec_err) → 값, 재정규화 가중(.3333/.6667, .3334/.6667) 수기 계산 = `errata.energy` 결과 = 패널 값; 3개 전부 None → None·빈 목록·컴포넌트 z 도 NaN 유지.
- **재사용 검산**: 전 행에 대해 `errata.energy` / `errata.delta_from_history`(과거~당일 이력) 결과와 일치, 범위 [-100,100]. 최근 5창에 None → delta None, 창이 지나면 복귀.
- **가중 합 1·양수**, **config `energy_lite` = 모듈 상수**(weights·min_components 2·z_window 120·scopes), 불일치 시 `EnergyLiteInputError`(loud). 상류 z 창 = 120 일치.
- gradec_err 정의(평균/단독/둘 다 None), breadth 시장 공통 → 전 스코프 동일, breadth 에 scope 열 → 거부, 중복 행 → 거부, mt_state 필드·None 자리, arrow 스키마·null 왕복, 빌드 잡 엔드투엔드(합성 gold → 출력·요약, 입력 결손 exit 3).

전체 pytest: **189 passed** (기존 172 + 17).

## 4. 실데이터 실행 (2026-08-17 19:38, `jobs/build_energy_lite.py --summary-json logs/energy_lite_summary.json`)

입력 mtime: flow_panel 19:34:18(2,646행) · breadth_panel 19:22:45(882행) · gradec_panel **19:36:23**(2,646행, gradec-0.1). gradec 는 T3-C 에이전트가 같은 시각대에 산출한 파일을 그대로 읽었다 — 이후 gradec 가 재산출되면 이 잡을 다시 돌려야 한다(잡은 입력을 읽기만 하며 결과는 결정적).

출력: **2,646행 = 3스코프 × 882 거래일 (2023-01-03 ~ 2026-08-14)**, engine_ver `energy_lite-0.1`.

| 항목 | KOSPI200 | 005930 | 000660 |
|---|---|---|---|
| 행 수 | 882 | 882 | 882 |
| energy None 비율 | 6.24% (55행, **2023-01-03~03-23 연속** — gradec_err 미가용 + flow 미가용 → breadth 1개뿐) | 6.24% (동일) | 6.24% (동일) |
| 첫 energy 일 / 첫 delta 일 | 2023-03-24 / 2023-04-06 | 동일 | 동일 |
| energy min / median / max | −84 / −1 / 81 | −89 / −1 / 86 | −71 / −1 / 83 |
| energy mean / std | −0.6 / 30.2 | −0.8 / 30.0 | 0.3 / 30.8 |
| energy q05 / q25 / q75 / q95 | −50 / −22 / 23 / 47 | −50 / −22 / 22 / 46 | −50 / −23 / 24 / 51 |
| \|energy\| ≥ 80 비율 | 0.97% (8일) | 0.48% (4일) | 0.24% (2일) |
| \|energy\| ≥ 50 비율 | 9.1% | 8.1% | 11.1% |
| delta None 비율 | 7.26% | 7.26% | 7.26% |
| delta min / median / max | −42 / 0 / 32 | −48 / 0 / 24 | −43 / 0 / 31 |
| delta ±100 도달 비율 | **0%** | **0%** | **0%** |
| \|delta\| ≥ 20 비율 / delta std | 3.1% / 7.7 | 2.4% / 7.5 | 2.9% / 7.6 |
| 컴포넌트 3개 전부 가용 비율 | **84.5%** (745행) | 84.5% | 84.5% |
| n_components 분포 (1/2/3) | 55 / 82 / 745 | 동일 | 동일 |
| 컴포넌트 None 비율 flow / breadth / gradec_err | 15.5% / 0% / 6.2% | 동일 | 동일 |

None 구조(정직 기록): 가용 1개인 55행은 전부 `["breadth"]`(2023-01-03~03-23: flow 는 β 창 120일·gradec 는 β 60일+asym 창이 차기 전). 가용 2개인 82행은 전부 `["breadth","gradec_err"]`(2023-03-24~07-21: flow_impact_residual_z 가 아직 None — flow 의 120일 β + residual std 60 표본 요건). 2023-07-24 이후는 3스코프 모두 3개 전부 가용(결측 0). gradec_err 는 첫 energy 일 이후 결측 0 (good/bad 중 하나만 있는 날 59행은 "가용한 것의 평균" 규칙으로 값 유지). good_beta None 6.2% · bad_beta None 18.3% (gradec 그대로 전달).

서술 통계(관문 측정 아님): 컴포넌트 간 상관 flow/breadth −0.09 · flow/gradec_err +0.08 · breadth/gradec_err −0.06 (거의 직교 — 균등 가중이 특정 재료에 끌려가지 않음). 스코프 간 energy 상관 0.71~0.85 (breadth 공통 + 등급C 재료가 같은 ^SOX 이므로 예상 범위).

**Gate R1 측정은 하지 않았다** (T4, 관문 사전 등록 후). 익일 수익률 IC·baseline 상관 등 어떤 성능 수치도 여기 없다.

## 5. 발주자 확인 사항

1. **가중 균등 .3333/.3333/.3334** — config 에 "스펙 비례안 .27/.27/.46 은 최약 재료에 과중 — 발주자 확인 요청"으로 남아 있던 항목. 이 상태로 사전 등록·조립했다. Gate R1 측정 전에 확정 필요(측정 후 변경 금지).
2. **min_components=2 (A-6 Lite 특례)** — 3컴포넌트뿐이라 가용 2 이상 산출. 실데이터에서 이 특례가 실제로 쓰인 구간은 2023-03-24~07-21 82행(breadth+gradec_err) 뿐이고 그 이후는 전부 3개. 특례를 거두면(min 3) 첫 energy 일이 2023-07-24 로 밀린다.
3. **Delta ±100 미도달** — AM-2 규칙(기준 = 최근 창 이전 변화량, std 하한 1)으로도 실데이터 |delta| 최대 48, ±100 도달 0%, std ≈ 7.5. Energy 가 정수 [-100,100]이고 일간 변화 std 가 ~10점대라 5일 기울기 z 가 5를 넘기 어렵다(scale 20 × z 5 = 100). Lite 에서는 delta 가 사실상 [-50,50] 안에서 움직인다는 사실만 기록한다 — 상수 변경 제안 없음(측정 후 변경 금지·조용한 수정 금지).
4. **gradec_err 정의 "가용한 것의 평균"** — good/bad 한쪽만 있는 59일에도 값을 냈다(0 대체가 아니라 가용 표본 평균). "둘 다 있어야 산출"로 엄격화하면 gradec_err None 이 6.2%→12.9%(KOSPI200 기준)로 늘고 그만큼 2-컴포넌트 산출이 는다. 현행을 사전 등록했으니 R1 전에 이견 있으면 지금 결정.
5. **z_window_days=120 은 재표준화 창이 아니라 상류 창 일치 선언**으로 해석했다(컴포넌트가 이미 z 이므로 Lite 에서 추가 표준화 없음, 테스트로 일치 검증). config 주석 "컴포넌트 z 표준화 창(과거만)"과 뜻이 같은지 확인.
6. **부품 8 mt_state** 는 parquet 컬럼이 아니라 `mt_state_records()` 함수 인터페이스로 예약했다(regime_probs·confidence 는 None). parquet 에 None 열까지 두길 원하면 스키마 amendment 로.
7. gradec_panel 이 재산출되면 `jobs/build_energy_lite.py` 재실행 필요(입력 mtime 을 요약 JSON 에 남김).
8. **T3-C 열린 결정과 연동** — 이번 실행의 gradec_err 는 gradec_panel `reaction_basis=open_to_close`(A-1·규칙 5 준수, T3-C 보고 §확인사항 1: β≈0 문제) 값이다. 발주자가 close_to_close 등으로 결정하면 T3-C 재산출 후 이 잡만 다시 돌리면 된다(Lite 코드 변경 없음).
