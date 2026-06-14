-- 이용 신청 테이블
create table public.applications (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  name            text not null,
  phone           text,
  experience      text,
  motivation      text,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- updated_at 자동 갱신 트리거 함수
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger applications_updated_at
  before update on public.applications
  for each row execute function public.handle_updated_at();

-- RLS 활성화
alter table public.applications enable row level security;

-- anon/authenticated 누구나 insert 가능 (신청)
create policy "anyone can insert applications"
  on public.applications
  for insert
  with check (true);

-- 인증된 사용자는 자신의 신청 조회 가능, admin은 전체 조회
create policy "users can view own application"
  on public.applications
  for select
  using (
    email = (auth.jwt() ->> 'email')
    or exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role = 'admin'
    )
  );

-- admin만 update 가능
create policy "admin can update applications"
  on public.applications
  for update
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role = 'admin'
    )
  );
