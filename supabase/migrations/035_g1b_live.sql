-- 2026-08-09 G1B 라이브 60일 log-only (WORKORDER_G1B_live_week4 / 정본 {스펙+A1})
-- g1b_days: 밤 단위 전체 로그 (수집·FairGap·R1/R2·라벨·절제) / g1b_state: 일간 학습 상태 계층
-- g1b_gate: 게이트 계기판 일일 집계 (D+15 판정 재료 자동 축적)
-- ⚠ Supabase SQL Editor 수동 적용
create table if not exists public.g1b_days (
  date date not null,                   -- 라벨 대상 KRX 거래일 (갭 판정일 아침)
  symbol text not null,
  night jsonb,                          -- 야간 배치 수집 (fetch_ts·late_arrival 포함)
  morning jsonb,                        -- 아침 배치 수집
  r1 jsonb,                             -- FairGap_R1·조정 지시(가상)·리포트 텍스트·sent_at
  r2 jsonb,                             -- FairGap_R2·잔차 판정·리포트 텍스트
  ablation jsonb,                       -- 층별 절제 + B1·B2 병행 기록
  labels jsonb,                         -- actual_open·translation_error 등 (09:30+ 소급)
  learn jsonb,                          -- 그날 학습 갱신 요약 (칼만·EWMA·Hedge·PIT·CUSUM)
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (date, symbol)
);
create table if not exists public.g1b_state (
  symbol text primary key,
  state jsonb not null,                 -- {kalman, sigma_ewma, bias, hedge_w, case_n, quantiles, ...}
  updated_at timestamptz not null default now()
);
create table if not exists public.g1b_gate (
  date date primary key,
  metrics jsonb not null,               -- 가동률·오차 롤링·절단 위반·PIT·결측 일지·가상 경보
  created_at timestamptz not null default now()
);
alter table public.g1b_days enable row level security;
alter table public.g1b_state enable row level security;
alter table public.g1b_gate enable row level security;
drop policy if exists "auth read g1b days" on public.g1b_days;
create policy "auth read g1b days" on public.g1b_days for select using (auth.role() = 'authenticated');
drop policy if exists "auth read g1b state" on public.g1b_state;
create policy "auth read g1b state" on public.g1b_state for select using (auth.role() = 'authenticated');
drop policy if exists "auth read g1b gate" on public.g1b_gate;
create policy "auth read g1b gate" on public.g1b_gate for select using (auth.role() = 'authenticated');
create index if not exists g1b_days_date_idx on public.g1b_days (date desc);
