# MT-PRO T4 — Gate R1 측정 결과 (2026-08-17)

- 사전 등록: `docs/mtpro-t4-gate-r1-prereg.md` (§6 상수 블록 ↔ `src/mtpro/gate/r1.py::PREREG` 대조 통과). 측정 코드 `src/mtpro/gate/r1.py` + `jobs/run_gate_r1.py`, 원본 수치 `logs/gate_r1_summary.json`.
- 데이터: `D:\vivecoding\test project_0613\mtpro\data` — flow_panel 2646행 2023-01-03~2026-08-14 (flow-0.1), breadth_panel 882행 2023-01-03~2026-08-14 (breadth-0.1), gradec_panel 2646행 2023-01-03~2026-08-14 (gradec-0.1), energy_lite_panel 2646행 2023-01-03~2026-08-14 (energy_lite-0.1).
- 관문 구간 신호일 2023-01-03~2026-06-30, 라벨은 구간 밖 허용. 부트스트랩 2000회·순열 2000회·seed 20260817. 실행 79.2s.

## 최종 판정: **FAIL**

| 항목 | 판정 |
|---|---|
| P1 | FAIL |
| P2 | FAIL |
| P3-a | PASS |
| P3-b | FAIL |
| P4 | PASS |
| P5 | FAIL |

부분 충족 = FAIL (사전 등록 §1 다중 스코프 규칙). 어떤 조건도 재해석하지 않았다.

## P1 — FlowImpactResidual_z vs 익일 수익률 (IC_1, 블록 10)

| scope | 유효 n (구간 대비) | IC_1 | 95% CI | CI 0 제외 | 귀무 백분위 | 판정 |
|---|---|---|---|---|---|---|
| KOSPI200 | 713 (83.9%) | -0.0218 | [-0.0870, 0.0479] | False | 27.1 | FAIL |
| 005930 | 713 (83.9%) | -0.0629 | [-0.1282, 0.0051] | False | 4.2 | FAIL |
| 000660 | 713 (83.9%) | -0.1042 | [-0.1691, -0.0389] | True | 0.1 | FAIL |

판정: **FAIL** — 조건: 3스코프 모두 CI 0 제외 AND IC_1 > 0.

## P2 — BreadthImpulse_z vs KOSPI200 21거래일 선행 수익률 (IC_21, 블록 21)

| 대상 | 유효 n (구간 대비) | IC_21 | 95% CI | CI 하한>0 | 귀무 백분위 | 판정 |
|---|---|---|---|---|---|---|
| KOSPI200 (판정) | 850 (100.0%) | -0.0403 | [-0.2089, 0.1090] | False | 13.6 | FAIL |
| 005930 (보조 서술) | 850 (100.0%) | -0.0409 | [-0.1856, 0.1088] | False | 12.0 | (서술) FAIL |
| 000660 (보조 서술) | 850 (100.0%) | 0.0413 | [-0.1109, 0.1837] | False | 89.3 | (서술) FAIL |

판정: **FAIL** — 조건: KOSPI200 IC_21 > 0 AND CI 하한 > 0.

## P3-a — Energy-Lite vs baseline ①② Pearson 상관 (|ρ| < 0.9, 6개 전부)

| scope | ① (MA20−MA60)/MA60: ρ (n) | ② above_20d_ratio: ρ (n) | 판정 |
|---|---|---|---|
| KOSPI200 | 0.0007 (795) | 0.5375 (795) | PASS |
| 005930 | 0.0787 (795) | 0.5028 (795) | PASS |
| 000660 | 0.0769 (795) | 0.5041 (795) | PASS |

판정: **PASS**

## P3-b — Energy-Lite 자체 IC_21 (스코프별 자기 수익률, 블록 21)

