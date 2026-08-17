# MT-PRO T5 반영 계획서 — 개념 고정(AM-6~AM-10) 구현 설계 (제출본, 2026-08-17)

- 지위: **승인 전 구현 없음.** 이 문서의 champion 사양·상수·산식은 승인 즉시 사전 등록으로 고정된다(성과 확인 후 변경 불가, 대안은 challenger 등록·shadow만).
- 표기: 관문 = Gate R1 / Gate R2. 기존 시스템 모듈 = T2/R1/R2. 정오표 = A-1~A-6(부록 A). Amendment = A-1R·AM-*.
- 근거 문서: `WORKORDER_MTPRO_v10.1.md`(개념 고정 절), `docs/mtpro-t3-report.md`, `docs/mtpro-t4-gate-r1-result.md`(FAIL, 소급 변경 없음), `config/mtpro.yaml`.

---

## 0. 설계 변경 목록 (T3 산출물 대비)

| # | 변경 | 근거 | 영향 |
|---|---|---|---|
| Δ1 | 시간축 A-1 → **A-1R**: 장 마감 후 상태 산출에 갭(실현 최초 반응) 사용 허용, 사전 예측 입력은 금지 유지 | AM-6 | 부품 3에 **3G**(Gap Reaction/Gap Hold/Close Acceptance) 신설, 등급C·Transmission의 반응 정의가 close→close(갭 포함)로 이동(§3.1) — Gate R1 결과는 소급 변경 없음 |
| Δ2 | 부품 9 **PSA** 신설, `available_at = 관찰창 완료`, pending 시 MT 계산 제외 | AM-7 | 새 테이블 `psa_events`, 상태 pending/final |
| Δ3 | 부품 10 **Semi Transmission** 신설(종목별 독립, 수준+변화율, 상승/하락 비대칭 z) | AM-8 | 미국 4자산 일봉 적재(SOXX·NVDA·MU·TSM) |
| Δ4 | 부품 5에 **Semiconductor diffusion 축** 추가 | 출력 절 | 반도체 종목군 리스트(월초 asof) |
| Δ5 | **2층 구조**: primitive 3-family → Energy / 상위 상태(Good Acceptance·Bad Resilience)는 출력 전용 | AM-10 | Energy-Lite(균등 3컴포넌트) → family Energy로 교체(전진 트랙). Lite는 소급 기록으로만 보존 |
| Δ6 | 검증 철학: 1차 = 반응함수 재현성(ERR), IC는 2차 기록; 이벤트 독립성 = 정보 중첩; MT_t 확정 = t 마감까지 가용 자료 | AM-9 | 이벤트 스키마 필드 3종·purge 규칙·판정 3분법(PASS/FAIL/INSUFFICIENT) |
| Δ7 | 출력 확장: ΔMT·Price–MT Divergence(진단 전용) champion 산식, Regime 느린 층·반대 신호 병기 | 출력 절 | 텍스트 템플릿 |
| Δ8 | 상위 상태 필드 `state_confidence · evidence_n · available_evidence` | 추가 지시 | family confidence 규칙에서 파생 |
| Δ9 | 종목 독립: 스코프별 독립 추정, pooling 금지, hierarchical shrinkage는 challenger | 종목 독립 절 | 모든 회귀·EWMA·z 창은 (scope) 단위 |

---

## 1. 시간축 A-1R과 부품 3 / 3G

- **사전 예측 입력**(부품 8 예정 단계·T2/R1/R2 접점): 갭 사용 금지 유지.
- **장 마감 후 MT_t 산출**: 당일 실현된 갭을 최초 반응으로 사용. 개장 전 재료(등급A 7종 중 6종·등급C)의 반응 창:
  - `gap_reaction = open_t/close_{t−1} − 1` (%) → **Gap Reaction ERR** = (gap − expected_gap)/σ_gap: expected_gap은 §3.1의 Expected Reaction(등급A) 또는 β_SOX×SOX(등급C, 갭 기준으로 재추정 — T3의 open→close β≈0 결과와 별개 계열, D-A 소급 기록 불변).
  - `gap_hold = (close_t − close_{t−1}) / (open_t − close_{t−1})` (갭≠0일 때, 클립 [−1, 2]; |gap| < 0.3%면 None) — 1 = 갭 그대로 유지, >1 확장, <0 반전.
  - `close_acceptance = (close_t − low_t)/(high_t − low_t)` (CLV, [0,1]) → z(120일 과거).
  - 부품 3 **장중 6점(t1~t5)** 은 A-1 유지(t0=09:00 시가 앵커, t6 없음) — 분봉 필요, 전진 12개월 창.
