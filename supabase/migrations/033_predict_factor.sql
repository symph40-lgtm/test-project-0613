-- 2026-08-08 정성·정량 팩터 일일 스냅샷 (docs/factor-quant-plan.md Phase 0)
-- 목적: 지금까지 '계산만 하고 버리던' 팩터들을 매일 한 행으로 남겨 60일 뒤 리프트 검정을 가능하게 한다.
--   현재 political score(0~100)·축1 C3~C9 방향/강도는 화면에서 계산 후 소멸 → 검증이 시작조차 못 함.
-- 채점 라벨(t0_gap·t1_roc·t2_rcc·t3_r3)은 다음 거래일 이후 소급 기입 (predict_daily_days와 동일 사상).
create table if not exists public.predict_factor_days (
  date date not null,
  symbol text not null,                 -- 005930 | 000660 (공통 팩터도 종목별로 라벨이 다르므로 종목 단위 저장)
  factors jsonb not null,               -- { code: {v: 원값, dir: -1|0|1, str: 0~3, src: "yahoo"|"fred"|"ai"|... } }
  scores jsonb,                         -- 정성 AI 산출 { political: 0~100, politicalDir, newsRisk: 0~10, drivers: [] }
  -- 채점 라벨 (기획 1장 T0~T3)
  t0_gap real,                          -- 익일 시가 갭 %
  t1_roc real,                          -- 익일 시가→종가 %
  t2_rcc real,                          -- 당일 종가→익일 종가 %
  t3_r3 real,                           -- 3거래일 후 종가 %
  source text not null default 'live',  -- live | backfill
  created_at timestamptz not null default now(),
  labeled_at timestamptz,
  primary key (date, symbol)
);
alter table public.predict_factor_days enable row level security;
drop policy if exists "authenticated read factor days" on public.predict_factor_days;
create policy "authenticated read factor days" on public.predict_factor_days
  for select using (auth.role() = 'authenticated');

create index if not exists predict_factor_days_date_idx on public.predict_factor_days (date desc);
