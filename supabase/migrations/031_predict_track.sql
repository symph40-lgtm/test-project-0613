-- 2026-07-25 다세션·다모델 피셔 페이퍼 트래킹 (ops 지시: "피셔W·본피셔를 삼전·SOXX에 적용,
-- 판정을 프리장·정규장·애프터장에도 적용") — 문자 없음, 기록·채점 전용.
-- 용도: ①삼전(005930) 프리장 피셔F / 정규장 본피셔·피셔W / 애프터장 피셔 ②SOXX 정규장 피셔W 섀도.
-- 근거 실측(2026-07-25, 224일): 삼전 피셔W 3분류 67.0%(방향 63.4%) > 본피셔 63.4%(57.4%) —
-- 하닉과 반대 양상이라 라이브 재현 검증 필요. SOXX 0.25는 39일 소표본 100%(25회).
create table if not exists public.predict_track_days (
  date date not null,                    -- KR: KST 거래일 / US: ET 거래일
  symbol text not null,                  -- '005930' | 'SOXX'
  session text not null,                 -- 'pre' | 'reg' | 'after'
  model text not null,                   -- 'fisherf' | 'fisher' | 'fisherw'
  verdict text not null default 'none',  -- leverage | inverse | none
  strength real,
  entry_px double precision,             -- 판정 컷 시점 가격 (손익 추적 기준)
  label text,                            -- pre·reg: 일봉 라벨(±1.2%/±0.9%) / after: 애프터 라벨(±0.6%)
  r_oc real,
  ret_pct real,                          -- 방향 판정 시 컷 진입→세션 종가 % (본주/지수 기준)
  source text not null default 'live',   -- live | backfill | backtest(시딩)
  labeled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (date, symbol, session, model)
);
alter table public.predict_track_days enable row level security;
drop policy if exists "authenticated read predict track days" on public.predict_track_days;
create policy "authenticated read predict track days" on public.predict_track_days
  for select using (auth.role() = 'authenticated');