| scope | 유효 n (구간 대비) | IC_21 | 95% CI | CI 하한>0 | 귀무 백분위 | 판정 |
|---|---|---|---|---|---|---|
| KOSPI200 | 795 (93.5%) | -0.0377 | [-0.1931, 0.1077] | False | 15.4 | FAIL |
| 005930 | 795 (93.5%) | -0.0183 | [-0.1666, 0.1221] | False | 30.6 | FAIL |
| 000660 | 795 (93.5%) | -0.0310 | [-0.1705, 0.1042] | False | 19.9 | FAIL |

판정: **FAIL** — 조건: 3스코프 모두 IC_21 > 0 AND CI 하한 > 0. P3 종합 = **FAIL**.

### 보조 서술 (판정 불사용): 5거래일 지평 IC · baseline ①② IC_21

| scope | Energy-Lite IC_5 (n) [CI] | baseline① IC_21 (n) [CI] | baseline② IC_21 (n) [CI] |
|---|---|---|---|
| KOSPI200 | -0.0562 (795) [-0.1681, 0.0537] | 0.1683 (850) [-0.0917, 0.3589] | -0.0157 (850) [-0.2139, 0.1436] |
| 005930 | -0.1475 (795) [-0.2453, -0.0507] | 0.2721 (850) [-0.0333, 0.4819] | 0.0878 (850) [-0.0777, 0.2328] |
| 000660 | -0.0234 (795) [-0.1270, 0.0829] | -0.1610 (850) [-0.3695, 0.0274] | 0.0329 (850) [-0.1126, 0.1702] |

## 연도별 fold IC 서술표 (재학습 없음, 판정 불사용)

| 항목 | 2023 | 2024 | 2025 | 2026H1 |
|---|---|---|---|---|
| P1 flow IC_1 KOSPI200 | 0.047 (n=107) | 0.020 (n=244) | -0.092 (n=242) | -0.153 (n=120) |
| P1 flow IC_1 005930 | -0.017 (n=107) | 0.005 (n=244) | -0.112 (n=242) | -0.140 (n=120) |
| P1 flow IC_1 000660 | -0.099 (n=107) | -0.177 (n=244) | -0.075 (n=242) | -0.072 (n=120) |
| P2 breadth IC_21 KOSPI200 | -0.177 (n=244) | -0.293 (n=244) | 0.122 (n=242) | 0.331 (n=120) |
| P2 breadth IC_21 005930 (aux) | -0.218 (n=244) | -0.219 (n=244) | 0.138 (n=242) | 0.403 (n=120) |
| P2 breadth IC_21 000660 (aux) | -0.183 (n=244) | 0.035 (n=244) | 0.140 (n=242) | 0.270 (n=120) |
| P3-b energy IC_21 KOSPI200 | -0.223 (n=189) | -0.296 (n=244) | -0.055 (n=242) | 0.147 (n=120) |
| P3-b energy IC_21 005930 | -0.218 (n=189) | -0.237 (n=244) | 0.026 (n=242) | 0.163 (n=120) |
| P3-b energy IC_21 000660 | -0.254 (n=189) | -0.053 (n=244) | 0.012 (n=242) | 0.101 (n=120) |

## P4 — Lookahead violations

### (a) 절단 재산출 — 절단일 12개 (seed 20260817): 2023-02-07, 2023-04-27, 2023-07-10, 2023-08-22, 2023-09-07, 2025-03-10, 2025-03-25, 2025-04-14, 2025-07-09, 2025-07-22, 2026-01-27, 2026-04-24

