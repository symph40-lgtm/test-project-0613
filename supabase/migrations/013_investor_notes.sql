-- 투자 메모: 행동·투자 방향·주의할 점·깨달은 점 등 자유 형식 기록
create table public.investor_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  body       text not null,
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger investor_notes_updated_at
  before update on public.investor_notes
  for each row execute function public.handle_updated_at();

alter table public.investor_notes enable row level security;

create policy "users can select own investor_notes"
  on public.investor_notes for select using (auth.uid() = user_id);
create policy "users can insert own investor_notes"
  on public.investor_notes for insert with check (auth.uid() = user_id);
create policy "users can update own investor_notes"
  on public.investor_notes for update using (auth.uid() = user_id);
create policy "users can delete own investor_notes"
  on public.investor_notes for delete using (auth.uid() = user_id);

create index investor_notes_user_idx
  on public.investor_notes (user_id, pinned desc, updated_at desc);