- 등급A 사건이 없는 날의 3G는 등급C 재료(전일밤 ^SOX)로 채우되 `grade` 병기. 3G는 **일봉만으로 3년 소급 가능**(§9).

## 2. 이벤트 독립성·purge (AM-9) — 스키마·규칙·9월 실례

### 2.1 스키마 추가 (`silver/consensus_registry` + `silver/events_kr` 파생)
`t0_kr`(KR 거래일 09:00), `digest_window_end`(t0_kr + W_digest − 1 거래일), `independence_flag`(bool), `overlap_group`(str|None), `contamination_reason`(enum|None: OVERLAP_DIGEST_WINDOW · SAME_DAY_MULTI · EARNINGS_CLUSTER · PSA_PENDING_SHOCK · DATA_GAP), `used_for_state_from`(= available_at), `verify_eligible`(bool = independence_flag ∧ grade=A ∧ 결측 없음).

### 2.2 champion 규칙 (사전 등록)
- **소화 창 W_digest = 5 KR 거래일**(t0_kr 포함). 이벤트 e2의 t0_kr가 앞선 이벤트 e1의 [t0_kr, digest_window_end] 안이면 e2 = 비독립(`OVERLAP_DIGEST_WINDOW`, `overlap_group = {e1.id}+`) — **e1은 독립 유지**(먼저 온 정보). 같은 t0_kr(SAME_DAY_MULTI) → 둘 다 비독립(귀속 불가), 상태 산출에는 attribution_quality(정오표 A-5, 1/n)로 사용.
- 실적 클러스터: 삼전 잠정·하닉·NVDA는 서로 [t0_kr ± 3거래일] 안이면 `EARNINGS_CLUSTER`(양쪽 비독립).
- PSA 미완료 창 안의 이벤트: 상태 산출엔 사용, 검증 표본에선 `PSA_PENDING_SHOCK`으로 제외.
- **검증 쌍 규칙**: 상태 MT_t(t 마감 확정)의 1차 검증 라벨 = t 이후 **최초의 verify_eligible 이벤트 e***(t0_kr > t). 비독립 이벤트는 건너뛴다(라벨로 쓰지 않음). 같은 e*는 여러 t의 라벨이 될 수 있으므로 **추론 표본은 e* 단위로 1쌍**(t = e*.t0_kr 직전 거래일의 MT_t 하나만 사용, 나머지 t는 서술 전용) — 표본 중복 팽창 방지.
- 종속값 = e*의 **ERR_z**(등급A: §3.1 Expected Reaction 대비, 3G Gap Reaction ERR 또는 장중 ERR 중 사전 등록 = **Gap Reaction ERR**(A-1R 최초 반응) champion / 장중 5점 ERR challenger). Good Acceptance_t ↔ good e*(surprise_z > +0.3)의 ERR_z, Bad Resilience_t ↔ bad e*(< −0.3)의 ERR_z(부호 반전해 "버팀"=양). raw 수익률 사용 금지.
- challenger: W_digest=3(`IND-C1`), 유형별 창(FOMC 7·CPI/NFP/PCE 3·실적 5)(`IND-C2`).

