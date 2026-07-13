-- 2026-07-13 보유 매매 판단 캘리브레이션 (사용자 지정) — 매일 15:40 EOD에 종목별 스탠스를
-- 스냅샷으로 저장하고, 다음 거래일 EOD에 그날 수익률(next_day_pct)을 채워 "판정 vs 실제"를
-- 자동 대조한다. 리포트: npx tsx scripts/stance-error-report.ts
create table if not exists public.stance_snapshots (
  id bigint generated always as identity primary key,
  date date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  ticker text not null,
  stance smallint not null,          -- 1~10 (10=적극매수)
  score integer not null,            -- 내부 점수
  tone text not null,                -- buy/hold/sell
  day_change_pct double precision,   -- 스냅샷 시점(=그날 마감) 당일 등락 %
  market_drop_pct double precision,  -- 당일 시장 최악 신호 %
  composite integer,                 -- 장세 종합 리스크 (0~100)
  reason text,
  factors jsonb,                     -- 요인별 점수 분해 (캘리브레이션용)
  next_day_pct double precision,     -- 다음 거래일 등락 % (다음날 EOD 백필)
  created_at timestamptz not null default now(),
  unique (date, user_id, ticker)
);

alter table public.stance_snapshots enable row level security;
drop policy if exists "own stance snapshots" on public.stance_snapshots;
create policy "own stance snapshots" on public.stance_snapshots
  for select using (auth.uid() = user_id);
