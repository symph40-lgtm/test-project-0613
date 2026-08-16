-- 2026-08-15 MT지수 (시장 톤/에너지) 로그 — specs/SPEC_MT_v04.md §7
-- 1단계는 표시 전용(판정 무개입). 라벨은 D+5 이후 소급 기입.
-- ⚠ 적용은 Supabase SQL Editor에서 수동 (deployment-vercel 메모리 — 세션 DDL 불가)
create table if not exists public.mt_days (
  date date not null,                   -- 산출일 (그날 종가까지만 보고 계산 — 룩어헤드 차단)
  symbol text not null,                 -- KOSPI200 | 005930 | 000660
  phase jsonb,                          -- {P:{S1..S4}, top, inputs}
  panels jsonb,                         -- {S1..S4: {parts[{key,fill,detail,available}], vote, threshold, candidate, fillAvg}}
  common jsonb,                         -- 상시 부품 C1~C7 + c4_source
  box jsonb,                            -- {n20, n60, primary, positionPct}
  tone jsonb,                           -- {mt, direction, strength, byPhase}
  transition jsonb,                     -- {candidate, confirmed, from, to, priceConfirm, reverseLog, votesAdjust}
  labels jsonb,                         -- {dir5d, gate, resilience} — 소급 기입
  meta jsonb,                           -- {engine_ver, mode, missing[]}
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (date, symbol)
);

-- 파라미터 계층 (§4.2 월간 재캘리브레이션) — 부품 가중·IC 이력·섀도 병행분·부품 쌍 상관
create table if not exists public.mt_state (
  symbol text primary key,
  state jsonb not null,                 -- {weights, ic_history, shadow, pair_corr, c1_misclass, updated_for}
  updated_at timestamptz not null default now()
);

alter table public.mt_days enable row level security;
alter table public.mt_state enable row level security;
drop policy if exists "auth read mt days" on public.mt_days;
create policy "auth read mt days" on public.mt_days for select using (auth.role() = 'authenticated');
drop policy if exists "auth read mt state" on public.mt_state;
create policy "auth read mt state" on public.mt_state for select using (auth.role() = 'authenticated');

create index if not exists mt_days_date_idx on public.mt_days (date desc);