### 2.3 구체 예시 — 2026년 9월 (2026-08-17 계산 예시값 — t0는 코드가 XKRX 캘린더로 동적 재계산, §12.5)
| 이벤트 | 발표(현지→KST) | t0_kr | 소화 창 | 판정 |
|---|---|---|---|---|
| US_NFP_20260904 | 9/4 08:30 ET → 9/4 21:30 | **9/7(월)** | 9/7~9/11 | 독립 (앞선 창 없음: PCE 8/26→t0 8/27 창 8/27~9/2) |
| US_CPI_20260911 | 9/11 08:30 ET → 9/11 21:30 | **9/14(월)** | 9/14~9/18 | 독립 (NFP 창 9/11 종료, 9/14 밖) |
| **FOMC_20260916** | 9/16 14:00 ET → 9/17 03:00 | **9/17(목)** | 9/17~9/23 | **비독립** — 9/17 ∈ CPI 창(9/14~9/18) → `OVERLAP_DIGEST_WINDOW`, `overlap_group = US_CPI_20260911` ("CPI 소화 중 FOMC") |
| US_PCE_20260930 | 9/30 08:30 ET → 9/30 21:30 | **10/1(목)** | 10/1~10/7 (10/1·2·5·6·7) | 독립 (FOMC 창 9/17~9/23 = 9/17·18·21·22·23, 추석 9/24·25 휴장은 창 밖) |
| US_NFP_20261002 | 10/2 → 10/2 21:30 | **10/5(월)** | 10/5~10/12 (10/9 한글날 휴장 → 10/5·6·7·8·12) | **비독립** — 10/5 ∈ PCE 창 |
| SEC_PRELIM_20261008(미확인) | 10/8 08:00 KST | 10/8 | 10/8~10/15 | **비독립** — 10/8 ∈ NFP 창(비독립 이벤트의 창도 후속 이벤트를 오염시킴 — 규칙: "앞선 **어떤** 이벤트의 창 안이면 비독립"). EARNINGS_CLUSTER 아님(NFP는 매크로) |
검증 쌍 예: MT_{9/16}(CPI 반응 9/14~16 반영) → e* = 9/17 FOMC는 비독립 → 건너뜀 → **e* = US_PCE_20260930(10/1)** → 쌍 (MT_{9/30}, PCE Gap Reaction ERR)로 추론 표본 1건, MT_{9/16..9/29}은 서술 전용. FOMC 반응 자체는 **상태 산출에는 전량 사용**(available_at 이후) — 검증 라벨로만 제외.

## 3. primitive 3-family — champion 전체 사양 (AM-10)

공통: 모든 z는 **스코프별·과거 전용 120거래일(t−1까지, 당일 제외)**(표본<60 → None), 클립 ±3 (§12.4 통일 규정). 이벤트 기반 값의 일별 상태화 = available_at ≤ t인 관측의 **EWMA(반감기 10거래일)**, `freshness = 0.5^(days_since_last_obs/10)`. 결측 None(0 대체 금지).

### 3.1 Reaction family (스코프별)
| 컴포넌트 | 정의 | 부호(양=우호) |
|---|---|---|
| **ERR_signed** | 등급A: Expected Reaction(종목별 독립: Implicit = 동일 event_type·\|Δsurprise_z\|<0.8 최근 5건 EWMA(hl 30) / Explicit = 최근 120일 OLS(surprise_z, vix_z, sox_shift_z, rate_change) + 전 이력 OLS shrinkage(α: 최근 30일 R²>0.3 → 0.5, else 0.8) / 결합 = attribution_quality q: q>0.85 → 0.7E+0.3I, q>0.7 → 0.5/0.5, else 0.2/0.8; expected_std = 정오표 A-1 유형별 rolling std). 반응 = **Gap Reaction**(A-1R). ERR_z × sign(surprise_z) EWMA | + |
| **beta_asym** | GoodBeta(good 이벤트 20일 창 Actual≈β·Expected, 클립[0.3,2]) − BadBeta, z | + |
| **transmission_asym** | 부품 10 β_up − β_down (§3.4), z | + |
| 최소 가용 | **1** (ERR 없으면 나머지로) | family_conf = n_avail/3 × freshness |

### 3.2 Price Acceptance family
| 컴포넌트 | 정의 | 부호 |
|---|---|---|
| shock_absorption_z | 부품 3 장중: 악재 1−\|t5\|/\|t2\|, 호재 t5/t2(t2=0 → None) → z | + |
| gap_hold_z | 3G gap_hold × sign(gap) → z (양의 갭 유지·음의 갭 되돌림 = +) | + |
| close_acceptance_z | 3G CLV z | + |
| psa_z | 부품 9 final만 (§4) | + |
| 최소 가용 | **2** | family_conf = n_avail/4 × freshness |

