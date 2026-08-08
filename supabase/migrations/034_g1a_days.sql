-- 2026-08-09 G1A v0.3 저녁 갭 판정 로그 (specs/SPEC_G1A_gap_forecast.md §10)
-- log-only 60일: 판정·피처·리포트 텍스트를 저장하고 자본은 걸지 않는다.
-- 라벨(L1'·L1·L2·L3)은 D+1 오전 크론이 소급 기입 (predict_daily_days와 동일 사상).
-- ⚠ 적용은 Supabase SQL Editor에서 수동 (deployment-vercel 메모리 — 세션 DDL 불가)
create table if not exists public.g1a_days (
  date date not null,                   -- 판정일 (저녁 D — 라벨 대상 갭은 D+1 시가)
  symbol text not null,                 -- 005930 | 000660
  t1_snapshot jsonb,                    -- 15:10 기록 전용 스냅샷 (§7)
  t2 jsonb,                             -- 트리거·판정·평가 궤적·반전 감시·리포트 텍스트 (§10)
  labels jsonb,                         -- { L1p, L1, L2, L3, capture_ratio } — D+1 기입
  outcome jsonb,                        -- { hit, luck_flag, postmortem }
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (date, symbol)
);
alter table public.g1a_days enable row level security;
drop policy if exists "authenticated read g1a days" on public.g1a_days;
create policy "authenticated read g1a days" on public.g1a_days
  for select using (auth.role() = 'authenticated');

create index if not exists g1a_days_date_idx on public.g1a_days (date desc);
