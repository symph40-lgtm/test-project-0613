-- 2026-07-21 미장 예측 스트림 (사용자 지정 — "국장과 동일 구조") — 프리장 user 모델 ·
-- 정규장 피셔, 한국 predict_days의 미국판. SMH 기준, 상방=USD(2x)·하방=SSG(-2x).
-- (당초 이 파일은 프리장 피셔 단독 판정용 us_premarket_days였으나 적용 전에 스트림 구조로
--  개정 — 사용자 2차 지시. 미적용 상태에서 교체라 번호 유지.)
create table if not exists public.us_predict_days (
  date date primary key,                -- ET 거래일
  final_verdict text not null default 'none',  -- leverage(USD) | inverse(SSG) | none
  strength real not null default 50,
  stage text not null default 'open',   -- open | final(14:30 ET 확정)
  revisions jsonb,                      -- [{at, checkpoint?, verdict, strength, judge}] 타임라인
  label text,                           -- 정규장 라벨 (±0.9% + 종가 위치 — SMH 스케일)
  r_oc real,                            -- 정규장 시가→종가 %
  hit boolean,                          -- 확정 판정의 부호 적중 (none 판정은 null)
  pnl_stop real,                        -- 첫 방향 체크포인트 진입 가정, 스탑(-1.5% SMH) 손익 %p
  labeled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.us_predict_days enable row level security;
drop policy if exists "authenticated read us predict days" on public.us_predict_days;
create policy "authenticated read us predict days" on public.us_predict_days
  for select using (auth.role() = 'authenticated');