### 3.3 Participation family (일별)
| 컴포넌트 | 정의 | 부호 |
|---|---|---|
| flow_impact_residual_z | 부품 4 그대로 (KOSPI200 스코프 = KOSPI_MARKET, C-1 확정) | + |
| breadth_impulse_z | 부품 5 그대로(시장 공통) | + |
| semi_diffusion_z | 부품 5 diffusion 축: `diffusion_spread = semi_above20 − market_above20`의 5일 변화 z; 반도체 종목군 = KOSPI200 구성 중 KRX 업종 "반도체·반도체장비"(WICS 기준, 월초 asof 동결, T5 적재 시 목록 등재) | + |
| 최소 가용 | **2** | family_conf = n_avail/3 (freshness 1) |

### 3.4 부품 10 Semi Transmission (Reaction family 입력·진단 출력)
- 자산 j ∈ {SOXX, NVDA, MU, TSM} 일봉(yfinance adjusted), 정렬 = 등급C와 동일(세션 d ≤ t−1 엄격, 미국 휴장 재사용 → None).
- 종목 i ∈ {005930, 000660} 독립: `r_i(t)` = **close→close**(A-1R) 일간 수익률. β_ij(t) = 과거 60일 OLS(r_i ~ z_shock_j), 표본<40 None. **비대칭**: β_up(j 양의 충격일만, 25건↑)·β_down(음의 충격일만) 각각 60일 창 → **[§12.3로 대체·확정]** 회귀 구조 = 방법 A(SOXX 기준선 + NVDA/MU/TSM 잔차 충격 다변량 OLS), 비대칭 = SOXX 기준선 β_up − β_down. 가중 합성안(.4/.2/.2/.2)은 challenger TR-B. 출력: level β, change20 z, asym z. KOSPI200 스코프는 지수 수익률로 동일 산출(진단).
- diffusion(반도체 종목군 내 확산)과 별개 필드.

### 3.5 Energy (primitive만)
`Energy_t = round(100·tanh(Σ_f w_f·s_f / Σ_f w_f))`, f ∈ 가용 family, **w = Reaction .40 / Price Acceptance .35 / Participation .25**(사전 등록: 발주서 §0-3 "핵심 측정 = 반응"), s_f = family 가용 컴포넌트 클립 z의 단순 평균. **min 2 family**(아니면 None). **cap**: 절대 기여 share ≤ 0.6 — 정확한 알고리즘은 **§12.2**(재정규화·share 정의·초과분 재배분·미정의 처리). `energy_confidence = Σ w_f·conf_f/Σ w_f`. 진단: family 쌍 상관(120일) 기록. Lite 특례(min 2 컴포넌트)는 소급 Lite에만.
- challenger: `E-ORTH`(Gram–Schmidt 잔차화, 순서 R→P→PA), `E-EQ`(균등 가중), `E-NOCAP`. shadow 산출·비교만.

## 4. 부품 9 PSA — champion 정의·pending 처리 (AM-7)
- 충격 검출(마감 후): `|r_t| > k·σ20`(k=**2.5**, σ20 = 직전 20일 일간수익률 std, 과거 전용) **또는** `|gap_t| > 2.0·σ20_gap`. 방향 = sign.
- 관찰창 **W_psa = 5 거래일**(t+1~t+5). 최종 지표(t+5 마감): `level_hold = (min close_{t+1..t+5} − close_{t−1})/(close_t − close_{t−1})`(양 충격; 음 충격은 max close, 클립 [−1, 1.5]), `rebreak = any(low_{t+1..t+5} < low_t)`(음 충격은 high>high_t), `range_norm = mean(TR_{t+3..t+5})/mean(TR_{t−20..t−1})`, `vol_norm = mean(vol_{t+3..t+5})/mean(vol_{t−20..t−1})`. `psa_score = mean(z(level_hold), −z(rebreak), −z(range_norm), −z(vol_norm))`(가용 평균) × sign → psa_z(양 충격 유지·음 충격 회복 = +).
- **available_at = t+5 마감.** 그 전에는 `status=pending`, psa_z=None, **MT_s (s ≤ t+4)에 불사용**. 창 안에 새 충격이 오면 각각 독립 레코드, `overlap_shock=True` 표기(값은 그대로 확정).
- challenger `PSA-EARLY`(t+3 부분 관찰, shadow만), `PSA-K2`(k=2.0), `PSA-W7`.
- 스키마 `gold/psa_events`: shock_id, scope, shock_date, direction, k_sigma, status(pending|final), available_at, level_hold, rebreak, range_norm, vol_norm, psa_z, overlap_shock, engine_ver.

