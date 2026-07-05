-- 미국 2년물 금리 급등락 알람 (docs/rate-alert.md)
-- 금리 샘플 시계열 — 크론(10분 간격)마다 1행. 30분/1시간 변동은 샘플 간 차이로 계산.
create table public.rate_samples (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),  -- 수집 시각
  y2         double precision,                    -- 미국 2년물 금리 (%)
  y10        double precision,                    -- 미국 10년물 금리 (%)
  traded_at  timestamptz,                         -- 소스의 마지막 체결 시각 (지연 판단용)
  created_at timestamptz not null default now()
);
create index rate_samples_ts on public.rate_samples (ts desc);

-- 시장 데이터는 사용자 공용 — 읽기는 로그인 사용자, 쓰기는 service role 전용 (signal_ticks와 동일)
alter table public.rate_samples enable row level security;
create policy "authenticated can select rate_samples"
  on public.rate_samples for select
  to authenticated
  using (true);

-- 알림 이력·중복 방지에 기존 alerts 테이블 재사용 — trigger_key 'rate' 허용
alter table public.alerts drop constraint alerts_trigger_key_check;
alter table public.alerts add constraint alerts_trigger_key_check check (trigger_key in (
  'low', 'drop5', 'futures', 'rebound',
  'intraday_summary', 'approval', 'signal', 'rate'
));
