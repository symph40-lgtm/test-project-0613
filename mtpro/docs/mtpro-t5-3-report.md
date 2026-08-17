# MT-PRO T5-3 보고 — 부품 9 PSA (Post-Shock Acceptance) 구현·실데이터 산출 (2026-08-17)

- 근거: `WORKORDER_MTPRO_v10.1.md` AM-7, `docs/mtpro-t5-plan.md` §4(champion 정의·pending)·§12.4(σ20 = t−20..t−1, 충격일 제외)·§7(`gold/psa_events`)·§10(challenger PSA-EARLY·PSA-K2·PSA-W7). 스펙 변경 없음 — 애매한 곳은 엄격 해석 후 §3 "해석 기록"에 남김.
- 산출물: `src/mtpro/components/psa.py` · `tests/test_psa.py`(18) · `jobs/build_psa.py` · `config/mtpro.yaml` `psa` 블록(사전 등록 상수, 모듈 상수 일치 테스트) · `data/gold/psa_events.parquet` · `data/gold/challengers/psa_{early,k2,w7}.parquet`(shadow).
- 커밋 없음(지시). 전체 pytest **279 passed**.

## 1. 구현 요약 (champion, 사전 등록)

| 항목 | 구현 | 위치 |
|---|---|---|
| 입력 | bronze `ohlcv_adj.parquet`(price_adjusted=True 만, C-2 assert), 스코프 = code ∈ {KOSPI200, 005930, 000660} | `_validate_adjusted`, `_scope_frame` |
| r_t · gap_t | close_t/close_{t−1}−1 · open_t/close_{t−1}−1 | `_detect` |
| σ20 · σ20_gap | `std(x_{t−20..t−1})` ddof=1, **t 제외**, 유효 표본<20 → None(검출 불가) | `_prior_std` (shift(1).rolling(20, min_periods=20)) |
| 충격 검출 | \|r_t\| > 2.5·σ20 **또는** \|gap_t\| > 2.0·σ20_gap; `trigger ∈ {ret, gap, both}`; 방향 = sign(r_t), 갭만 충족 시 sign(gap_t); `k_sigma` = 실측 \|r_t\|/σ20 | `_detect` |
| 관찰창 | W=5 세션(t+1..t+5), 세션 = 그 스코프의 bronze 거래일 순서 | `_metrics` |
| level_hold | (min close_{t+1..t+5} − close_{t−1})/(close_t − close_{t−1}) — 음 충격은 max close(대칭), 클립 [−1, 1.5], 분모 0 → None | `_metrics` |
| rebreak | any(low_{t+1..t+5} < low_t) / 음 충격 any(high > high_t) | `_metrics` |
| range_norm · vol_norm | mean(TR_{t+3..t+5})/mean(TR_{t−20..t−1}) · 거래량 동일 (분모 t 제외, 20일 전부 유효 요구), TR = Wilder true range | `_metrics`, `_prior_mean` |
| psa_score · psa_z | mean(z(level_hold), −z(rebreak), −z(range_norm), −z(vol_norm)) 가용 평균, z 기준 = 같은 스코프 과거 final 충격(available_at ≤ t−1 ∧ shock_date ∈ 직전 120 세션), 표본<10 → None, 클립 ±3; **psa_z = psa_score × direction** | `_score`, `_z` |
| available_at · status | 세션 t+5 날짜(마감). 그 전 `pending`(모든 지표·psa_z None, available_at None). `asof` 절단으로 시점 재현 | `compute_psa_events(asof=)` |
| overlap_shock | 앞선 충격의 창(t+1..t+5) 안 새 충격 → 각각 독립 레코드, **양쪽** True | `_mark_overlap` |
| 상위 접점 | `psa_state_at(events, asof, scope, sessions=)` — status=final ∧ available_at ≤ asof ∧ psa_z 유효 만 EWMA(hl 10 세션) + freshness=0.5^(d/10). pending 은 값이 있어도 제외 | `psa_state_at` |
| challenger | 같은 엔진의 파라미터 변형(shadow 전용): PSA-EARLY W=3(available_at=t+3, 정착 t+1..t+3) · PSA-K2 k=2.0 · PSA-W7 W=7 → `gold/challengers/psa_*.parquet` + `challenger` 열 | `CHALLENGERS`, `compute_challengers` |
| 스키마 | `GOLD_PSA_EVENTS`: shock_id, scope, shock_date, direction, k_sigma, trigger, status, available_at, level_hold, rebreak, range_norm, vol_norm, psa_score, psa_z, overlap_shock, engine_ver(`psa-0.1`) | 모듈 |

