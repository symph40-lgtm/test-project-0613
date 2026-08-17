# PLAN-001 — WO-001의 근거 산문 (기획자 산출물, 구현자 접수본 2026-08-17)

- 지위: 검토자 산문 2편을 **받은 그대로** 기획서로 파일링. 해석 지침이며 `../orders/WO-001.md`와 충돌 시 발주서가 이긴다. 발주자 정식 발송본이 오면 대체.

---

## 산문 1 — T5 계획서 조건부 승인 검토 (마감 5건의 근거)

네. 전체적으로는 승인 가능한 수준입니다. 다만 저는 T5-1 구현 시작 전에 5개 항목만 계획서에 더 명시적으로 잠그는 조건부 승인을 권합니다. 이 5개는 새 아이디어 추가가 아니라, 지금 정한 champion이 구현 과정에서 다른 의미로 바뀌지 않도록 하는 마감 작업입니다. 현재 방향은 최신 WORKORDER의 "독립 프로젝트, 데이터 현실 우선, T2/R1/R2 연결은 후속 판단"이라는 원칙과 잘 맞습니다.

1. `n_inference=40`의 통계 조건을 명시해야 합니다. 여기는 숫자 자체보다 어떤 검정에서 40인지가 중요합니다. 상관효과 ρ=0.4, power=.80을 Fisher-z 근사로 계산하면 대략 양측 α=.05 → n≈47, 단측 α=.05 → n≈38입니다. 따라서 n_inference=40은 "방향을 사전등록한 단측 α=.05 검정"이라면 타당합니다. 반면 양측검정이라면 부족합니다. 그래서 계획서에 "Good/Bad 재현성: H1 방향 사전등록, one-sided α=.05, power=.80, target effect ρ=.40 → n_inference=40"처럼 적는 것이 좋습니다. 그리고 6개 inference 항목을 동시에 심판한다면 다중검정 규칙도 측정 전에 고정하세요. 예를 들어 Holm 보정, FDR, 또는 "주 endpoint 2개만 Gate 판정, 나머지는 secondary" 중 하나를 champion 규칙으로 선택해야 합니다.

2. `family contribution cap=0.6`의 계산법을 정확히 써야 합니다. 지금 문구 "Energy = tanh(Σw·s), weights .40/.35/.25, contribution cap .6"은 철학은 맞지만 구현자가 다르게 해석할 수 있습니다. 특히 family가 두 개만 available일 때 재정규화하면 한 family가 사실상 Energy 대부분을 지배할 수 있습니다. 그래서 최소한 family score의 범위, available family만 있을 때 weight 재정규화 방법, 0.6 cap의 분모가 무엇인지, cap 초과분을 다른 family에 재배분하는지 버리는지, 양·음 family가 상쇄될 때 contribution share 계산은 절대기여 기준인지를 확정해야 합니다. 제가 선호하는 것은 absolute contribution 기준 60% cap입니다. 즉 개념적으로 share_i = |w_i*s_i| / Σ|w*s| 로 보고 60%를 넘으면 cap 후 나머지 available family에 재배분하는 방식입니다. 방법이 무엇이든 T5 전에 하나로 고정하면 됩니다.

3. Semi Transmission의 회귀 구조는 반드시 하나로 확정해야 합니다. 이게 가장 중요한 기술적 보완입니다. "SOXX·NVDA·MU·TSM → 삼전/하닉 60일 OLS"라고만 쓰면 두 가지 전혀 다른 구현이 가능합니다. A. 네 변수를 한 회귀에 동시에 넣기, 또는 B. 각 자산별 전달 β를 따로 추정하기. 그런데 SOXX/NVDA/MU/TSM은 서로 상당히 같은 반도체 정보를 공유하므로 raw 4변수 OLS를 쓰면 개별 coefficient가 불안정해질 수 있습니다. 기존 G1B에서도 이중계상을 피하려고 SOXX→SPX, TSM→SOXX, peer→SOXX 식으로 직교화하는 구조를 사용하고 있었습니다. 이것을 그대로 복사할 필요는 없지만 문제 자체는 같습니다. 따라서 champion은 예를 들어 둘 중 하나로 고정하는 것이 좋습니다. 방법 A — 권장: SOXX = sector baseline, NVDA/MU/TSM = SOXX 대비 residual shock. 또는 방법 B: 각각 별도의 univariate transmission β를 구한 후 predefined combiner로 합성. 그리고 그 이후 β_up − β_down을 계산합니다. raw 4-factor OLS인지 아닌지를 구현자에게 맡겨두면 안 됩니다.