| 절단일 | 파이프라인 | flow 비교/상이 | breadth 비교/상이 | gradec 비교/상이 | energy 비교/상이 | 절단본 최종일(행) | 위반 | 초 |
|---|---|---|---|---|---|---|---|---|
| 2023-02-07 | ok | 72/0 | 24/0 | 72/0 | 72/0 | 2023-02-07 (72) | 0 | 4.8 |
| 2023-04-27 | ok | 240/0 | 80/0 | 240/0 | 240/0 | 2023-04-27 (240) | 0 | 4.5 |
| 2023-07-10 | ok | 384/0 | 128/0 | 384/0 | 384/0 | 2023-07-10 (384) | 0 | 4.5 |
| 2023-08-22 | ok | 474/0 | 158/0 | 474/0 | 474/0 | 2023-08-22 (474) | 0 | 4.7 |
| 2023-09-07 | ok | 510/0 | 170/0 | 510/0 | 510/0 | 2023-09-07 (510) | 0 | 4.8 |
| 2025-03-10 | ok | 1593/0 | 531/0 | 1593/0 | 1593/0 | 2025-03-10 (1593) | 0 | 6.2 |
| 2025-03-25 | ok | 1626/0 | 542/0 | 1626/0 | 1626/0 | 2025-03-25 (1626) | 0 | 6.0 |
| 2025-04-14 | ok | 1668/0 | 556/0 | 1668/0 | 1668/0 | 2025-04-14 (1668) | 0 | 6.2 |
| 2025-07-09 | ok | 1839/0 | 613/0 | 1839/0 | 1839/0 | 2025-07-09 (1839) | 0 | 6.7 |
| 2025-07-22 | ok | 1866/0 | 622/0 | 1866/0 | 1866/0 | 2025-07-22 (1866) | 0 | 6.4 |
| 2026-01-27 | ok | 2244/0 | 748/0 | 2244/0 | 2244/0 | 2026-01-27 (2244) | 0 | 7.5 |
| 2026-04-24 | ok | 2421/0 | 807/0 | 2421/0 | 2421/0 | 2026-04-24 (2421) | 0 | 7.2 |

합계 위반 행 = **0**, 파이프라인 실패 0건, 소요 69.7s → PASS.

### (b) SOX 정렬 — gradec_panel 2646행 중 세션 있는 2646행, `sox_session_date ≤ t−1` 위반 **0** (max session−t = -1일; status {'ok': 2559, 'reused': 87}) → PASS

### (c) fetch_ts ≤ 산출 시각 — 산출 시각(gold mtime 최솟값, UTC) 2026-08-17T10:34:18+00:00; bronze fetch_ts 최댓값 constituents 2026-08-17 10:21:20, investor_flow 2026-08-17 10:20:32, investor_flow_constituents 2026-08-17 10:27:55, market_cap 2026-08-17 10:21:20, ohlcv_adj 2026-08-17 10:20:43, ohlcv_adj_constituents 2026-08-17 10:22:15, ohlcv_unadj 2026-08-17 10:20:36, sox_daily 2026-08-17 10:13:41 → 위반 **0** → PASS

P4 종합: **PASS**

## P5 — 결측 None 유지 (0 대체 없음)

### (i) 정확히 0.0 비율 (분모 = non-None) — 한도 0.500% → PASS