## 2. 테스트 (`tests/test_psa.py`, 18 passed)

- 상수-config 일치(`psa.constants`·scopes·challenger 등록부 = 모듈 상수/`PSA_CHAMPION`/`CHALLENGERS`), 스키마 컬럼 순서.
- σ20 t 제외: 합성 충격에서 `k_sigma == |r_t|/std(r_{t−20..t−1})` 정확 일치, t 포함 정의라면 k 가 작아짐을 함께 확인 / 표본<20 검출 없음 / 갭만 충족 → trigger=gap·direction=sign(gap)·k_sigma<2.5.
- 지표 정의: level_hold 양·음 대칭·클립 상하한, rebreak 양(low)·음(high), range/vol 창(분자 t+3..t+5·분모 t−20..t−1: 충격일 폭증 거래량이 분모에 안 들어감을 수치로 확인), 지수 volume 없음 → vol_norm None(나머지 유지).
- pending/final: asof=t..t+4 → pending·모든 지표 None·available_at None, asof=t+5 → final·available_at=t+5.
- **룩어헤드**: (a) t>D 자료를 ×1.37·거래량 ×9 로 변조 → available_at ≤ D 인 final 레코드 전 컬럼 불변, (b) asof=D 절단 표의 final = 전체 표의 available_at ≤ D 부분과 동일, shock_date ≤ D 이나 available_at > D 인 충격은 pending, (c) `psa_state_at` 는 pending 에 값이 들어 있는 적대적 표에서도 제외·EWMA/freshness 수치 일치(달력일·세션 거리 모두), 엔진 출력에서 4개 절단 시점 모두 n_obs = final∧psa_z 건수·available_at ≤ D·상태값 = 전체 표 질의값.
- z 기준: 앞선 final 충격 10건 전에는 psa_z None, psa_z = psa_score × direction, |psa_score| ≤ 3. overlap 양쪽 True / 6세션 이상 떨어지면 False. challenger available_at = t+3/t+7·K2 충격 수 ≥ champion·미등록 이름 거부. 비수정 원천 거부. 스코프 독립(2스코프 결합 = 단독 계산).

## 3. 해석 기록 (엄격 해석, 스펙 변경 없음)

