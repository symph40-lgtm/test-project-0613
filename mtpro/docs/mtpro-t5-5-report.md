# T5-5 — family 결합·Energy·상위 상태·ΔMT·Divergence·Regime·텍스트 + challenger shadow 구현·실측 보고 (2026-08-17)

스펙: `docs/mtpro-t5-plan.md` §3(3-family champion)·§3.5+§12.2(Energy·cap)·§5(상위 상태·state_confidence)·§6(ΔMT·Divergence·Regime·텍스트)·§12.4(z 창)·§7(gold/mt_state)·§10(challenger). 승인된 사전 등록 — 변경 없음, 애매한 곳은 엄격 해석 + **해석 기록**(§4). 재사용: `core/errata.py`(delta_from_history·classify_regime·regime_transition·_clip_int), `components/rolling.py`(past_z·past_window·clip), `components/psa.py::psa_state_at`, `components/gradec.py::slope_through_origin`, 상류 gold 패널 6종(읽기 전용). Energy-Lite·gradec_panel(open→close)·T5-6 파일(events/expected_reaction·kis 분봉·jobs/live_*, config `expected_reaction`·`intraday`·`live`)은 건드리지 않음. **커밋 없음.**

## 1. 산출물

| 종류 | 경로 |
|---|---|
| 패키지 | `src/mtpro/state/__init__.py` |
| family | `src/mtpro/state/families.py` — Reaction/Price Acceptance/Participation 점수·conf·freshness, `ewma_state`(available_at ≤ t·세션 거리 EWMA hl 10), `family_score`, `family_conf`, `family_freshness` |
| Energy | `src/mtpro/state/energy.py` — `apply_cap`(§12.2 1~6+4b), `combine_families`(재정규화·min 2·tanh·round·energy_confidence·share/cap 필드), `orthogonalize_scores`(E-ORTH), `EQ_WEIGHTS`(E-EQ), `cap=False`(E-NOCAP) |
| 상위 상태 | `src/mtpro/state/upper_state.py` — `state_from_evidence`(score·status·state_confidence·evidence_n·available_evidence), `beta_deviation_z`, `build_upper_state`(증거 6종 × Good/Bad) |
| 출력 | `src/mtpro/state/outputs.py` — `delta_mt`(=errata), `divergence_series`/`divergence_label`, `ema_series`, `breadth_level_z`, `regime_step`/`regime_series`(errata A-2·A-3), `contrary_signals`/`compose_text`, challenger DMT-C1/C2·DIV-C1~C4 |
| 조립 | `src/mtpro/state/build.py` — `build_scope`/`build_all`, `GOLD_MT_STATE` 스키마, `assert_config_matches`, writer/summarize |
| 잡 | `jobs/build_mt_state.py` (`--start --end --scopes --summary-json --no-write`; config 불일치 exit 2, 입력 결손 exit 3) |
| config | `config/mtpro.yaml` `energy_family` · `upper_state` · `outputs` 블록 추가 (기존 블록 무변경) |
| gold | `data/gold/mt_state.parquet` (2646행 = 3스코프 × 882일, 2023-01-03~2026-08-14, `mt_state-0.1`) + `reaction_panel` · `price_accept_panel` · `participation_panel` · `upper_state_panel` (§7) + `challengers/{energy_orth,energy_eq,energy_nocap,dmt_c1,dmt_c2,div_c1..c4}.parquet` |
| 테스트 | `tests/test_state_energy.py`(11) · `test_state_families.py`(3) · `test_state_upper.py`(6) · `test_state_outputs.py`(9) · `test_state_lookahead.py`(6) = 35건 — **전체 pytest 342 passed**(기존 291 + T5-5 35 + 동시 작업 T5-6 분) |
| 요약 JSON | `logs/mt_state_summary_2026-08-17.json` (git 무시) |

## 2. 정의 (사전 등록 상수 = 모듈 = config, `tests/test_state_lookahead.py::test_config_constants_match_modules`)