4. PSA와 Divergence에서 기준시점 하나씩 더 잠가야 합니다. PSA의 "k=2.5 σ20 또는 gap 2.0 σ"는 좋지만 σ20이 정확히 무엇인지 적어야 합니다. 특히 shock 당일을 포함해 σ20을 계산하면 큰 shock가 자기 threshold를 높이는 문제가 생깁니다. 그래서 "σ20은 충격일 t를 제외한 t-20~t-1 실현변동성"처럼 lagged volatility로 고정하는 것을 권합니다. Divergence도 "z_slope20(Energy) − z_slope20(ln price)"까지는 좋은데 z의 기준분포 window가 아직 보이지 않습니다. 예: "20일 slope를 직전 120거래일 slope 분포(t-1까지)로 z-standardize"처럼 고정해야 합니다. 그렇지 않으면 나중에 60/120/252일 중 잘 나온 것을 선택할 여지가 남습니다.

5. 9월 실례의 이벤트 날짜와 t0는 코드에서 동적으로 계산해야 합니다. 미국 공식 일정은 확인해보니 NFP 9/4와 10/2, CPI 9/11, FOMC 9/15~16, Personal Income and Outlays/PCE 9/30이라는 날짜 자체는 현재 공식 일정과 맞습니다. 다만 이것들을 문서에 t0=9/7, t0=10/5처럼 하드코딩하지 않는 것이 중요합니다. 항상 "event timestamp → Asia/Seoul 변환 → 해당 시각 이후 최초 XKRX session open"으로 계산해야 합니다. KRX 휴장·대체공휴일이 끼면 t0가 달라질 수 있기 때문입니다. 또 삼성전자 3Q 잠정실적 10/8은 현재 삼성전자 공식 IR에서 확정 일정으로 확인되지 않습니다. 공식 IR에는 현재 2026년 2분기까지 일정이 올라와 있으므로, 10/8은 tentative/example로 표시하고 실제 발표 공지가 나올 때 확정하는 것이 맞습니다.

나머지는 승인합니다. 특히 다음은 그대로 가는 것이 좋습니다. W_digest=5 KRX 거래일을 champion으로 사전 고정하고, event overlap을 날짜가 아니라 정보 소화창으로 본 것(3일/7일 시험은 challenger로만). 검증 쌍을 e* 하나당 한 쌍으로 제한한 것(같은 사건에 MT_{t-5}, MT_{t-4}, MT_{t-3}을 전부 매칭해 표본 수를 부풀리는 문제를 막음). Gap Reaction ERR_z를 champion 종속값, intraday ERR를 challenger로 둔 것(한 가지 주 endpoint를 먼저 고정). PSA를 t+5 마감 전에는 pending/None으로 두는 것. 상위 상태 confidence를 evidence count와 agreement로 분리한 것(+80이라는 상태값과 "그 +80을 얼마나 믿을 수 있는가"를 서로 다른 값으로 보존). Energy-Lite는 삭제하지 않고 historical record로만 남기는 것(새 family Energy와 과거 Lite를 슬쩍 이어붙이는 것보다 정직). 12개월 T5.5가 n_inference 미달이면 서술 전용으로 미리 선언한 것(결과를 본 뒤 "그래도 꽤 좋아 보인다"고 Gate에 사용하는 길을 미리 막음).

결론 — T5 계획서: 조건부 승인. 위의 5개만 계획서에 명문화하면 그다음에는 개념 논의를 더 늘리지 말고 T5-1 구현으로 넘어가는 것이 좋습니다. 이 다섯 가지가 닫히면 설계 단계에서 더 손대는 것보다 실제 전진 데이터가 무엇을 말하는지를 보는 편이 훨씬 가치 있습니다.

(구현자 주: 실측 결과 XKRX 2026-10-05는 개천절 대체공휴일 휴장 → NFP 10/2의 t0 = 10/6. 산문의 "t0=10/5" 예시는 하드코딩 금지 원칙이 막으려던 바로 그 오차였다.)

---

## 산문 2 — Gate R1 FAIL의 의미와 다음 단계 (추가 등재 2건의 근거)

이 FAIL은 오히려 지금까지 정리한 새 MT-PRO 방향을 더 명확하게 해주는 결과입니다. 결론부터 말하면, Gate R1은 그대로 FAIL로 확정하고 Energy-Lite는 종결하는 것이 맞습니다. 그러나 이 결과만으로 MT-PRO 본 가설까지 폐기할 근거는 없습니다.

