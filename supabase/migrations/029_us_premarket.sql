-- 2026-07-21 미장 프리장(프리마켓) 판정 (사용자 지정) — 한국 애프터장 판정의 미국판.
-- SMH 프리마켓(07:00~09:30 ET) 피셔 판정으로 정규장 방향을 선판정, 정규장 마감 후 채점.
-- 채점은 백테스트와 동일 기준: 정규장 시가→종가 부호 적중 + 스탑(-1.5% SMH) 적용 손익.
create table if not exists public.us_premarket_days (
  date date primary key,                -- ET 거래일
  final_verdict text not null default 'none',  -- leverage(USD) | inverse(SSG) | none
  strength real not null default 50,
  stage text not null default 'open',   -- open | final(09:25 ET 확정)
  revisions jsonb,                      -- [{at, checkpoint?, verdict, strength}] 타임라인
  r_oc real,                            -- 정규장 시가→종가 % (채점 시)
  hit boolean,                          -- 방향 판정의 부호 적중 (none 판정은 null)
  pnl_stop real,                        -- 스탑 적용 손익 %p (SMH 기준, 방향 없으면 0)
  labeled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.us_premarket_days enable row level security;
drop policy if exists "authenticated read us premarket days" on public.us_premarket_days;
create policy "authenticated read us premarket days" on public.us_premarket_days
  for select using (auth.role() = 'authenticated');
