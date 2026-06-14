-- 개인 매매 원칙 테이블
create table public.principles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  principle_key text not null check (principle_key in ('lev', 'avg', 'loan', 'gap')),
  is_on         boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (user_id, principle_key)
);

alter table public.principles enable row level security;

create policy "users can select own principles"
  on public.principles for select
  using (auth.uid() = user_id);

create policy "users can insert own principles"
  on public.principles for insert
  with check (auth.uid() = user_id);

create policy "users can update own principles"
  on public.principles for update
  using (auth.uid() = user_id);

create policy "users can delete own principles"
  on public.principles for delete
  using (auth.uid() = user_id);