## 5. 상위 상태 — Good Acceptance / Bad Resilience (출력 전용, Energy 입력 아님)
증거 6종(스코프별, EWMA hl 10, available_at ≤ t):
| Good Acceptance | Bad Resilience |
|---|---|
| ERR_z of good 이벤트 | −ERR_z of bad 이벤트(버팀 = +) |
| z(GoodBeta − 1) | z(1 − BadBeta) |
| shock_absorption_z(good) | shock_absorption_z(bad) |
| gap_hold_z(양의 갭) | gap_hold_z(음의 갭 되돌림) |
| psa_z(양 충격, final) | psa_z(음 충격, final) |
| flow_impact_residual_z(good 이벤트일) | flow_impact_residual_z(bad 이벤트일) |
- `score = round(100·tanh(mean(가용 증거 z)))`, **가용 증거 < 2 → None + status "insufficient"**.
- **`available_evidence`** = 가용 증거 이름 목록, **`evidence_n`** = 창 안의 원 관측 건수 합(이벤트·충격 수), **`state_confidence = round(100 × (n_avail/6) × (0.5 + 0.5·agreement) × freshness)`**, agreement = 점수와 부호가 같은 증거 비율, freshness = 가장 최근 관측 기준 0.5^(days/10). 예: 증거 1개(ERR)만 +80 → conf ≈ 100×(1/6)×1×f ≤ 17 / ERR+Shock+Gap+Flow 4개 일치 +80 → ≈ 100×(4/6)×1×f ≤ 67.
- GoodBeta/BadBeta는 Reaction family 원재료로 **별도 필드 보존**(상위 상태가 대체하지 않음).

## 6. 출력 산식 champion (ΔMT · Divergence · Regime · 텍스트)
- **ΔMT** = 정오표 A-6·AM-2의 `delta_from_history(Energy)`: 최근 **5일** OLS 기울기 → 최근 창 **이전** 60일 일변화 분포 z(std 하한 1.0) × 20, 클립 ±100. challenger `DMT-C1` EMA3−EMA10, `DMT-C2` 3일 기울기.
- **Price–MT Divergence** = `z_slope20(Energy) − z_slope20(ln close)`: 각 20일 OLS 기울기를 자기 과거 120일 기울기 분포(당일 제외)로 z, 차이. 라벨: div ≥ +1 & 가격 기울기 z < 0 → "양의 다이버전스", ≤ −1 & 가격 z > 0 → "음의". **Energy·Regime 입력 재투입 금지**(자기참조 차단 — 코드에서 Regime/Energy 함수 시그니처에 div 인자 없음). challenger `DIV-C1` 10일, `DIV-C2` 레벨(z(E 20일 평균) − z(r20)).
- **Regime(느린 층)**: 입력 = EMA20(Energy)·ΔMT·Bad Resilience·Good Acceptance·breadth 레벨. 4계절 점수 = 스펙 부품 7 규칙, 정오표 A-2(합=1·fallback·감점)·A-3(전환 임계 .15, 2일 연속). Regime은 빠른 층(Energy·ΔMT·Good/Bad)을 덮지 못함.
- **텍스트 템플릿(반대 신호 병기 의무)**: `"{Regime} 유지 ({p:.0%})"` + 빠른 층 부호가 Regime과 어긋나면 반드시 `" / 그러나 {근거들} — {해석}"`. 예: Winter이고 Bad Resilience ≥ +50 이고 div ≥ +1 → "Winter 유지 / 그러나 악재 내성 급개선(+62, conf 58)·MT 양의 다이버전스(+1.4) — 강한 해빙 신호". 근거는 available_evidence·state_confidence 병기.

