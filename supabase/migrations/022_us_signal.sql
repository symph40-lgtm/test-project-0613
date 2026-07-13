-- 2026-07-13 미국 반도체 레버리지/인버스 신호 (사용자 지정) — ProShares USD(2x)·SSG(-2x)를
-- 한국 M7과 같은 방식으로 판정. 기준 지수는 SMH (실측: USD와 상관 0.955·β 2.04 — 후보 중 최고.
-- ^SOX 0.928·SOXX 0.905). 미국 정규장(09:30~16:00 ET = 한국 야간) 1분 폴링 틱 시계열.
create table if not exists public.us_signal_ticks (
  id bigint generated always as identity primary key,
  date date not null,                -- ET 거래일
  ts timestamptz not null,
  minute_of_day integer not null,    -- 가상 KST 분 매핑 (개장 09:30 ET = 540) — 한국 엔진 재사용용
  smh_px double precision,           -- 기준 지수 (VanEck 반도체 ETF)
  smh_chg double precision,          -- 전일 종가 대비 %
  usd_px double precision,           -- ProShares Ultra Semiconductors (2x)
  usd_chg double precision,
  ssg_chg double precision,          -- ProShares UltraShort Semiconductors (-2x)
  sox_chg double precision,          -- 참고 (필라델피아 반도체 지수)
  nq_chg double precision,           -- 나스닥 선물
  us10y_px double precision,         -- 미 10년물 금리 레벨 (%)
  us10y_chg_pp double precision,     -- 전일 대비 %p
  dxy_chg double precision,          -- 달러지수 %
  wti_chg double precision,          -- WTI %
  vix_px double precision,           -- VIX 레벨
  vix_chg double precision           -- VIX 전일 %
);
create index if not exists us_signal_ticks_date_idx on public.us_signal_ticks (date, ts);

alter table public.us_signal_ticks enable row level security;
drop policy if exists "authenticated read us ticks" on public.us_signal_ticks;
create policy "authenticated read us ticks" on public.us_signal_ticks
  for select using (auth.role() = 'authenticated');