| 컬럼 | non-None | 0.0 개수 | 비율 | 한도 내 | 소명 |
|---|---|---|---|---|---|
| flow_panel.flow_beta_foreign[000660] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_beta_foreign[005930] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_beta_foreign[KOSPI200] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_beta_inst[000660] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_beta_inst[005930] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_beta_inst[KOSPI200] | 804 | 0 | 0.00% | True |  |
| flow_panel.flow_impact_residual_z[000660] | 745 | 0 | 0.00% | True |  |
| flow_panel.flow_impact_residual_z[005930] | 745 | 0 | 0.00% | True |  |
| flow_panel.flow_impact_residual_z[KOSPI200] | 745 | 0 | 0.00% | True |  |
| flow_panel.flow_trend_z[000660] | 799 | 0 | 0.00% | True |  |
| flow_panel.flow_trend_z[005930] | 799 | 0 | 0.00% | True |  |
| flow_panel.flow_trend_z[KOSPI200] | 799 | 0 | 0.00% | True |  |
| breadth_panel.breadth_impulse_z | 882 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox_raw[000660] | 859 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox_raw[005930] | 859 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox_raw[KOSPI200] | 859 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox[000660] | 859 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox[005930] | 859 | 0 | 0.00% | True |  |
| gradec_panel.beta_sox[KOSPI200] | 859 | 0 | 0.00% | True |  |
| gradec_panel.err_z[000660] | 471 | 0 | 0.00% | True |  |
| gradec_panel.err_z[005930] | 471 | 0 | 0.00% | True |  |
| gradec_panel.err_z[KOSPI200] | 471 | 0 | 0.00% | True |  |
| gradec_panel.good_acceptance_z[000660] | 814 | 0 | 0.00% | True |  |
| gradec_panel.good_acceptance_z[005930] | 814 | 0 | 0.00% | True |  |
| gradec_panel.good_acceptance_z[KOSPI200] | 814 | 0 | 0.00% | True |  |
| gradec_panel.bad_resilience_z[000660] | 781 | 0 | 0.00% | True |  |
| gradec_panel.bad_resilience_z[005930] | 781 | 0 | 0.00% | True |  |
| gradec_panel.bad_resilience_z[KOSPI200] | 781 | 0 | 0.00% | True |  |
| gradec_panel.good_beta[000660] | 827 | 0 | 0.00% | True |  |
| gradec_panel.good_beta[005930] | 827 | 0 | 0.00% | True |  |
| gradec_panel.good_beta[KOSPI200] | 827 | 0 | 0.00% | True |  |
| gradec_panel.bad_beta[000660] | 721 | 0 | 0.00% | True |  |
| gradec_panel.bad_beta[005930] | 721 | 0 | 0.00% | True |  |
| gradec_panel.bad_beta[KOSPI200] | 721 | 0 | 0.00% | True |  |
| energy_lite_panel.flow_z[000660] | 745 | 0 | 0.00% | True |  |
| energy_lite_panel.flow_z[005930] | 745 | 0 | 0.00% | True |  |
| energy_lite_panel.flow_z[KOSPI200] | 745 | 0 | 0.00% | True |  |
| energy_lite_panel.breadth_z[000660] | 882 | 0 | 0.00% | True |  |
| energy_lite_panel.breadth_z[005930] | 882 | 0 | 0.00% | True |  |
| energy_lite_panel.breadth_z[KOSPI200] | 882 | 0 | 0.00% | True |  |
| energy_lite_panel.gradec_err_z[000660] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.gradec_err_z[005930] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.gradec_err_z[KOSPI200] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.energy_lite[000660] | 827 | 9 | 1.09% | False | 0행 9개 전부 재계산 0·가용≥2: True |
| energy_lite_panel.energy_lite[005930] | 827 | 8 | 0.97% | False | 0행 8개 전부 재계산 0·가용≥2: True |
| energy_lite_panel.energy_lite[KOSPI200] | 827 | 6 | 0.73% | False | 0행 6개 전부 재계산 0·가용≥2: True |
| energy_lite_panel.good_acceptance_z[000660] | 814 | 0 | 0.00% | True |  |
| energy_lite_panel.good_acceptance_z[005930] | 814 | 0 | 0.00% | True |  |
| energy_lite_panel.good_acceptance_z[KOSPI200] | 814 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_resilience_z[000660] | 781 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_resilience_z[005930] | 781 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_resilience_z[KOSPI200] | 781 | 0 | 0.00% | True |  |
| energy_lite_panel.good_beta[000660] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.good_beta[005930] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.good_beta[KOSPI200] | 827 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_beta[000660] | 721 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_beta[005930] | 721 | 0 | 0.00% | True |  |
| energy_lite_panel.bad_beta[KOSPI200] | 721 | 0 | 0.00% | True |  |

### (ii) 첫 유효일 이전 None → PASS