## 7. 스키마 요약 (신규·변경)
- `silver/consensus_registry`: + `t0_kr, digest_window_end, independence_flag, overlap_group, contamination_reason, verify_eligible`
- `gold/reaction_panel`(스코프·일): expected_gap, gap_reaction_err_z, err_signed_ewma, good_beta, bad_beta, beta_asym_z, transmission_{level_j, change_z_j, asym_z}, family_score_R, family_conf_R, freshness_R
- `gold/price_accept_panel`: shock_absorption_z, gap_hold, gap_hold_z, close_acceptance_z, psa_z, family_score_PA, family_conf_PA
- `gold/participation_panel`: flow_impact_residual_z, breadth_impulse_z, semi_diffusion_z, family_score_P, family_conf_P
- `gold/psa_events` (§4), `gold/us_shocks`(SOXX·NVDA·MU·TSM 정렬값)
- `gold/mt_state`(스코프·일): energy, energy_confidence, delta_mt, good_acceptance, good_state_confidence, good_evidence_n, good_available_evidence, bad_resilience, bad_*, regime_probs(4), regime_label, transition, divergence, divergence_label, text, families_used, engine_ver, `available_at=t 마감`
- `gold/challengers/*`: 등록된 challenger 산출(shadow)
- 모든 가격 컬럼 `price_adjusted` 유지(C-2), 이벤트 `t0_mode` 유지(C-3: 국내 A1_open — 3G는 A-1R로 갭을 "반응"으로 기록하되 t0_mode 값은 불변).

## 8. 판정 3분법과 n 사전 등록 (Gate R2·T5.5에 적용)
| 항목 | 라벨 | n_operational | n_inference | 근거 |
|---|---|---|---|---|
| Good Acceptance 재현성 | good e* ERR_z (스코프별) | 5 | **40** | Spearman ρ=.4, α .05 단측, 검정력 .8 → n≈37 |
| Bad Resilience 재현성 | bad e* ERR_z | 5 | 40 | 동일 |
| Energy(family) 작동 | 3 family 가용일 비율 ≥ 80% | 60거래일 | — | 작동 항목 |
| PSA 작동·재현성 | final 충격 수 / psa_z ↔ 이후 30일 안정성(서술) | 5 | 30 | |
| Transmission 안정성 | β 표본 40↑ 일수 | 60거래일 | — | |
| Regime 전환 | 전환 건수 | 3 | 20 | 서술 전용 예상 |
- 판정: n < n_inference → **INSUFFICIENT**(FAIL 아님, PASS 승격 불가). 효과 판정 통계 = Spearman + 정상 블록 부트스트랩(Gate R1과 동일 방법, 시드 사전 등록).

## 9. T5.5(12개월 소급) 사전 표기
- 일봉만 쓰는 부품(3G·PSA·Transmission·diffusion·flow·breadth)은 **3년 소급 가능**, 장중 부품 3은 KIS 12개월. 등급A는 라이브 시작일부터 → 소급 구간의 Reaction family는 등급C(전일밤 SOX 갭 기준)뿐.
- 예상 표본: 등급C "이벤트"는 매일이라 W_digest=5 purge 후 연 ≈45건/스코프, good/bad 분할 ≈22 → **n_inference 40 미달 → Good/Bad 재현성 항목은 "서술 전용"** 사전 표기. 작동 항목(Energy 가용률·PSA final 수·Transmission 표본)은 판정 가능.
- T5.5 사전 등록 문서는 T5 구현 후 별도 제출(측정 전).

## 10. challenger 등록부 (shadow 전용, champion 교체 불가)
IND-C1·IND-C2 / E-ORTH·E-EQ·E-NOCAP / PSA-EARLY·PSA-K2·PSA-W7 / DMT-C1·DMT-C2 / DIV-C1·DIV-C2 / SHRINK-H(hierarchical shrinkage, 종목 pooling) / ERR-INTRADAY(장중 5점 ERR 라벨).

