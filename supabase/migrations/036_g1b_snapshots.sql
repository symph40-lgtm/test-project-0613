-- 2026-08-09 G1B 상태 스냅샷 (발주자 드라이런 추가 요건 §3)
-- 일 1회 버전 태그 보관 — G1-OPT 롤백이 pack(파라미터)만이 아니라 상태까지 복원 가능하게.
-- ⚠ Supabase SQL Editor 수동 적용 (035와 별도 — 035를 이미 적용했어도 이것만 추가 실행)
create table if not exists public.g1b_state_snapshots (
  date date not null,
  symbol text not null,
  state jsonb not null,
  pack_ref text not null default 'pack_v1.0',
  state_hash text,                      -- SHA-256 (복구 훈련 대조용)
  created_at timestamptz not null default now(),
  primary key (date, symbol)
);
alter table public.g1b_state_snapshots enable row level security;
drop policy if exists "auth read g1b snapshots" on public.g1b_state_snapshots;
create policy "auth read g1b snapshots" on public.g1b_state_snapshots for select using (auth.role() = 'authenticated');