1. **세션 = 스코프별 bronze 거래일 순서** (지시). XKRX 래퍼(`events/kr_calendar.py`) 미사용 → pending 의 `available_at` 은 미래 세션을 알 수 없어 **None** (final 되는 순간 t+5 날짜 기록). 상위 결합이 "예정 available_at" 을 원하면 XKRX 로 계산하는 별도 필드가 필요(스펙 밖, 미구현). config `psa.sessions: bronze_ohlcv_adj_order` 로 명기.
2. **σ 표본 규칙**: `min_samples = 20` = 창 20 전부 유효(엄격). 결측 하루라도 있으면 그날은 검출 불가. range/vol 분모(t−20..t−1)·분자(t+3..t+5)도 전부 유효 요구.
3. **방향·k_sigma**: 갭만 충족 시 방향 = sign(gap), `k_sigma` 는 스펙대로 실측 |r_t|/σ20 → 갭 충격의 k_sigma 는 2.5 미만(최소 0.00) 이 정상. 갭 크기 배수(|gap|/σ20_gap)는 스키마에 없어 저장하지 않음(`trigger` 로 구분).
4. **level_hold 분모 0**(close_t = close_{t−1}, 갭 충격에서 가능) → None. 실데이터 1건(000660).
5. **z 기준 분포**: "스코프별 과거 final 충격 표본 t−1까지 120거래일 창" = available_at ≤ t−1(그 시점에 이미 final) ∧ shock_date ≥ t−120 세션 — 가장 엄격한 읽기(기준 분포가 충격일 t 이전에 확정, 창 안 이웃 충격의 결과가 새지 않음). rebreak(bool)도 같은 z 규칙(기준 std 0 → None). psa_score 는 가용 z ≥1개면 산출(최소 개수 미명시 → 1).
6. **psa_z = psa_score × direction** 을 문자 그대로 구현. 함의: 음 충격에서 "수준 유지·재돌파 없음·범위/거래량 정상화" = 하락의 수용(acceptance) → psa_z 음(=회복 아님). 즉 range/vol 정상화도 부호가 뒤집힘(음 충격 후 범위 확대 → +). 스펙 문안 그대로이나 §5 확인 사항 ②로 병기.
7. **overlap_shock 양쪽 True**(계획서 "각각 독립 레코드, overlap_shock=True 표기"). 앞선 충격은 자기 창(≤ available_at) 안의 정보만 쓰므로 룩어헤드 아님. pending 상태에서는 그때까지 알려진 충격만 반영(최종 값은 final 시점에 고정).
8. `psa_state_at` 거리 = **available_at → asof 세션 수**(sessions 제공 시; 미제공 시 달력일, `distance_unit` 반환). 반감기 10 세션. 관측 시점을 shock_date 가 아니라 available_at 으로 둔 것은 "available_at ≤ t 인 관측의 EWMA" 문안의 엄격 해석. psa_z None 인 final(기준 표본 부족)은 EWMA 에서 빠지고 `n_final_without_z` 로 보고.
9. challenger PSA-EARLY 의 "t+3 부분 관찰" = W=3 으로 같은 정의 적용(정착 = 창의 마지막 3세션 = t+1..t+3, level_hold/rebreak 는 t+1..t+3). PSA-W7 정착 = t+5..t+7. 검출 파라미터는 champion 과 동일(K2 만 k 변경).

## 4. 실데이터 실행 (`jobs/build_psa.py`, bronze 2022-01-03~2026-08-14, 3,387행)

| 스코프 | 충격 수 | final/pending | 양/음 | trigger | overlap | 기간 |
|---|---|---|---|---|---|---|
| KOSPI200 | 95 | 95/0 | 49/46 | ret 18 · gap 55 · both 22 | 60 | 2022-04-25~2026-07-31 |
| 005930 | 96 | 96/0 | 62/34 | ret 17 · gap 59 · both 20 | 66 | 2022-03-07~2026-07-31 |
| 000660 | 100 | 100/0 | 69/31 | ret 14 · gap 63 · both 23 | 63 | 2022-03-07~2026-07-31 |

| 스코프 | k_sigma (median · p90 · max) | level_hold median (p10/p90) | rebreak 비율 | range_norm median | vol_norm median |
|---|---|---|---|---|---|
| KOSPI200 | 2.20 · 3.48 · 7.15 (2024-08-05) | 0.48 (−1.00/1.50) | 0.63 | 1.10 | 0.98 |
| 005930 | 1.92 · 3.41 · 6.44 (2023-09-01) | 0.45 (−1.00/1.41) | 0.61 | 1.13 | 1.03 |
| 000660 | 2.06 · 3.44 · 6.08 (2023-07-27) | 0.57 (−1.00/1.45) | 0.62 | 1.19 | 1.05 |