| 컬럼 | 첫 유효일 | 선행 None 행 | 선행 전부 None | 워밍업 하한 | ok |
|---|---|---|---|---|---|
| flow_panel.flow_beta_foreign[000660] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_beta_foreign[005930] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_beta_foreign[KOSPI200] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_beta_inst[000660] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_beta_inst[005930] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_beta_inst[KOSPI200] | 2023-04-26 | 78 | True | 78 | True |
| flow_panel.flow_impact_residual_z[000660] | 2023-07-24 | 137 | True | 78 | True |
| flow_panel.flow_impact_residual_z[005930] | 2023-07-24 | 137 | True | 78 | True |
| flow_panel.flow_impact_residual_z[KOSPI200] | 2023-07-24 | 137 | True | 78 | True |
| flow_panel.flow_trend_z[000660] | 2023-05-04 | 83 | True | 83 | True |
| flow_panel.flow_trend_z[005930] | 2023-05-04 | 83 | True | 83 | True |
| flow_panel.flow_trend_z[KOSPI200] | 2023-05-04 | 83 | True | 83 | True |
| breadth_panel.breadth_impulse_z | 2023-01-03 | 0 | True | — | True |
| gradec_panel.beta_sox_raw[000660] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.beta_sox_raw[005930] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.beta_sox_raw[KOSPI200] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.beta_sox[000660] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.beta_sox[005930] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.beta_sox[KOSPI200] | 2023-02-07 | 23 | True | — | True |
| gradec_panel.err_z[000660] | 2023-03-21 | 52 | True | — | True |
| gradec_panel.err_z[005930] | 2023-03-21 | 52 | True | — | True |
| gradec_panel.err_z[KOSPI200] | 2023-03-21 | 52 | True | — | True |
| gradec_panel.good_acceptance_z[000660] | 2023-03-24 | 55 | True | — | True |
| gradec_panel.good_acceptance_z[005930] | 2023-03-24 | 55 | True | — | True |
| gradec_panel.good_acceptance_z[KOSPI200] | 2023-03-24 | 55 | True | — | True |
| gradec_panel.bad_resilience_z[000660] | 2023-03-28 | 57 | True | — | True |
| gradec_panel.bad_resilience_z[005930] | 2023-03-28 | 57 | True | — | True |
| gradec_panel.bad_resilience_z[KOSPI200] | 2023-03-28 | 57 | True | — | True |
| gradec_panel.good_beta[000660] | 2023-02-15 | 29 | True | — | True |
| gradec_panel.good_beta[005930] | 2023-02-15 | 29 | True | — | True |
| gradec_panel.good_beta[KOSPI200] | 2023-02-15 | 29 | True | — | True |
| gradec_panel.bad_beta[000660] | 2023-02-13 | 27 | True | — | True |
| gradec_panel.bad_beta[005930] | 2023-02-13 | 27 | True | — | True |
| gradec_panel.bad_beta[KOSPI200] | 2023-02-13 | 27 | True | — | True |
| energy_lite_panel.flow_z[000660] | 2023-07-24 | 137 | True | — | True |
| energy_lite_panel.flow_z[005930] | 2023-07-24 | 137 | True | — | True |
| energy_lite_panel.flow_z[KOSPI200] | 2023-07-24 | 137 | True | — | True |
| energy_lite_panel.breadth_z[000660] | 2023-01-03 | 0 | True | — | True |
| energy_lite_panel.breadth_z[005930] | 2023-01-03 | 0 | True | — | True |
| energy_lite_panel.breadth_z[KOSPI200] | 2023-01-03 | 0 | True | — | True |
| energy_lite_panel.gradec_err_z[000660] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.gradec_err_z[005930] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.gradec_err_z[KOSPI200] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.energy_lite[000660] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.energy_lite[005930] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.energy_lite[KOSPI200] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.good_acceptance_z[000660] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.good_acceptance_z[005930] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.good_acceptance_z[KOSPI200] | 2023-03-24 | 55 | True | — | True |
| energy_lite_panel.bad_resilience_z[000660] | 2023-03-28 | 57 | True | — | True |
| energy_lite_panel.bad_resilience_z[005930] | 2023-03-28 | 57 | True | — | True |
| energy_lite_panel.bad_resilience_z[KOSPI200] | 2023-03-28 | 57 | True | — | True |
| energy_lite_panel.good_beta[000660] | 2023-02-15 | 29 | True | — | True |
| energy_lite_panel.good_beta[005930] | 2023-02-15 | 29 | True | — | True |
| energy_lite_panel.good_beta[KOSPI200] | 2023-02-15 | 29 | True | — | True |
| energy_lite_panel.bad_beta[000660] | 2023-02-13 | 27 | True | — | True |
| energy_lite_panel.bad_beta[005930] | 2023-02-13 | 27 | True | — | True |
| energy_lite_panel.bad_beta[KOSPI200] | 2023-02-13 | 27 | True | — | True |

