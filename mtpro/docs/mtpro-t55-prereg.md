# MT-PRO T5.5 — 사전 등록 문서 (측정 전 제출본, 2026-08-17)

- 지위: **측정 전 제출.** 발주자 승인 후에만 측정. 승인 뒤 정의·구간·판정 규칙 변경 불가(변경은 amendment로만). WO-001·`mtpro-t5-plan.md` §2·§8·§9·§12.1, WORKORDER AM-9·판정 3분법을 그대로 따른다.
- 대상: T5 champion(3-family Energy·상위 상태·3G·PSA·Transmission·diffusion·장중 absorption)의 **소급 12개월(분봉 창) + 3년(일봉 부품) 작동·재현성 서술**. Gate R1 소진 표본(2023-01~2026-06)은 **어떤 채택 근거로도 재사용하지 않는다** — 이 문서의 3년 구간 서술은 "작동 확인(n_operational)"과 서술 전용 통계에만 쓰이며 PASS 근거가 되지 않는다.
- 판정 3분법: **PASS / FAIL / INSUFFICIENT.** n < n_inference = INSUFFICIENT(FAIL 아님, PASS 승격 불가). "방향이 좋아 보임" 금지.

## 1. 구간·데이터
| 트랙 | 구간 | 재료 |
|---|---|---|
| 분봉 12개월 | 2025-08-18 ~ 2026-08-14 (KIS 축적 243세션, 005930·000660) | 장중 absorption(부품 3), 3G, PSA, Transmission, flow, breadth, diffusion → mt_state |
| 일봉 3년 | 2023-01-03 ~ 2026-08-14 | 위에서 absorption 제외 전부(3G·PSA·Transmission·diffusion·flow·breadth) — **서술·작동 확인 전용** |
- 이벤트: 등급A는 **0건**(라이브 시작 전) → 소급 구간의 Reaction family ERR은 등급C(전일밤 ^SOX **갭 기준** gap_reaction_err_z, A-1R 계열). 검증 라벨(§3)도 등급C 이벤트만 존재.
- 라벨 e*는 T5-1 규칙(t0 XKRX 동적, W_digest 5, SAME_DAY/OVERLAP/EARNINGS_CLUSTER, verify_eligible)으로 산출 — 등급C "이벤트"는 매 거래일이므로 소화 창 규칙상 **연속 5일 중 첫날만 독립**(예상 ≈45건/년/스코프, good/bad ≈22 각).

## 2. 항목별 n 사전 등록 (계획서 §8 그대로) 및 사전 예상
| 항목 | 라벨 | n_operational | n_inference | 12개월 예상 n [추정] | 사전 표기 |
|---|---|---|---|---|---|
| **A1** Good Acceptance 재현성 (주 endpoint) | good e* Gap Reaction ERR_z | 5 | 40 | ≈22/스코프 | **INSUFFICIENT → 서술 전용** 사전 선언 |
| **A2** Bad Resilience 재현성 (주 endpoint) | bad e* ERR_z(버팀=+) | 5 | 40 | ≈22 | 동일 |
| B1 family Energy 작동 | 3 family 가용일 비율 ≥80% | 60거래일 | — | 243일 | 판정 가능(작동) |
| B2 PSA 작동·재현성 | final 충격 수 / psa_z ↔ 이후 30일 안정성(서술) | 5 | 30 | 12개월 ≈20~24/스코프 (3년 95~100) | 작동 판정 가능, 재현성 서술 |
| B3 Transmission 안정성 | β 표본 40↑ 일수 | 60거래일 | — | 충족 예상 | 판정 가능 |
| B4 Regime 전환 | 전환 건수 | 3 | 20 | 12개월 1~3 | 서술 전용 |
| B5 장중 absorption 작동 | t1~t5 결측 0 비율 | 60이벤트일 | — | 243일 | 판정 가능 |
- **Gate 판정은 주 endpoint A1·A2뿐**(WO-001 ①). B는 secondary — 기록·서술. 12개월 등급C 표본으로는 A1·A2가 n_inference 미달이 사전 예상되므로 **T5.5의 결과는 INSUFFICIENT/서술**이 기본이며, PASS/FAIL 선언은 Gate R2(라이브 등급A 누적)에서만.

## 3. AM-9 재현성 측정 정의 (주 endpoint, 사전 등록)
- 상태 = `mt_state.good_acceptance` / `bad_resilience`(스코프별, t 마감 확정, state_confidence·evidence_n 병기). 라벨 = e*의 `gap_reaction_err_z`(등급A면 expected_reaction 기반, 등급C면 gap3g의 등급C 값 — 12개월 소급은 후자). Bad는 부호 반전(버팀 = 양).
- 검증 쌍 = e*당 1쌍(t = e*.t0_kr 직전 세션의 상태). 상태 None/insufficient인 쌍은 제외·건수 기록.
- 통계 = Spearman(state, label) **단측(H1: 양)**, α=.05, 정상 블록 부트스트랩(블록 5, 2,000회, seed 20260817) 95% CI. PASS = 3스코프(KOSPI200·005930·000660) 모두 IC>0 ∧ CI 하한>0(n ≥ 40일 때만 판정). 검정력 .80 표본 = 40(단측), 참고 47(양측).
- 순열 귀무(2,000회) 백분위 보고 의무. 다중검정 = 주 endpoint 2개만(추가 보정 없음).
- **판정 수치 예시(WO-001 ②, 해석 기준용)**: Bad Resilience_t = +70 상태에서 이후 최초 독립 악재 — Expected −3.5% vs Actual −1.2% → ERR_z 양(버팀) = 재현성 **지지** / Expected −2.0% vs Actual −5.0% → ERR_z 음 = 재현성 **기각**. 판정 자체는 위 산식(스코프별 Spearman·CI)으로만.
- 종속값에 raw 수익률 사용 금지. 2차 기록: 상태 vs 익일/익월 수익률 IC(서술만).

## 4. 룩어헤드·None·소진 표본 규칙
- P4형 절단 재산출(무작위 절단일 8개, seed 20260817)로 mt_state·상위 상태가 절단일 이하 비트 동일 → 위반 0. PSA pending 미사용·available_at 규칙 검사.
- None 유지: 상위 상태 insufficient 비율·Energy None 비율 보고, 0 대체 grep.
- 소진 표본: 3년 일봉 구간 통계는 표에 "descriptive(exhausted-sample overlap)" 태그를 붙여 PASS 근거로 인용 불가.

## 5. 산출물
`docs/mtpro-t55-result.md`(A1·A2 표: n·IC·CI·귀무 백분위·판정 3분법 / B 서술표 / 절단 재산출 로그 / INSUFFICIENT 선언 재수록) + `logs/t55_summary.json`. 코드 `gate/t55.py`는 승인 후 작성, 실행 전 이 문서 §2·§3 상수 블록 대조.

```yaml
t55:
  windows: {minute: [2025-08-18, 2026-08-14], daily_descriptive: [2023-01-03, 2026-08-14]}
  primary_endpoints: [good_acceptance_reproducibility, bad_resilience_reproducibility]
  n_operational: 5
  n_inference: 40
  test: {ic: spearman, sided: one, alpha: 0.05, power: 0.80, rho: 0.40, bootstrap: {block: 5, n: 2000, seed: 20260817}, permutation: {n: 2000, seed: 20260817}}
  pass_rule: all_3_scopes_ic_gt0_and_ci_low_gt0
  insufficient_rule: n_lt_n_inference
  lookahead_truncation: {n_cutoffs: 8, seed: 20260817}
```
*제출: 측정 전. 승인 후 측정.*
