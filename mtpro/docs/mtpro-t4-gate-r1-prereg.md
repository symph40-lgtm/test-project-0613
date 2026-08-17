# MT-PRO T4 — Gate R1 사전 등록 문서 (측정 전 제출본, 2026-08-17)

- 지위: **측정 전 사전 등록.** 발주자 승인 후 측정하며, 승인 뒤에는 PASS 조건·정의·구간·표본 규칙을 바꾸지 않는다(규칙 9). 조정 필요 시 amendment로 상신.
- PASS 조건은 `WORKORDER_MTPRO_v10.1.md` §3 Gate R1 등재 내용과 **문구·항목 1:1 일치**(§1). β_SOX≈0을 이유로 한 완화 없음(D-A 조건). 이 문서는 그 조건들의 **측정 방법(연산 정의)** 을 미리 고정하는 것이다.
- 측정 코드: `src/mtpro/gate/r1.py` + `jobs/run_gate_r1.py` (승인 후 작성·실행. 실행 전 `assert_prereg_matches()`가 이 문서의 상수 블록과 코드 상수를 대조).
- 실행 대상 데이터: T3 gold 패널(`flow_panel`·`breadth_panel`·`gradec_panel`·`energy_lite_panel`, engine flow-0.1/breadth-0.1/gradec-0.1/energy-lite), 2023-01-03~2026-08-14 산출본. 관문 구간은 아래 §2.

---

## 1. PASS 조건 (§3 Gate R1 원문 → 측정 정의)

| # | §3 원문 | 측정 정의 (사전 등록) | PASS 판정 |
|---|---|---|---|
| P1 | FlowImpactResidual_z: 익일 수익률과 IC ≠ 0 (부호 사전 등록: **양**) | 스코프별(KOSPI200·005930·000660) `IC_1 = Spearman(flow_impact_residual_z[t], r[t+1])`, r = 수정 종가 일간 수익률(%). 유의성 = **정상 블록 부트스트랩(블록 10거래일, 2,000회) 95% CI가 0을 포함하지 않음** | 3스코프 **모두** CI가 0 제외 **AND** IC_1 > 0 |
| P2 | BreadthImpulse_z: 익월 수익률과 IC > 0 | 시장 공통 신호이므로 대상 수익률 = **KOSPI200(1028) 21거래일 선행 수익률** `r21[t] = close[t+21]/close[t]−1`. `IC_21 = Spearman(breadth_impulse_z[t], r21[t])`, 겹침 표본 → 블록 부트스트랩(블록 21, 2,000회) 95% CI. 보조: 005930·000660 IC_21 서술 | IC_21 > 0 **AND** CI 하한 > 0 (KOSPI200 기준) |
| P3-a | Energy-Lite: naive baseline ①② 각각에 대해 상관 < 0.9 | `Pearson(energy_lite[t], baseline_k[t])`, k∈{①,②}, 스코프별. baseline 정의 §3 | 3스코프 × 2baseline 전부 \|ρ\| < 0.9 |
| P3-b | Energy-Lite 자체 IC > 0 | 주 지평 **21거래일**(§2 사유): `IC_21 = Spearman(energy_lite[t], r21[t])` 스코프별 수익률(각 스코프 자기 종가). 블록 부트스트랩(21, 2,000회) 95% CI. 보조: 5거래일 IC 서술 | 3스코프 모두 IC_21 > 0 **AND** CI 하한 > 0 |
| P4 | Lookahead violations = 0 | (a) **절단 재산출 검증**: 관문 구간에서 무작위 12개 절단일(시드 20260817) 마다 bronze를 절단일까지로 잘라 전 파이프라인 재실행 → 절단일 이하 행이 전량 산출본과 **비트 동일**(NaN 위치 포함) 인지 확인. 위반 = 다른 행 1개 이상 (b) SOX 정렬: 모든 t행에서 `sox_session_date ≤ t−1` (c) `available_at`/`fetch_ts` ≤ 산출일 | 위반 0 |
| P5 | 결측 None 유지 확인 (0 대체 없음) | 4패널의 z·β·energy 컬럼에서 (i) 정확히 0.0인 값의 비율이 각 컬럼 표본의 0.5% 이하이거나 원천 값이 실제 0인 것으로 소명 (ii) 워밍업 구간(β 표본 부족 등)이 None으로 남아 있음(첫 유효일 이전 값 전부 None) (iii) 코드 grep: `fillna(0)`·`or 0.0` 류 대체가 컴포넌트 경로에 없음 | 전 항목 충족 |

- **부호·지평 사전 등록**: P1 지평 1일·부호 양 / P2·P3-b 지평 21일·부호 양. 5일 지평·연도별 fold는 **서술 전용**(PASS 판정에 불사용).
- **다중 스코프 규칙**: "3스코프 모두"가 기본. 한 스코프만 실패하면 **FAIL**로 기록(부분 충족은 미달 — 기존 프로젝트 규칙 준용), 원인 서술.

