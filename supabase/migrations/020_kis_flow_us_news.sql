-- 2026-07-09 사용자 개정분
-- ① KIS 수급 연동 (T4 외인 선물 · T5 프로그램 · T8 외인 현물+프로그램 흐름 + 수급 반전 문자)
--    당일 누적 순매수, 단위 억원. 미적용이어도 코드가 폴백으로 동작 (수급 신호만 미산출).
alter table public.signal_ticks add column if not exists kospi_frgn double precision;   -- 코스피 현물 외국인 (억원)
alter table public.signal_ticks add column if not exists kospi_prgm double precision;   -- 코스피 프로그램 차익+비차익 (억원)
alter table public.signal_ticks add column if not exists fut_frgn double precision;     -- 코스피200 선물 외국인 (억원)
alter table public.signal_ticks add column if not exists fut_frgn_qty double precision; -- 선물 외국인 순매수 계약수

-- ② L7 개정 — 낙폭이 없어도 매일 전일 미국 뉴스·주식영향 영향도를 AI가 분석해 Bias에 반영
alter table public.signal_daily_features add column if not exists us_news_impact text
  check (us_news_impact in ('up', 'down', 'neutral'));
alter table public.signal_daily_features add column if not exists us_news_note text;
