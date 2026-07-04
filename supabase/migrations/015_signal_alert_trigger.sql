-- M7 신호 시스템 SMS 알림 — alerts.trigger_key에 'signal' 허용 (알림 이력·중복 방지에 기존 테이블 재사용)
alter table public.alerts drop constraint alerts_trigger_key_check;
alter table public.alerts add constraint alerts_trigger_key_check check (trigger_key in (
  'low', 'drop5', 'futures', 'rebound',
  'intraday_summary', 'approval', 'signal'
));
