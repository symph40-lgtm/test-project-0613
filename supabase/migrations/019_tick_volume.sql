-- 하닉 누적 거래량 컬럼 — 거래량 급증 알람용 (docs 미보유: config.volumeAlert, 사용자 지정 2026-07-08)
-- 5분봉 거래량 = 연속 틱의 누적 거래량 차. 미적용이어도 코드가 폴백으로 동작(거래량 알람만 비활성).
alter table public.signal_ticks add column if not exists hynix_vol double precision;