## 2. 검증 구간·표본 규칙 (§3: 2023-01 ~ 2026-06, fold 분할은 T1 실측 후 확정)
- **관문 구간 = 2023-01-03 ~ 2026-06-30** 단일(§3 원문). 선행 수익률은 구간 밖(2026-07~08)을 써도 됨(라벨은 미래를 봐도 되나 신호는 안 됨).
- **fold 분할 = 서술 전용** 연도별 4구간(2023 / 2024 / 2025 / 2026-01~06)의 IC 부호·값을 표로 첨부. 파라미터 재학습 없음(모든 구간 동일 상수). PASS 판정은 단일 구간만.
- 유효 표본: 신호와 라벨이 모두 non-None인 (t) 만 사용. 스코프별 유효 n과 전체 대비 비율을 표기. **유효 n < 500이면 해당 스코프 "판정 불가"** 로 기록(FAIL과 구분).
- 지평 21일 선택 사유(사전 기록): 부품 5 정의(§3 "익월")와 통일, Energy-Lite도 국면 신호이므로 익월. 1일 지평은 부품 4 정의(§3 "익일").

## 3. Baseline (naive 지표만 — §3)
| # | 정의 (사전 등록) | 산출 |
|---|---|---|
| ① MA20/MA60 교차 | 각 스코프 수정 종가: `b1[t] = (MA20[t] − MA60[t]) / MA60[t]` (연속값). 이진 판정 보조: MA20>MA60 = upside | 과거만, 스코프별 |
| ② above_20d_ratio 단독 | `b2[t] = breadth_panel.above_20d_ratio[t]` (시장 공통, 각 스코프에 동일 적용) | 부품 5 레벨 값 그대로 |
| ③ random control | 신호를 **순열 치환**(permutation) 2,000회 → IC 귀무 분포. 규칙 "기준선 없는 명중률은 명중률이 아니다": P1·P2·P3-b의 IC를 귀무 분포 **백분위**로 함께 보고(판정 조건 아님, 보고 의무) | 시드 20260817 |
- 정보 증분(P3-a·b) 해석: baseline과 상관 <0.9 **AND** 자체 IC>0. 추가 서술: baseline ①②의 IC_21도 같은 방법으로 산출해 병기(우열 판정 아님 — v10.1은 "우월"을 요구하지 않음).

## 4. D-A 조건 명시 — gradec_err의 실체
- 소급 트랙 등급C(전일밤 ^SOX)에서 open→close 기준 β_SOX 원값이 ≈0(상관 ±0.09)이라 절단 하한 0.3에 걸려 `justified = 0.3 × SOX_ret` 상수 모델로 퇴화한다. 따라서 `err_z ≈ (open→close 수익률 − 0.3·SOX_ret)/σ` 이며 **gradec_err는 사실상 "이벤트일(재료 있는 날) 표준화 수익률"** 로 읽어야 한다. 재료 없는 날(|0.3·SOX|<0.3%) 41%는 None.
- Energy-Lite의 실질 정보는 flow·breadth 두 컴포넌트에 있음을 전제로 P3을 판정한다(가중은 그대로 균등 — 완화 없음).
- 등급A 전진 트랙(T5~)에서 β_SOX 회복 여부는 **Gate R2 관찰 항목**.

## 5. 산출물·형식
- `docs/mtpro-t4-gate-r1-result.md`: 표(P1~P5 판정, IC·CI·귀무 백분위·유효 n), fold 서술표, baseline IC 병기, 절단 재산출 로그 요약, D-A 명시 문단 재수록. 원본 수치 `logs/gate_r1_summary.json`.
- 판정 문구: PASS / FAIL / 판정 불가(표본) — 부분 충족은 FAIL.

## 6. 사전 등록 상수 블록 (코드 `gate/r1.py`가 대조)
```yaml
gate_r1:
  window: [2023-01-03, 2026-06-30]
  horizons: {flow: 1, breadth: 21, energy: 21, energy_aux: 5}
  signs: {flow: pos, breadth: pos, energy: pos}
  ic: spearman
  bootstrap: {kind: stationary_block, block: {1: 10, 21: 21}, n: 2000, ci: 0.95, seed: 20260817}
  permutation: {n: 2000, seed: 20260817}
  baseline_corr_max: 0.9
  min_valid_n: 500
  lookahead_truncation: {n_cutoffs: 12, seed: 20260817}
  zero_share_max: 0.005
  folds_descriptive: [2023, 2024, 2025, 2026H1]
```

*제출: 측정 전. 승인 문구 후 `gate/r1.py` 작성·실행.*