| 스코프 | psa_z 산출/final (coverage) | 첫 psa_z | mean | std | min / p10 / median / p90 / max |
|---|---|---|---|---|---|
| KOSPI200 | 50/95 (53%) | 2023-10-26 | +0.068 | 0.601 | −1.01 / −0.74 / −0.02 / +0.77 / +1.32 |
| 005930 | 44/96 (46%) | 2022-08-10 | −0.012 | 0.681 | −1.95 / −0.90 / +0.03 / +0.72 / +1.51 |
| 000660 | 58/100 (58%) | 2022-10-28 | −0.049 | 0.592 | −1.13 / −0.82 / +0.02 / +0.55 / +1.75 |

- 연도별 충격 수(K200/005930/000660): 2022 13/20/17 · 2023 17/19/22 · 2024 20/19/21 · 2025 23/24/23 · 2026(~8/14) 22/14/17 → 스코프당 연 ≈ 20~24건, §8 `n_operational 5` 충족, `n_inference 30`(psa_z 유효 표본 기준 44~58, 3년 누적) 도달 — secondary 항목이므로 기록만.
- pending 0건: 마지막 충격 2026-07-31(3스코프 동시, +, k 3.7~4.2) 의 t+5 = 2026-08-07 ≤ 자료 마지막 2026-08-14. `--asof 2026-08-05` 로 절단하면 3건 모두 pending(available_at None), `psa_state_at(2026-08-05)` 는 그 3건을 제외(K200 n_obs 49 → 전체 자료 기준 50).
- 상태 접점 예시(2026-08-14, 세션 거리): KOSPI200 psa_state +0.31 (n_obs 50, freshness 0.71) · 005930 +0.40 (44) · 000660 +0.16 (58) — 마지막 관측 available_at 2026-08-07.
- 갭 트리거가 55~63% 로 지배적(σ20_gap 이 작아 2.0배 초과가 잦음). 갭 충격의 k_sigma 중앙값 ≈1.3~1.4(수익률 기준으로는 비충격). overlap 60~66% 도 대부분 갭 충격 밀집에서 발생.
- psa_z coverage 46~58%: 기준 분포 요건(직전 120 세션 안 이미 final 인 충격 ≥10) 때문에 초기 구간·충격이 드문 구간은 None. 최대 충격 KOSPI200 2024-08-05(7.1σ)·005930 2023-09-01(6.4σ) 등이 None(앞선 120 세션 표본 부족).
- challenger(shadow): PSA-EARLY 충격 수 동일·coverage 49~64% · PSA-K2 충격 128~132(+35%), overlap 98~104, coverage 77~86% · PSA-W7 overlap 72~79, coverage 43~53%. psa_z 평균은 모두 ±0.15 안, std ≈0.6~0.7.

## 5. 발주자 확인 사항 (변경 없이 사실만)

1. **pending 의 available_at = None**(bronze 순서 사용 지시의 귀결). 상위 결합(T5-5)이 "예정 available_at" 을 필요로 하면 XKRX 캘린더로 채우는 파생 필드 추가 여부 결정 필요(스키마 확장, PSA_PENDING_SHOCK 오염 판정과도 연결).
2. **psa_z = psa_score × direction 문자 그대로**: 음 충격에서 range/vol 정상화 성분의 부호도 함께 뒤집힘(§3-6). 의도가 "level_hold·rebreak 만 방향 부호, 정상화는 방향 무관" 이라면 amendment 사항 — 현재는 스펙 문안대로.
3. **갭 트리거 지배·overlap 60%+**: σ20_gap 기준 2.0배는 수익률 기준 비충격일(k_sigma 중앙값 1.3)을 다수 포함. 사전 등록값 그대로 두되 T5.5 판정 표본 구성 시 trigger 별 분리 서술 필요 여부.
4. **psa_z coverage ≈50%**: 기준 분포 "직전 120 세션 ∧ 이미 final ≥10" 엄격 해석의 결과. 대안(전 이력 참조·min 5 등)은 challenger 로만 가능 — 등록 여부.
5. overlap_shock 를 **양쪽** True 로 둔 해석(§3-7) 확인.
