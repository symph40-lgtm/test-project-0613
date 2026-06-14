-- 보유 종목 테이블
create table public.positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  ticker      text not null,
  name        text,
  weight      numeric(5,2) not null check (weight >= 0 and weight <= 200),
  is_leverage boolean not null default false,
  sector      text,
  pnl         numeric(6,2),
  risk_level  text check (risk_level in ('취약', '주의', '안정')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, ticker)
);

-- updated_at 자동 갱신 트리거 (handle_updated_at 함수는 002_applications.sql에서 이미 생성됨)
create trigger positions_updated_at
  before update on public.positions
  for each row execute function public.handle_updated_at();

-- RLS 활성화
alter table public.positions enable row level security;

create policy "users can select own positions"
  on public.positions for select
  using (auth.uid() = user_id);

create policy "users can insert own positions"
  on public.positions for insert
  with check (auth.uid() = user_id);

create policy "users can update own positions"
  on public.positions for update
  using (auth.uid() = user_id);

create policy "users can delete own positions"
  on public.positions for delete
  using (auth.uid() = user_id);
