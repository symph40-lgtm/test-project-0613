-- 사용자 역할 테이블
create table public.user_roles (
  user_id    uuid primary key references auth.users on delete cascade,
  role       text not null check (role in ('admin', 'user')),
  created_at timestamptz default now()
);

-- RLS 활성화
alter table public.user_roles enable row level security;

-- 본인 role 조회 가능
create policy "users can view own role"
  on public.user_roles
  for select
  using (user_id = auth.uid());

-- insert/update는 service role(bypass RLS)만 가능 — 일반 RLS로는 차단
create policy "service role only insert"
  on public.user_roles
  for insert
  with check (false);

create policy "service role only update"
  on public.user_roles
  for update
  using (false);

-- 신규 사용자 초대 수락 시 user_roles에 자동 등록하는 트리거
-- (service definer로 실행 → RLS 우회)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_roles (user_id, role)
  values (new.id, 'user')
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