### 2.1 family (§3)
| family | 컴포넌트 (클립 ±3 → 단순 평균) | 최소 가용 | 원천 |
|---|---|---|---|
| Reaction (w .40) | `err_signed_ewma` = 재료일 `gap_reaction_err_z`(클립 ±3) 의 EWMA(hl 10 세션, 관측 창 120) · `beta_asym_z` = z(GoodBeta − BadBeta), Good/BadBeta = 최근 20 세션 good(sox>0)/bad(sox<0) 재료일 `gap_pct ≈ β·expected_gap`(원점 통과 OLS, 클립 [0.3,2], 표본<3 None — 등급C 상수 재사용, **갭 기준 재추정**) · `transmission_asym_z`(component 스코프 005930·000660 만) | 1 | gap3g_panel · transmission_panel |
| Price Acceptance (w .35) | `shock_absorption_z`(**None 예약**, T5-6) · `gap_hold_z`(일별 원값) · `close_acceptance_z`(일별 원값) · `psa_z` = `psa_state_at(final ∧ available_at ≤ t)` | 2 | gap3g_panel · psa_events |
| Participation (w .25) | `flow_impact_residual_z`(스코프) · `breadth_impulse_z`(시장) · `semi_diffusion_z`(시장) | 2 | flow/breadth/semi_diffusion_panel |

`family_conf = n_avail/n_total × freshness`, freshness = 가용 컴포넌트 중 **가장 최근 관측** 거리 d(세션) → 0.5^(d/10) (일별 컴포넌트 = 0 → 1; §3.3 "P freshness 1" 은 결과) — 해석 기록 ③.

### 2.2 Energy (§3.5·§12.2) — `energy.py`
w' 재정규화(가용 family) → c_f = w'·s_f → share = |c|/Σ|c| → max share > 0.6 이면 `c_f ← sign·1.5·Σ_others|c|`, 초과분을 나머지에 |c| 비례 재배분 1회 → 4b 재검사 1회(share > 0.6 → cap·잔여 폐기) → Σ_others < 1e-9 → cap 미적용·`cap_undefined` → `Energy = round(100·tanh(Σc))`, min 2 family, `energy_confidence = Σw'·conf`([0,1]). 출력 `family_share_{R,PA,P}`(최종·cap 후), `cap_applied`, `cap_family`, `cap_undefined`, `families_used`. 테스트: c=(0.99,0.01,0) → 1차 cap R=.015·PA=.985 → 4b PA=.0225·잔여 폐기·share PA=.6 (`test_cap_example_0_99_0_01_0_goes_to_4b_and_discards_residual`); 2 family 극단(2.0,0.1) → 최종 share .4/.6; 부호 유지; cap_undefined; min family; **`combine_families`/`apply_cap` 시그니처에 상위 상태·divergence·regime 인자 없음**(테스트).

### 2.3 상위 상태 (§5) — `upper_state.py`
증거 6종 × Good/Bad: `*_err`(good/bad 재료일 err_z 클립 EWMA) · `*_beta`(sign·(β−1)/std_past120(β), 표본<60 None, EWMA) · `*_shock`(None 예약) · `*_gap`(gap_hold_z, 양/음의 갭일 EWMA) · `*_psa`(`psa_state_at` 방향별 final) · `*_flow`(flow z, good/bad 재료일 EWMA). `score = round(100·tanh(mean))`, n_avail<2 → None+`insufficient`; `state_confidence = round(100·(n/6)·(0.5+0.5·agreement)·freshness)`(insufficient 에도 산출); `evidence_n` = 120 세션 창 원 관측 수 합; `available_evidence` 이름 목록. 테스트: ERR 1개 +80 → conf ≤ 17·insufficient / 4개 일치 +80 → score 80·conf 67 / 불일치 시 감소. Energy 입력 아님(`energy.py` 는 upper_state 를 import 하지 않음, 시그니처 테스트).

