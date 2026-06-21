-- 전문가 Q&A 기록 — ChatGPT(OpenAI)·Claude 답변을 저장하고, 시황 해설에 참고로 주입
create table public.ai_consults (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  question      text not null,
  claude_answer text,
  openai_answer text,
  claude_model  text,
  openai_model  text,
  -- true면 이후 시황 해설/컨설팅 생성 시 '참고 자료'로 주입
  reflect       boolean not null default true,
  created_at    timestamptz not null default now()
);

alter table public.ai_consults enable row level security;

create policy "users can select own ai_consults"
  on public.ai_consults for select
  using (auth.uid() = user_id);

create policy "users can insert own ai_consults"
  on public.ai_consults for insert
  with check (auth.uid() = user_id);

create policy "users can update own ai_consults"
  on public.ai_consults for update
  using (auth.uid() = user_id);

create policy "users can delete own ai_consults"
  on public.ai_consults for delete
  using (auth.uid() = user_id);

create index ai_consults_user_created
  on public.ai_consults (user_id, created_at desc);