Gate R1이 실제로 검증한 것은 "일봉 Flow/Breadth/등급C 이벤트 프록시로 만든 Energy-Lite가 익일·익월 수익률에 정보를 가지는가"였습니다. 결과는 명확히 아니었습니다. Flow는 세 스코프 모두 음의 IC였고, 특히 하닉은 −0.104로 사전등록한 양의 부호와 유의하게 반대였으며, Breadth와 Energy-Lite도 유의한 양의 IC가 나오지 않았습니다. 따라서 이 Lite 모델을 살리려고 같은 데이터에서 부호를 뒤집거나, 기간을 바꾸거나, 가중치를 다시 맞추는 것은 하면 안 됩니다.

다만 이 관문은 우리가 지금 만들려는 본 MT-PRO의 핵심 질문을 실제로 시험하지 않았습니다. 당시 Energy-Lite에는 과거 컨센서스와 충분한 분봉이 없어서, ERR은 사실상 등급C 방향 프록시였고 Shock Absorption도 정식으로 들어가지 않았습니다. β_SOX가 하한에 붙으면서 gradec_err가 사실상 이벤트일 표준화 일봉수익률에 가까워졌다고 기록돼 있습니다. 무엇보다 당시 Gate R1의 주 잣대는 미래수익률 IC였습니다. AM-9에서 고정한 "현재 Bad Resilience가 높으면 이후 독립 악재에 실제로 덜 민감한가?"라는 반응함수 재현성은 아직 검증한 적이 없습니다.

선택: ① Lite는 확정 종결 + ② 원인분석은 기록용으로만 1회 + ③ 본 MT-PRO 전진 트랙 진행을 동시에. Energy-Lite는 여기서 끝입니다 — 기존 표본으로 가중치 재튜닝, 부호 반전, 다른 horizon 재탐색을 해서 재채점하지 않습니다. 미채택·log-only 상태로 둡니다. 하닉 Flow의 음의 IC나 2023~24 음수 → 2025~26H1 양수 현상은 연구 가설로만 남깁니다("Flow Impact의 부호는 레짐 의존적인가?"라는 challenger 가설을 새 표본에서 검증할 수는 있으나, 현재 표본에서 하닉을 반대로 쓰자는 것은 금지).

T5는 진행할 가치가 있습니다. T5에는 Lite에 없던 핵심 측정 — 실제 Expected Reaction / ERR, GoodBeta·BadBeta, 장중 Shock Absorption, Gap Reaction/Hold/Close Acceptance, Post-Shock Acceptance, Semi Transmission, 삼전·하닉 독립 반응함수 — 가 들어갑니다. Gate R1 FAIL을 무시하는 것이 아니라, Gate R1이 부정한 Lite를 버리고 다른 질문을 새 표본으로 검증하는 것입니다. 예: 하닉 Bad Resilience_t = +70이 나왔다면 이후 최초의 독립 악재에서 Expected Reaction −3.5% vs Actual −1.2%면 좋은 결과, Expected −2% vs Actual −5%면 Bad Resilience가 틀린 것입니다. 시장 반응함수를 직접 채점해야 합니다. 익월 수익률이 올랐느냐는 그 다음 문제입니다.

T5.5의 12개월 분봉도 계획대로: 12개월 안에 독립 good/bad 이벤트가 n_inference에 못 미치면 PASS도 FAIL도 하지 말고 INSUFFICIENT/서술 전용으로. "방향이 좋아 보이니까 일단 통과"시키면 Gate R1에서 지켰던 엄격함을 새 모델에서 바로 잃습니다.

긍정적으로 보는 것은 검증 규율이 실제로 작동했다는 점입니다 — 217개 테스트 통과·룩어헤드 0인데 성과가 나쁘자 그대로 FAIL을 냈고, 하닉 Flow가 반대 부호였는데도 뒤집어 살리지 않았습니다. 이런 시스템이라면 이후 MT-PRO가 좋은 결과를 냈을 때 훨씬 믿을 수 있습니다.

한 줄: Gate R1은 "Energy-Lite가 실패했다"는 강한 증거다. 그러나 "삼전·하닉의 반응함수 변화를 측정하는 MT-PRO가 실패했다"는 증거는 아니다. Energy-Lite 종결은 확정하고, AM-6~AM-10을 반영한 T5를 새 champion 설계로 진행하되, Gate R1의 소진 표본은 새 모델의 채택 근거로 재사용하지 않고 T5/T5.5·Gate R2의 새 규칙과 새 표본으로 심판한다.
