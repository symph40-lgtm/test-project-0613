-- 위험선 설정 테이블 (사용자별 트리거 조건 on/off)
create table public.risk_lines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  trigger_key text not null check (trigger_key in ('low', 'drop5', 'futures', 'rebound')),
  is_on       boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, trigger_key)
);

alter table public.risk_lines enable row level security;

create policy "users can select own risk_lines"
  on public.risk_lines for select
  using (auth.uid() = user_id);

create policy "users can insert own risk_lines"
  on public.risk_lines for insert
  with check (auth.uid() = user_id);

create policy "users can update own risk_lines"
  on public.risk_lines for update
  using (auth.uid() = user_id);

create policy "users can delete own risk_lines"
  on public.risk_lines for delete
  using (auth.uid() = user_id);
