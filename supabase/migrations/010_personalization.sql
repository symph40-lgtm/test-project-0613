-- 개인화 설정 테이블 (ON/OFF + 기록 제외 목록)
create table public.personalization_settings (
  user_id                  uuid primary key references auth.users on delete cascade,
  personalization_enabled  boolean not null default true,
  excluded_log_ids         uuid[] not null default '{}',
  updated_at               timestamptz not null default now()
);

create trigger personalization_settings_updated_at
  before update on public.personalization_settings
  for each row execute function public.handle_updated_at();

alter table public.personalization_settings enable row level security;

create policy "users can select own personalization settings"
  on public.personalization_settings for select
  using (auth.uid() = user_id);

create policy "users can insert own personalization settings"
  on public.personalization_settings for insert
  with check (auth.uid() = user_id);

create policy "users can update own personalization settings"
  on public.personalization_settings for update
  using (auth.uid() = user_id);

-- 내일 아침 다시 보기 예약 테이블
create table public.briefing_bookmarks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  scheduled_date  date not null,
  created_at      timestamptz not null default now(),
  unique (user_id, scheduled_date)
);

alter table public.briefing_bookmarks enable row level security;

create policy "users can select own briefing bookmarks"
  on public.briefing_bookmarks for select
  using (auth.uid() = user_id);

create policy "users can insert own briefing bookmarks"
  on public.briefing_bookmarks for insert
  with check (auth.uid() = user_id);

create policy "users can delete own briefing bookmarks"
  on public.briefing_bookmarks for delete
  using (auth.uid() = user_id);