## 11. 구현 순서·소요 [추정]
| 단계 | 내용 | 소요 |
|---|---|---|
| T5-1 | 이벤트 독립성 모듈(t0_kr·창·flag·purge)·스키마·9월 실례 테스트 | 2일 |
| T5-2 | 미국 4자산 일봉 적재 + 3G(일봉) + 부품 10 Transmission | 3일 |
| T5-3 | 부품 9 PSA(pending/final·available_at) | 2일 |
| T5-4 | 부품 5 diffusion 축(반도체 종목군 asof) | 1일 |
| T5-5 | family 결합·Energy·상위 상태(conf 필드)·ΔMT·Divergence·Regime·텍스트 + challenger shadow | 4일 |
| T5-6 | 등급A 전진: 부품 0~2 Expected Reaction(종목 독립)·장중 부품 3(KIS 분봉 축적기, 전용 키)·라이브 크론(홈PC)·loud-failure | 4일 |
| T5.5 사전 등록 문서 | 위 §8·§9 | 1일 |
| 합계 | | ≈ 3.5주 |

*제출: 승인 후 구현. 승인 시 §2·§3·§4·§5·§6·§8의 상수는 `config/mtpro.yaml`로 옮겨 사전 등록으로 고정하고 모듈 상수 일치 테스트를 붙인다.*

---

## 12. 조건부 승인 마감 5건 (2026-08-17, 발주자 검토 반영 — champion 의미 고정, 새 설계 아님)

### 12.1 `n_inference = 40`의 통계 조건·다중검정 규칙
- **Good/Bad 재현성 (주 endpoint)**: H1 방향 사전 등록(Good Acceptance_t ↑ → good e* ERR_z ↑ / Bad Resilience_t ↑ → bad e* "버팀" ERR_z ↑), **one-sided α=.05, power=.80, target ρ=.40, Spearman → Fisher-z 근사 n≈38 → n_inference=40**. (검산: n = ((z_α+z_β)/atanh ρ)²+3 = ((1.645+0.842)/0.4236)²+3 = 37.5; 양측 .05·단측 .025면 46.8 → 47.)
- **다중검정 champion(발주자 확정)**: **주 endpoint 2개(Good Acceptance 재현성·Bad Resilience 재현성)만 Gate 판정**, 나머지 inference 항목(PSA·Transmission·Regime·IC 등)은 **secondary — 기록·서술만**. 스코프 3개는 각 endpoint를 스코프별 one-sided α=.05로 판정하고 Gate PASS = 3스코프 모두 두 endpoint 유의(Gate R1 "3스코프 모두" 준용). 추가 보정(Holm/FDR)은 **채택하지 않음**(검토 기록: Holm m=2 적용 시 n=40 검정력 ≈.73 — 지시에 없어 미채택, 사실만 병기).
- 검정 통계 = Spearman + 정상 블록 부트스트랩(Gate R1 동일, 시드 사전 등록). p값은 부트스트랩 단측.

### 12.2 family contribution cap 0.6 — 정확한 알고리즘
1. family score `s_f` = 가용 컴포넌트 클립 z(±3)의 단순 평균 → **범위 [−3, 3]**.
2. 가용 family 집합 A(|A| ≥ 2)에 대해 가중 재정규화 `w'_f = w_f / Σ_{g∈A} w_g` (원 가중 R .40 / PA .35 / P .25).
3. 기여 `c_f = w'_f · s_f`, **절대 기여 share** `share_f = |c_f| / Σ_{g∈A} |c_g|`.
4. `max share_f > 0.6`이면 (2 family면 항상 큰 쪽 검사): `c_f ← sign(c_f) · 1.5 · Σ_{g≠f}|c_g|` (share를 정확히 0.6으로 만드는 값), **초과분 `excess = |c_f_원| − |c_f_cap|`은 나머지 available family에 `|c_g|` 가중비례로 재배분 1회** (`c_g ← c_g · (1 + excess/Σ_{g≠f}|c_g|)`, 부호 유지).
4b. **재배분 후 재검사(1회)**: 어느 family든 share > 0.6이면 그 family를 `sign·1.5·Σ_{others}|c|`로 cap하고 **잔여분은 버림**(재배분 없음). 예: c=(0.99, 0.01, 0) → 1차 cap 후 2번 family가 0.985(share .98) → 4b에서 cap·잔여 폐기. 이후 반복 없음.
5. `Σ_{g≠f}|c_g| < 1e-9`(다른 family 기여 0)이면 cap 미적용·`cap_undefined=True` 기록.
6. `Energy = round(100·tanh(Σ_f c_f))`. 양·음 상쇄 시에도 share는 절대값 기준(위 3).
- 출력 필드: `family_share_{R,PA,P}`, `cap_applied`, `cap_family`, `cap_undefined`.

