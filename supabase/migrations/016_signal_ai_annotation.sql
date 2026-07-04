-- M7 정성 주석 자동화 — AI가 매일 뉴스로 원인 태그·주석·L7/L8을 자동 채우고,
-- 사용자가 직접 입력하면(annotation_source='user') AI가 덮어쓰지 않는다.
alter table public.signal_daily_features
  add column annotation_source text check (annotation_source in ('ai', 'user')),
  add column ai_analyzed_at timestamptz;
