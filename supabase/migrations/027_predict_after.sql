-- 2026-07-20 애프터장 판정 (사용자 지정) — NXT 애프터마켓 15:30~20:00, 하닉 본주 전용.
-- 정규장(predict_days)과 분리 저장 — 라벨 스케일(±0.6%)이 달라 채점 오염 방지.
create table if not exists public.predict_after_days (
  date date primary key,
  final_verdict text not null default 'none',
  strength real not null default 50,
  stage text not null default 'open',   -- open | final(19:30 확정)
  revisions jsonb,                      -- [{at, checkpoint?, verdict, strength}] 타임라인
  label text,                           -- 세션 시가→종가 ±0.6% + 종가 위치 (20:05 이후 채점)
  r_oc real,
  labeled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.predict_after_days enable row level security;
drop policy if exists "authenticated read predict after days" on public.predict_after_days;
create policy "authenticated read predict after days" on public.predict_after_days
  for select using (auth.role() = 'authenticated');
