-- 2026-07-16 운영 설정·지시 (사용자 지정) — 모바일에서 문자 정책 등을 직접 제어/지시.
-- ops_settings: 즉시 적용되는 운영 설정 (문자 일시정지 등 — 서버가 60초 캐시로 읽음)
-- ops_directives: 자유 지시 저장함 — 다음 Claude 작업 세션에서 읽고 코드에 반영
create table if not exists public.ops_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.ops_settings enable row level security;
drop policy if exists "authenticated read ops settings" on public.ops_settings;
create policy "authenticated read ops settings" on public.ops_settings
  for select using (auth.role() = 'authenticated');

create table if not exists public.ops_directives (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  status text not null default 'pending',  -- pending | applied | rejected
  note text
);
alter table public.ops_directives enable row level security;
drop policy if exists "own directives select" on public.ops_directives;
create policy "own directives select" on public.ops_directives
  for select using (auth.uid() = user_id);
drop policy if exists "own directives insert" on public.ops_directives;
create policy "own directives insert" on public.ops_directives
  for insert with check (auth.uid() = user_id);
