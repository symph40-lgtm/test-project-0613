-- L10 강화 — 경제지표 서프라이즈 방향을 AI가 뉴스에서 직접 판정해 기록
-- (예: NFP 컨센 11만 vs 실제 5만 = easing 서프라이즈 → 금리인상 우려 후퇴 = 상방 Bias)
alter table public.signal_daily_features
  add column macro_surprise text check (macro_surprise in ('easing', 'tightening'));
