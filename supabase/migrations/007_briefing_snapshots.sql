-- 아침 브리핑 스냅샷 캐시 테이블 (날짜별 AI 판단 + 시장 데이터)
create table public.briefing_snapshots (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  date         date not null,
  market_data  jsonb,
  risk_scores  jsonb,
  risk_score   integer,
  stage        text,
  ai_output    jsonb,
  is_fallback  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, date)
);

create trigger briefing_snapshots_updated_at
  before update on public.briefing_snapshots
  for each row execute function public.handle_updated_at();

alter table public.briefing_snapshots enable row level security;

create policy "users can select own briefing_snapshots"
  on public.briefing_snapshots for select
  using (auth.uid() = user_id);

create policy "users can insert own briefing_snapshots"
  on public.briefing_snapshots for insert
  with check (auth.uid() = user_id);

create policy "users can update own briefing_snapshots"
  on public.briefing_snapshots for update
  using (auth.uid() = user_id);