### (iii) 코드 grep (src/mtpro/components; 패턴 `fillna\(\s*0`, `fillna\(\s*value\s*=\s*0`, `nan_to_num`, `\bor\s+0(\.0+)?\b(?!\.)`, `replace\(\s*(np\.nan|None|float\(['\"]nan['\"]\))\s*,\s*0`) → 히트 1건 → FAIL

- `src/mtpro/components/energy_lite.py:343` — `nc = pd.to_numeric(g["n_components"], errors="coerce").fillna(0).astype(int)` (패턴 `fillna\(\s*0`)
  - 맥락(사실 서술, 판정 미반영): src/mtpro/components/energy_lite.py:343 감싸는 함수 = summarize_panel; 컬럼 energy_lite_panel.n_components: 실제 None 0개 / P5 대상(z·β·energy) 컬럼 아니오

보조 범위(src/mtpro/core, jobs) 히트 0건.

P5 종합: **FAIL**

## D-A 조건 명시 (사전 등록 문서 §4 재수록 — 원문 그대로)

## 4. D-A 조건 명시 — gradec_err의 실체
- 소급 트랙 등급C(전일밤 ^SOX)에서 open→close 기준 β_SOX 원값이 ≈0(상관 ±0.09)이라 절단 하한 0.3에 걸려 `justified = 0.3 × SOX_ret` 상수 모델로 퇴화한다. 따라서 `err_z ≈ (open→close 수익률 − 0.3·SOX_ret)/σ` 이며 **gradec_err는 사실상 "이벤트일(재료 있는 날) 표준화 수익률"** 로 읽어야 한다. 재료 없는 날(|0.3·SOX|<0.3%) 41%는 None.
- Energy-Lite의 실질 정보는 flow·breadth 두 컴포넌트에 있음을 전제로 P3을 판정한다(가중은 그대로 균등 — 완화 없음).
- 등급A 전진 트랙(T5~)에서 β_SOX 회복 여부는 **Gate R2 관찰 항목**.

## 해석 기록 (문서가 명시하지 않은 세부 — 가장 엄격한 쪽 채택)