### 2.4 출력 (§6) — `outputs.py`
ΔMT = `errata.delta_from_history`(5·60·20·5) 그대로 / Divergence = past_z(slope20 E) − past_z(slope20 ln close), z 창 120(t−1까지, <60 None), 라벨 ±1 ∧ 가격 z 부호 / Regime = `classify_regime(EMA20(E), ΔMT, Bad Resilience 점수, breadth_level_z, prev)` + `regime_transition(.15, 2일)`; **`regime_step`/`regime_series`/`combine_families`/errata 함수 시그니처에 "div" 인자 없음**(테스트) / 텍스트 `"{Regime} 유지|전환 ({p:.0%})"` + 반대 신호(Energy 부호·ΔMT ∓15·Good/Bad ±50·Divergence 라벨) 있으면 **반드시** `" / 그러나 {근거·conf 병기} — {해석}"`(테스트: 예시 문장 "Winter 유지 (70%) / 그러나 악재 내성 급개선(+62, conf 58)·MT 양의 다이버전스(+1.4) — 강한 해빙 신호" 재현).

## 3. 실데이터 요약 (2023-01-03~2026-08-14, 882일 × 3스코프)

### 3.1 Energy·family
| 항목 | KOSPI200 | 005930 | 000660 |
|---|---|---|---|
| Energy None 비율 | **6.2%** (P 단독 55일 + R+P 24일 — PA warmup·gap_hold None 겹침) | 0.0% | 0.0% |
| Energy 분포 (mean/std/p05/p50/p95) | 5.7 / 32.4 / −51 / 4 / 59 | 1.0 / 34.8 / −58 / 0 / 60 | 1.2 / 34.8 / −56 / 1 / 62 |
| 3 family 가용 비율 (§8 작동 항목 ≥80%) | 82.0% | 85.3% | 87.1% |
| families_used 빈도 | R+PA+P 723 · PA+P 80 · P 55 · R+P 24 | R+PA+P 752 · PA+P 130 | R+PA+P 768 · PA+P 114 |
| family None 비율 R / PA / P | 15.3 / 9.0 / 0 % | 14.7 / 0 / 0 % | 12.9 / 0 / 0 % |
| R 첫 정의일 · 컴포넌트 None%(err/beta_asym/trans) | 2023-07-20 · 15/66/**100**(진단 전용) | 2023-07-13 · 15/64/27 | 2023-06-21 · 13/23/27 |
| **cap 적용 비율**(Energy 정의일) · cap_family | **42.9%** · PA 209 / R 85 / P 61 | 38.3% · PA 153 / R 135 / P 50 | 42.6% · PA 165 / R 159 / P 52 |
| cap_undefined | 0 | 0 | 0 |
| family_share 평균 R/PA/P | .33/.39/.33 (max .60) | .36/.39/.31 | .36/.38/.31 |
| energy_confidence mean/p05/p95 | .63/.45/.78 | .78/.57/.91 | .84/.61/.91 |
| family_conf 평균 R/PA/P | .38/.62/.95 | .75/.70/.95 | .91/.71/.95 |
| ΔMT None 비율 · 분포(p05/p95) | 15.0% · −8/+8 | 1.0% · −9/+8 | 1.0% · −8/+8 |

cap 이 40% 안팎으로 잦은 이유: 3 family 의 절대 share 상한 0.6 은 한 family 가 나머지 둘 합의 1.5배를 넘으면 걸리는데, 세 점수가 독립적 부호를 가지면 상쇄로 Σ_others 가 작아지는 날이 많다(2 family 날은 큰 쪽이 .6 넘기 쉬움). 4b 재cap 도 발생(2 family 극단). champion 규칙 그대로 — 기록.

### 3.2 상위 상태
| 항목 | KOSPI200 | 005930 | 000660 |
|---|---|---|---|
| Good Acceptance None(insufficient) 비율 | 15.8% (139일 — 초기 `good_gap` 단독) | 0.1% | 0.2% |
| Good 분포 mean/p05/p50/p95 | 14.7 / −28 / 17 / 53 | 18.3 / −22 / 18 / 55 | 17.6 / −21 / 19 / 50 |
| good_state_confidence mean/p05/p50/p95 | 58 / 16 / 67 / 83 | 60 / 23 / 67 / 83 | 64 / 25 / 67 / 83 |
| good_evidence_n p50 | 129 | 142 | 276 |
| good_available_evidence 최빈 | err+beta+gap+psa+flow 624 · gap 137 · err+gap+flow 72 | 5종 634 · gap+psa 132 · err+gap+psa+flow 109 | 5종 699 · gap+psa 117 |
| Bad Resilience None 비율 | 15.3% | 0.6% | 0.6% |
| Bad 분포 mean/p05/p50/p95 | −10.4 / −58 / −11 / 40 | −17.0 / −50 / −18 / 19 | −9.6 / −55 / −10 / 34 |
| bad_state_confidence mean/p50 | 52 / 58 | 56 / 58 | 63 / 67 |
| insufficient 행의 state_confidence | 10~17 (§5 예시 ≤17 과 정합) | 〃 | 〃 |
`*_shock`(부품 3 장중)은 전 구간 None(예약) → n_avail 최대 5 → state_confidence 상한 = 100×5/6 = 83.

### 3.3 Regime·Divergence·텍스트
| 항목 | KOSPI200 | 005930 | 000660 |
|---|---|---|---|
| Regime 첫 라벨일(해석 기록 ⑫) | 2023-11-29 | 2023-02-24 | 2023-02-24 |
| Regime 분포 | spring 340 · winter 277 · thaw 42 · None 223 | winter 659 · spring 123 · cooling 64 · None 36 | winter 621 · spring 208 · thaw 17 · None 36 |
| 전환 수 (§8 n_inference 20 → INSUFFICIENT 예정) | 4 (thaw 24-11-19 → winter 25-01-21 → spring 25-06-25 → winter 25-11-26) | 7 | 6 |
| fallback 빈도 (prev_regime / none) | 638 / 21 | 722 / 124 | 731 / 115 |
| Divergence None 비율 · 분포 std · 라벨(pos/neg) | 24.2% · 1.46 · 130/204 | 9.0% · 1.55 · 180/207 | 9.0% · 1.66 · 165/201 |
| 텍스트 행 · **반대 신호 병기 비율** · 근거 ≥2 | 659 · **66.3%** · 134 | 846 · 62.8% · 176 | 846 · 61.2% · 187 |
| 반대 신호 항목 빈도 | Energy 음전 170 · 양전 157 · 음의 div 112 · 양의 div 74 · 호재 개선 37 · 악재 악화 27 | Energy 양전 368 · 양의 div 163 · 호재 개선 64 · 음전 67 · 음의 div 47 | Energy 양전 303 · 양의 div 140 · 음전 104 · 음의 div 85 · 악재 개선 20·악화 36 |
- Regime 확률은 A-2 규칙상 대개 한 규칙만 충족 → 라벨 확률 1.0(평균 .99). fallback prev_regime 이 75~85% — errata 규칙 4개의 조건(EMA20 < −20 ∧ Bad<0 등)이 좁아 대부분 날은 직전 확률 유지. 전환 대기 중(A-3 2일 연속) 라벨 확률이 0% 로 표시되는 날 존재(예: 000660 2026-08-14 "Winter 유지 (0%)", spring 확률 1.0 첫날) — 규칙대로.
- 반대 신호 병기 60%+ 의 대부분은 **Energy 부호 반대**(예: "Winter 유지 / 그러나 Energy 양전(+1)") — §6 "빠른 층 부호가 어긋나면 반드시" 를 문자 그대로(임계 0) 적용한 결과. 발주자 확인 사항 (5).

### 3.4 challenger (shadow)
| challenger | KOSPI200 | 005930 | 000660 |
|---|---|---|---|
| E-ORTH (n·champion 상관·cap율) | 687 · .916 · 32% | 692 · .928 · 33% | 708 · .913 · 34% |
| E-EQ | 827 · .991 · 39% | 882 · .989 · 35% | 882 · .987 · 37% |
| E-NOCAP | 827 · .939 · 0 (std 34.5 vs 32.4) | 882 · .929 · 0 | 882 · .929 · 0 |
| DMT-C1 std / DMT-C2 std | 12.1 / 10.7 (champion 5.1) | 12.3 / 10.8 | 11.9 / 10.6 |
| DIV-C1·C2·C3·C4 라벨(pos/neg) | 109/136 · 75/108 · 143/171 · 126/210 | 156/166 · 149/180 · 195/212 · 166/206 | 158/166 · 133/158 · 201/206 · 145/212 |

## 4. 해석 기록 (엄격 해석·대안 병기 — 스펙 변경 없음)
| # | 항목 | 채택 | 근거·대안 |
|---|---|---|---|
| ① | ERR 부호 규약 (§3.1 "ERR_z × sign(surprise)", §5 "−ERR_z of bad") | gap3g `gap_reaction_err_z` 는 **수익률 공간 잔차** (gap − expected)/σ → 호재일 + = 초과 상승, 악재일 + = 버팀. 표의 부호 규정 "양=우호"·"버팀=+" 를 기준으로 **그대로 사용**(곱셈·반전 없음). 재료 방향 공간값 `err_surprise_space = err_obs × sign(sox)` 병기 | 계획서 표기는 ERR_z 를 재료 방향 공간(+ = 재료 방향으로 더 강한 반응)으로 둘 때 성립. 수익률 공간 err_z 에 × sign 을 적용하면 악재일 "더 크게 하락" 이 + 가 되어 표의 부호 규정과 모순. errata.asymmetry·gradec(등급C bad_resilience_z = +err_z) 관례와 정합. **발주자 확인 사항 (1)** |
| ② | KOSPI200 transmission_asym_z | Reaction family 입력에서 제외(None) | config `transmission.scopes_diagnostic: [KOSPI200]`·§3.4 "진단" — KOSPI200 R = ERR·beta_asym 만(min 1) |
| ③ | family freshness 집계 | 가용 컴포넌트 중 **가장 최근 관측** 거리 (일별 컴포넌트 = 0 → 1) | §5 "가장 최근 관측 기준" 규약을 family 에 적용, §3.3 "P freshness 1" 은 결과. 대안: (a) 이벤트 기반 컴포넌트만(psa 50세션 stale 시 PA conf .02 로 급락 — 1차 실측 후 폐기), (c) 컴포넌트별 freshness 평균. **발주자 확인 사항 (2)** |
| ④ | EWMA 관측 창 | 120 세션(창 밖 가중 ≤ 0.5^12 ≈ 2e-4) — ERR·beta·gap·flow 증거·evidence_n 집계 | `psa_state_at` 은 전 이력(재사용 접점 그대로) — 수치 차이 무시 가능 |
| ⑤ | 상위 상태 bad_err | +err_z(수익률 공간, 버팀=+) | ① 과 동일 |
| ⑥ | z(GoodBeta − 1) / z(1 − BadBeta) | (β − 1)/std_past120(β) (중립 1 중심, 평균 중심화 없음), 표본<60 None, 클립 ±3 | 표준 z 는 −1 이 소거되어 표기가 무의미 → 표기의 의도(중립 1 대비 편차) 보존. **발주자 확인 사항 (3)** |
| ⑦ | insufficient 시 state_confidence | 산출(score 만 None) | §5 예시 "증거 1개 → conf ≤ 17" 재현·테스트 |
| ⑧ | 소급 구간 good/bad 이벤트일 | gap3g 재료일(err_z 유효) ∧ sign(sox_ret_prev) | 등급A 전진 구간은 `surprise_sign` 열(T5-6 인터페이스, 없으면 sox 부호 폴백) |
| ⑨ | Regime 입력 Good Acceptance | 미투입 | `errata.classify_regime` 시그니처(energy·delta·bad·breadth) 고정 재사용 — 규칙 4개에 Good 항 없음 |
| ⑩ | EMA20(Energy) | α=2/21, None 건너뜀, 유효 관측 20 미만 None | 상수 없음 → 관례(pandas span) |
| ⑪ | breadth "레벨" | `above_20d_ratio` 의 z(120·60·클립 3) | 원값 [0,1] 은 A-2 `breadth>0` 항상 참. 대안: `ratio − 0.5`. **발주자 확인 사항 (4)** |
| ⑫ | Regime 시작 | classify_regime 이 fallback 없이 확률을 낸 첫날부터 라벨 확정(그 전 None) | uniform fallback → argmax 가 사전 순서 winter 로 고정되는 인공물 회피 |
| ⑬ | 컴포넌트 클립 시점 | ERR 관측값을 ±3 클립 후 EWMA(family score 단계 재클립은 항등) | §3 "모든 z 클립 ±3"·gap3g 주석 "family 결합 시 §12.2-1 이 ±3 클립" |
| ⑭ | gap_hold_z·close_acceptance_z | 일별 원값(EWMA 없음) | §3.2 표에 EWMA 표기 없음(ERR·psa 만 명시). 상위 상태 증거로는 §5 대로 EWMA |
| ⑮ | family_share 출력 | cap·재배분 **후** 최종 share | 재배분으로 cap family 의 최종 share 는 0.6 미만이 될 수 있음(테스트 주석) |
| ⑯ | energy_confidence 척도 | [0,1] (×100 없음) | §3.5 산식 그대로 |
| ⑰ | DIV-C3/C4 z 표본 하한 | 60 (§12.4 통일 규정) | 252 창도 표본 60 이상이면 정의 |

## 5. 룩어헤드·재현성 테스트
- 합성 gold 6종으로 `build_scope` → cut 이후 모든 입력·psa 관측(available_at ≥ cut) 변조 → cut 이전 mt_state 전 컬럼 불변, `available_at == date` (`test_future_mutation_leaves_past_unchanged_and_available_at_is_t`).
- `--end` 절단 실행 = 전체 실행의 접두(`test_end_truncation_equals_full_run_prefix`).
- psa: available_at 전 미사용·pending 미포함·방향별 증거 (`test_psa_available_at_rule_pending_and_future_not_used`).
- Divergence·E-ORTH: 미래 변조 → 과거 불변, 표본 하한 정확히 60.
- 스키마 write/read, families_used<2 ↔ Energy None, share 합 1·cap 행 max share ≤ .6, 텍스트 형식.

## 6. 발주자 확인 사항
1. **ERR 부호 규약**(해석 기록 ①·⑤): 수익률 공간 잔차 그대로 = "양=우호". 계획서 문구(× sign / −ERR_z of bad)를 재료 방향 공간 표기로 읽은 것. 다른 의도면 `err_obs` 정의 한 줄 교체(err_surprise_space 열 이미 병기).
2. **family freshness 집계**(③): 가장 최근 관측 기준 채택 → PA/P 는 사실상 1, R 은 KOSPI200(일별 컴포넌트 없음)에서만 ERR 재료일 거리 반영(p05 .015). 대안 (a)/(c) 는 §4 표.
3. **z(GoodBeta − 1)**(⑥): 중립 1 중심·과거 std 나눗셈.
4. **breadth 레벨**(⑪): above_20d_ratio 의 z. `ratio − 0.5` 가 의도면 상수 1개(0.5) 사전 등록 필요.
5. **반대 신호 병기 빈도 60%+**: Energy 부호 반대(임계 0)가 대부분("Winter 유지 / 그러나 Energy 양전(+1)"). 스펙 문자 그대로. 노이즈 억제 임계(예: |Energy| ≥ 20)를 원하면 amendment(§6 문구 변경)로만.
6. Regime: A-2 규칙이 좁아 fallback prev_regime 75~85%, thaw 희소, 라벨 확률 1.0/0.0 이진에 가까움(전환 대기일 "유지 (0%)" 표시). 규칙 자체는 errata 고정 — 기록만.
7. KOSPI200 Energy None 6.2%·R None 15%(transmission 진단 전용 + beta_asym 표본 부족 66%) — §8 "3 family 가용 ≥80%" 는 3스코프 모두 충족(82/85/87%).
8. §7 의 gold/reaction_panel·price_accept_panel·participation_panel 도 함께 산출(감사용). 불필요하면 잡 옵션으로 끌 수 있음.
