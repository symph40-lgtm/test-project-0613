-- 2026-07-13 미국 신호 TV(거래량 확인) 신호 (사용자 지정) — SMH 당일 누적 거래량 컬럼.
-- 미국엔 한국식 수급(T4·T5·T8) 데이터가 없어, '가격 방향 + 거래량 동반'을 수급 대체 신호로 사용.
-- 미적용이어도 코드가 컬럼을 자동 제외하고 동작한다 (TV 신호만 미산출).
alter table public.us_signal_ticks add column if not exists smh_vol double precision;
