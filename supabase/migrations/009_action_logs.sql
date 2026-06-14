-- 행동 기록 테이블 (날짜·종목별 안내·행동·결과 저장)
create table public.action_logs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users on delete cascade,
  date                  date not null,
  ticker                text,
  briefing_snapshot_id  uuid references public.briefing_snapshots(id) on delete set null,
  guidance_action       text,
  guidance_prohibition  text,
  actual_action         text not null check (actual_action in (
                          '축소', '유지', '추가매수', '전량매도', '기타'
                        )),
  follow_level          text not null check (follow_level in (
                          '따름', '일부 따름', '따르지 않음'
                        )),
  reason                text,
  result_day0           numeric,
  result_day1           numeric,
  result_day3           numeric,
  result_week1          numeric,
  stage                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger action_logs_updated_at
  before update on public.action_logs
  for each row execute function public.handle_updated_at();

alter table public.action_logs enable row level security;

create policy "users can select own action logs"
  on public.action_logs for select
  using (auth.uid() = user_id);

create policy "users can insert own action logs"
  on public.action_logs for insert
  with check (auth.uid() = user_id);

create policy "users can update own action logs"
  on public.action_logs for update
  using (auth.uid() = user_id);

create policy "users can delete own action logs"
  on public.action_logs for delete
  using (auth.uid() = user_id);