1. 표본 분모: 유효 n 은 신호·라벨 모두 non-None 인 t (신호일 ∈ 관문 구간). 전체 대비 비율의 분모 = 해당 스코프의 관문 구간 신호 행 수.
2. P1 r[t+1]: 각 스코프 수정 종가(bronze ohlcv_adj, KOSPI200 = 지수 1028) 달력상 t 의 **다음 거래일** 수익률 %. t = 2026-06-30 의 라벨은 2026-07-01 (구간 밖 허용). P2·P3-b r21[t] = close[t+21]/close[t]−1 (거래일 21개 앞), 라벨 없는 말미 t 는 표본 제외.
3. 부트스트랩: 정상 블록 부트스트랩(Politis–Romano), 블록 길이 ~ Geometric(p=1/평균 블록), 시계열 순서의 (신호, 라벨) 쌍을 함께 재표집(원형 wrap), 각 복제본에서 Spearman 재계산 → 2.5/97.5 percentile. numpy default_rng(20260817), 측정 항목(P1 각 스코프, P2, P3-b 각 스코프)마다 동일 시드로 초기화(재현성).
4. 순열 귀무 백분위 = 귀무 IC 중 관측 IC **미만**인 비율 ×100 (동률은 미만으로 세지 않음 — 관측치에 불리한 쪽).
5. P3-a Pearson 상관의 표본 = energy_lite 와 baseline 이 모두 non-None 인 관문 구간 t. baseline① MA20·MA60 은 완전 창(20·60개 전부 유효)만 산출(과거만, t 포함).
6. P4(a) 절단: bronze 7종은 date/asof ≤ 절단일. ^SOX(sox_daily)는 **date ≤ 절단일−1** (미국 세션 d 는 d+1 새벽 KST 종료 → 절단일 세션은 절단일 시점에 존재하지 않음; gradec 정렬 규칙 d ≤ t−1 과 정합. 더 엄격한 쪽). 비교 대상 = 4 gold 패널의 절단일 이하 행 전부, 키 = (date, scope)/(date), 제외 컬럼 = engine_ver 만. 비트 동일 = float 는 NaN 위치 동일 + 비-NaN 값의 IEEE 비트 동일(−0.0 ≠ 0.0), 그 외 컬럼은 값(None 포함) 동일. 절단본에 없는 행도 위반으로 센다.
7. P4(a) 재실행 잡: build_gradec 는 --no-fetch --wait-minutes 0 (ingest 재실행 없음), C-1 대사(reconcile_flow) 제외. build_flow 가 docs/mtpro-t3a-ingest.md·logs/flow_panel_summary.json 을 덮어쓰므로 실행 전 스냅샷 → 종료 후 원복(try/finally).
8. P4(c) '산출 시각' = data/gold 4 패널 파일 mtime 중 **가장 이른** 것(UTC 환산). 위반 = bronze 8 파일 어느 행이든 fetch_ts 가 그보다 늦음.
9. P5(i) 0.0 비율의 분모 = 해당 컬럼의 non-None 값 수(더 엄격). energy_lite 는 tanh 가중합×100 반올림 정수라 정확히 0 이 계산값으로 나올 수 있어, 0 행마다 가용 컴포넌트 ≥ min_components 이고 컴포넌트 z 로 재계산한 energy 가 0 임을 확인해 '원천 값이 실제 0' 소명으로 삼는다.
10. P5(ii) '첫 유효일 이전 None' — 모든 컬럼: 첫 non-None 행 이전 값 전부 None. 워밍업 하한을 원천 시작일로부터 증명할 수 있는 flow_panel 만 하한을 건다(수급 원천 2023-01-03 시작: β·잔차 z 는 선행 None ≥ 78행(정규화 20일 → index 19 부터 유효, β 60 관측 → index 78), trend_z ≥ 83행(5일 기울기 index 23 부터 + 당일 제외 60개 기준)). breadth(2022 lookback)·gradec(2022 ohlcv·2022-12 SOX)·energy 는 상류 워밍업이 구간 앞에 있어 하한 없이 서술.
11. P5(iii) grep 범위 = src/mtpro/components/*.py 전체(문서 '컴포넌트 경로'의 가장 넓은 읽기) + 보조로 src/mtpro/core·jobs/build_*.py. 패턴: fillna(0…), fillna(value=0), nan_to_num, `or 0`/`or 0.0`, replace(nan/None → 0). 히트가 하나라도 있으면 (iii) 미충족으로 적는다(용도가 보고용이더라도 문서 문구 그대로; 판단은 발주자).
12. 판정 집계: P1~P5 전부 PASS 일 때만 최종 PASS. 하나라도 '판정 불가' 이고 FAIL 이 없으면 최종 '판정 불가', FAIL 이 하나라도 있으면 최종 FAIL.

## 최종 판정 한 줄

**Gate R1 = FAIL** — P1 FAIL, P2 FAIL, P3-a PASS, P3-b FAIL, P4 PASS, P5 FAIL.