### 12.3 Semi Transmission 회귀 구조 — champion **방법 A(섹터 기준선 + 잔차 충격)**
- 충격 정렬: 세션 d ≤ t−1 엄격(등급C와 동일). `z_j` = 자산 j 야간 수익률의 z(과거 120일, t−1까지).
- **1단계(직교화)**: j ∈ {NVDA, MU, TSM}: `resid_j(t) = z_j(t) − b_j·z_SOXX(t)`, b_j = 과거 120일 OLS(t−1까지, 표본<60 None).
- **2단계(종목별 독립, close→close A-1R)**: `r_i ~ β_i,SOXX·z_SOXX + β_i,NVDA·resid_NVDA + β_i,MU·resid_MU + β_i,TSM·resid_TSM` **하나의 다변량 OLS**, 60일 창(과거 전용, 표본<40 None). raw 4변수 동시 투입 금지.
- **비대칭**: SOXX 기준선만 부호 분할 — `β_up`(z_SOXX>0 일, 표본≥25)·`β_down`(z_SOXX<0) 각각 60일 창 단변량 OLS(잔차 항 포함 다변량의 SOXX 계수) → **`transmission_asym_i = β_up − β_down`** → z. 잔차 자산의 비대칭은 진단 출력만.
- 출력: `beta_soxx, beta_resid_{nvda,mu,tsm}, beta_change20_z(각), beta_up, beta_down, transmission_asym_z`. 이전 문안의 가중 합성(.4/.2/.2/.2)은 폐기 → **challenger `TR-B`**(단변량 β 4개 + 사전 정의 combiner)로 등록. **raw 4변수 동시 OLS는 champion·challenger 모두 불채택**(계수 불안정, 발주자 확정).

### 12.4 기준시점 잠금 — PSA σ·Divergence z
- **PSA**: `σ20 = std(r_{t−20..t−1})` (충격일 t 제외, 과거 전용, 표본 20 미만 None) · `σ20_gap = std(gap_{t−20..t−1})` 동일. `range_norm/vol_norm` 분모도 t−20..t−1.
- **Divergence**: 20일 기울기(Energy·ln close, 당일 포함 t−19..t)를 **직전 120거래일 기울기 분포(t−1까지, 당일 제외, 표본<60 None)** 로 z. 60/252일 창은 challenger(`DIV-C3` 60, `DIV-C4` 252)로만.
- 통일 규정: 계획서의 모든 "z(120일)"는 **t−1까지의 과거 전용 창, 표본<60 None** 을 뜻한다(§3 공통 규정에 명시).

### 12.5 이벤트 t0 동적 매핑 + 삼성 10/8 tentative
- **t0_kr 계산 규칙(코드)**: `event_ts(UTC) → Asia/Seoul → 그 시각 이후 최초 XKRX 세션 개장(09:00)`. 거래일 캘린더 = `exchange_calendars` XKRX(휴장·대체공휴일 반영) champion, 폴백 = 관측 거래일(bronze ohlcv_adj 날짜) + 알림. 문서의 9월 날짜(§2.3)는 **2026-08-17 계산 예시값**이며 코드가 매 실행 시 재계산·불일치 시 loud-failure. 소화 창·PSA 창·검증 창의 "거래일" 세기도 같은 캘린더.
- 필드명 **`schedule_status ∈ {confirmed, unconfirmed, tentative}`**. `SEC_PRELIM_20261008`은 **tentative**(삼성 IR 공식 일정은 2Q까지) — 공식 공지 시 confirmed 전환, 그 전 verify_eligible=False, **D-7 재확인 체크 연동**(unconfirmed·tentative 모두). HYNIX·NVDA 11월도 동일.

*12.1~12.5 반영으로 조건부 승인 조건 충족 → T5-1 구현 착수.*
