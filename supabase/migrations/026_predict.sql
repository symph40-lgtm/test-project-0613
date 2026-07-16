-- 2026-07-16 대가 방법론 예측 모델 (docs/predict-models-spec.md)
-- 기존 signal_*와 분리된 독립 시스템. 쓰기는 service role 전용(쓰기 정책 없음), 읽기는 로그인 사용자.

-- 모델별 일일 판정·채점
create table if not exists public.predict_model_days (
  date date not null,
  model text not null,             -- crabel | raschke | fisher | dalton | grimes
  verdict text not null,           -- leverage | inverse | none
  confidence real,
  reason text,
  label text,                      -- 장 마감 후 실제 추세 (채점 시 기록)
  correct boolean,
  source text not null default 'live',  -- live | backtest | backfill
  judged_at timestamptz not null default now(),
  primary key (date, model)
);
alter table public.predict_model_days enable row level security;
drop policy if exists "authenticated read predict model days" on public.predict_model_days;
create policy "authenticated read predict model days" on public.predict_model_days
  for select using (auth.role() = 'authenticated');

-- 일일 최종 판정 (판정 모드에 따라 피셔 단독 또는 앙상블)
-- 2단계 판정 (2026-07-16): 조기 09:31(08:00 NXT 프리마켓 포함 창) → 10:31 확정(09:00 창).
-- 조기~확정 사이 판정 변경은 revisions에 누적 (모니터링).
create table if not exists public.predict_days (
  date date primary key,
  label text,                      -- 장 마감 후 확정
  r_oc real,                       -- 당일 시가→종가 %
  final_verdict text not null,     -- stage='early' 동안은 잠정값, 10:31 확정값으로 갱신
  strength real not null,          -- 판정 강도 %
  stage text not null default 'final',  -- early | final
  early_verdict text,              -- 09:31 조기 판정 (보존 — 확정과 별도 채점용)
  early_strength real,
  early_at timestamptz,
  revisions jsonb,                 -- [{at, verdict, strength}] 조기~확정 구간 변경 로그
  weights jsonb,                   -- 판정 시점의 모델별 가중치(평활 정확도)
  model_verdicts jsonb,            -- 모델별 판정 스냅샷 (+_ensemble 참고)
  source text not null default 'live',
  labeled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.predict_days enable row level security;
drop policy if exists "authenticated read predict days" on public.predict_days;
create policy "authenticated read predict days" on public.predict_days
  for select using (auth.role() = 'authenticated');
