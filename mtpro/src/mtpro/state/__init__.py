"""T5-5 — primitive 3-family 결합 · Energy · 상위 상태 · 출력(ΔMT/Divergence/Regime/텍스트) (계획서 §3·§5·§6·§7·§12.2·§12.4).

패키지 구성 (조립·결합만; 컴포넌트 계산은 상류 gold 패널에서 끝났다):
  families.py     — Reaction / Price Acceptance / Participation family 점수·conf (§3.1~3.3)
  energy.py       — family 결합 Energy + contribution cap 알고리즘 (§3.5·§12.2) + challenger E-ORTH/E-EQ/E-NOCAP
  upper_state.py  — Good Acceptance / Bad Resilience (§5, 출력 전용 — Energy 입력 아님)
  outputs.py      — ΔMT · Price–MT Divergence · Regime · 텍스트 템플릿 (§6) + challenger DMT/DIV
  build.py        — 스코프별 일별 mt_state 조립 (§7 스키마), 잡은 jobs/build_mt_state.py

공통 규칙: 결측 None(0 대체 금지), 모든 z 는 t−1 까지 120 거래일·표본<60 None·클립 ±3(§12.4), 이벤트 기반 값은 available_at ≤ t
관측의 EWMA(반감기 10 세션). 시간축 A-1R: 행 t 의 available_at = t 마감.
"""
