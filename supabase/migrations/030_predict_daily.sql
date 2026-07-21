-- 2026-07-21 일봉 스윙 예측 (docs/predict-daily-spec.md)
-- 기존 signal_*·predict_*와 분리된 독립 시스템. 쓰기는 service role 전용, 읽기는 로그인 사용자.
-- 미너비니 판정(3일 호라이즌) + 10Y 급등 게이트 + 이벤트 감산. 채점은 r1(익일)·r3(3일).

create table if not exists public.predict_daily_days (
  date date not null,
  symbol text not null,                -- 005930 | 000660
  stance text not null,                -- long(매수) | short(회피) | flat(중립)
  exposure real not null,              -- 주식화 비율 0~1 (게이트 반영 후)
  base_exposure real not null,         -- 게이트 전 (이진: 1 또는 0)
  model_stances jsonb,                 -- 7모델 스냅샷 (대조군 채점용)
  macro jsonb,                         -- {sox, fxLevel, fxChg, y10, y10Chg} 판정 시점 값
  flow jsonb,                          -- 최근 외인·기관 수급 확정치 (표시용 — 게이트 아님, 실측 기각)
  gates jsonb,                         -- 적용 감산 사유 ["10Y급등(+0.09%p)", "이벤트:FOMC"]
  event text,
  stop_px real,                        -- 손절가 (-8%, 매수 시)
  close_px real,                       -- 판정 시 종가
  revisions jsonb,                     -- [{at, stance, exposure}] 판정 창 내 변경 로그
  label_r1 real,                       -- 익일 종가 수익 % (채점)
  label_r3 real,                       -- 3일 후 종가 수익 % (주 채점 — 스펙 5-3)
  correct1 boolean,
  correct3 boolean,
  source text not null default 'live', -- live | backfill
  judged_at timestamptz,
  labeled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (date, symbol)
);

alter table public.predict_daily_days enable row level security;
drop policy if exists "authenticated read predict daily days" on public.predict_daily_days;
create policy "authenticated read predict daily days" on public.predict_daily_days
  for select using (auth.role() = 'authenticated');
