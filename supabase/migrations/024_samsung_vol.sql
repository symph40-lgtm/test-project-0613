-- 2026-07-15 삼성전자 누적 거래량 컬럼 (사용자 지정) — 장중브리핑에 하닉·삼전 거래량
-- 급증/급감을 포함하기 위해 (개별 거래량 문자는 중단, 브리핑 본문으로 대체).
-- 미적용이어도 코드가 컬럼을 자동 제외하고 동작한다 (삼전 거래량만 '?' 표기).
alter table public.signal_ticks add column if not exists samsung_vol double precision;
