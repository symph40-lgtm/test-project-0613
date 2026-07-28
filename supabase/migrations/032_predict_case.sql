-- 일봉 정성 사례 메모리 1단계 (docs/predict-daily-case-memory.md, 사용자 승인 2026-07-28
-- "1단계 적용 범위를 일봉(predict-daily) 문자로 한정"). 표시 전용 — 판정·비중 불변.
-- 하루 1행(시장 단위): 정량 특징 + AI 원인 요약(가동일부터) + 익일 채점.

create table if not exists public.predict_case_days (
  date date primary key,
  features jsonb not null,             -- {ssGap, ssChg, hxGap, hxChg, sox, fxChg, y10pp, dxyChg, envScore}
  cause_text text,                     -- AI 당일 등락 원인 요약 (백필 불가 — 가동일부터 축적)
  cause_tags text[],                   -- 정형 태그 (금리·환율·실적·수급·미국반도체·지정학·관세무역·이벤트경계·기술적·기타)
  next_ss real,                        -- 익일 삼전 종가수익 % (채점 — 다음 거래일 이후 기입)
  next_hx real,                        -- 익일 하닉 종가수익 %
  source text not null default 'live', -- live | backfill
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.predict_case_days enable row level security;
drop policy if exists "authenticated read predict case days" on public.predict_case_days;
create policy "authenticated read predict case days" on public.predict_case_days
  for select using (auth.role() = 'authenticated');
