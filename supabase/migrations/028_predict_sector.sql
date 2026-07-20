-- 2026-07-20 섹터 ETF 후보 페이퍼 트래킹 (사용자 지정) — 방산(449450)·조선(466920).
-- 10:30 피셔 판정(09:00 창)을 매일 기록·채점 + 진입→종가 손익 누적. 문자 없음(페이지 표시만).
-- 목적: 백테스트(방산 +29.0%p·조선 +2.4%p)의 라이브 재현 여부 확인 후 실투자 편입 결정.
create table if not exists public.predict_sector_days (
  date date not null,
  symbol text not null,
  verdict text not null,           -- leverage | inverse | none (10:30 피셔)
  strength real,
  entry_px real,                   -- 판정 시점(10:29 종가) — 손익 계산 기준
  label text,                      -- 당일 라벨 (±1.2% + 종가 위치)
  r_oc real,
  ret_pct real,                    -- 진입→종가 % (방향 부호 반영, 방향 판정일만)
  source text not null default 'live',  -- live | backtest(시딩)
  judged_at timestamptz not null default now(),
  labeled_at timestamptz,
  primary key (date, symbol)
);
alter table public.predict_sector_days enable row level security;
drop policy if exists "authenticated read predict sector days" on public.predict_sector_days;
create policy "authenticated read predict sector days" on public.predict_sector_days
  for select using (auth.role() = 'authenticated');
