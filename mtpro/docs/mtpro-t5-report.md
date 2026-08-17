# MT-PRO T5 종합 보고 — 전진 트랙 구현 완료 (2026-08-17)

- 발주: WORKORDER v10.1 개념 고정(AM-6~AM-10) + `docs/mtpro-t5-plan.md`(조건부 승인·§12 마감) + WO-001/PLAN-001.
- 상태: **T5-1~T5-6 구현·실데이터 산출 완료, 테스트 365 passed.** T5.5 사전 등록 문서 제출(`mtpro-t55-prereg.md`, 측정 전). Gate R1 소진 표본은 채택 근거로 미사용.
- 상세: `mtpro-t5-2-report.md`(3G·Transmission) · `-t5-3-`(PSA) · `-t5-4-`(diffusion) · `-t5-5-`(state) · `-t5-6-`(등급A·분봉·크론) · `mtpro-live-ops.md`(홈PC 크론 등록).

## 1. 단계별 결과
| 단계 | 산출 | 핵심 실측 |
|---|---|---|
| T5-1 독립성 | kr_calendar(XKRX)·independence·events_kr | 9월 실례 캘린더 계산 — FOMC 9/17 ∈ CPI 창 비독립, **NFP 10/2 t0=10/6**(10/5 대체공휴일; 하드코딩 금지가 문서 오차를 잡음) |
| T5-2 3G·Transmission | us_daily(SOXX·NVDA·MU·TSM)·gap3g·transmission | β_gap 중앙값 .24/.30/.69(갭 기준엔 재료 살아 있음 — open→close β≈0과 대비), 정렬 ok 853/reused 29; Transmission 방법 A: beta_soxx .73/1.26/.58, 직교화 후 잔차-SOXX 상관 ≈0, **β_up<β_down 3스코프 공통**(asym 평균 −.48/−.35/−.25) |
| T5-3 PSA | psa_events 291건(연 20~24/스코프), challenger 3종 shadow | 갭 트리거 55~63% 지배, overlap 60%+, psa_z coverage 46~58%(엄격 기준 분포 규칙), pending 차단 검증 |
| T5-4 diffusion | semi_group_monthly(KRX 5044∪5422 ∩ K200 PIT, 56 asof)·semi_diffusion_panel | 종목군 3~4개(삼전·하닉·DB하이텍·SK스퀘어·한미반도체), 생존 편향 없음, breadth_impulse와 상관 −0.06 |
| T5-5 state | families·energy(cap §12.2)·upper_state·outputs·mt_state 2,646행·challenger 10종 | Energy None 6.2/0/0%, 3 family 가용 82~87%(≥80% 충족), cap 적용 38~43%, 상위 상태 insufficient K200 15%(초기)·종목 <1%, state_confidence p50 67, Regime 전환 4~7, 반대 신호 병기 60%+ |
| T5-6 등급A·분봉·크론 | expected_reaction(0건 정직)·kis_minute_store(**2종목 243세션 2025-08-18~2026-08-14 전부 ok, KIS 깊이 ≥12개월 재확인**)·absorption 490행·macro_daily(^VIX·^TNX)·live_daily·ops 문서 | **XKRX 유령 세션 2일(2026-06-03·07-17)** — 실제 KRX 휴장, MINUTE_GAP으로 loud 감지됨 |

## 2. 발주자 확인 사항 (에이전트 보고 통합 — 결정 요청, 측정 전 닫을 것)
| # | 항목 | 내용 | 권고 |
|---|---|---|---|
| C1 | XKRX 유령 세션 | 2026-06-03·07-17이 XKRX엔 세션이나 KRX 휴장 → t0·소화 창·PSA 창 계산에 영향 가능 | **관측 거래일(bronze)로 XKRX를 교차 검증**하고 불일치일은 비세션 처리 + 알림(kr_calendar에 규칙 추가, amendment 아님·조달 정합) |
| C2 | 3G σ_gap 엄격 규칙 | 120행 t−1까지 ≥60 → K200·005930 err_z None 34~36% | 유지(사전 등록) — 완화는 challenger |
| C3 | Transmission 2단계 β 창 t 포함 [t−59, t] | 상태값 정의로 t 포함 | 유지 |
| C4 | PSA psa_z 부호 규칙 문자 그대로(음 충격의 range/vol 정상화 성분 부호 반전) · overlap 양쪽 True · pending available_at None | 스펙 문자 해석 | 유지, T5.5 서술에서 trigger별 분리 |
| C5 | diffusion 소스 5044∪5422 · SK스퀘어 포함 · 종목군 3~4 이산 해상도 | KRX 지수 분류 그대로 | 승인 요청 |
| C6 | state: ERR 부호 그대로 사용(수익률 공간) · family freshness = 최근 관측 · z(GoodBeta−1) · breadth 레벨 z · 반대 신호 임계 0 | 해석 기록 5건 | 승인 요청(임계 변경은 amendment) |
| C7 | KOSPI200 지수 분봉 제외(TR 상이) | 부품 3은 2종목만 | T5 범위 확정 요청(추가는 별도 발주) |
| C8 | 등급A 실데이터 0건 | 라이브 첫 이벤트부터 | 크론 등록(발주자 액션, ops 문서) |
| C9 | yfinance 당일 부분 종가 행 | 정렬상 오염 없음 | 잡 실행 시각 16:10 KST 고정으로 흡수 |

## 3. 다음
1. **T5.5 사전 등록 승인** → 측정(예상 결과: 주 endpoint INSUFFICIENT/서술, B 항목 작동 판정).
2. **홈PC 크론 등록**(발주자): `docs/mtpro-live-ops.md` — 평일 16:10 `jobs/live_daily.py`, alerts.jsonl 감시.
3. Gate R2 사전 등록 문서(라이브 등급A good/bad 각 5건 도달 시점, 예상 3개월)는 T5.5 후 제출.
